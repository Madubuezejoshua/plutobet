import { sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";
import type { WalletTransaction } from "../wallet/types";
import { hashBvn, hashNin } from "./identity";
import { putKycDocument, signedDocumentUrl, type KycDocumentKind } from "./storage";

/**
 * KYC verification and tier gating.
 *
 * Identity numbers reach this module in the clear and leave as digests — the
 * raw value is never persisted, never logged, and never returned. Documents
 * go to private object storage; only the key is stored.
 *
 * Tiers gate withdrawal limits (see payments/withdrawal.service.ts). They are
 * numbers rather than an enum because the ceilings attached to them are
 * policy that changes, and a migration to add TIER_4 would be worse than a
 * config change.
 */

export type KycTier = 0 | 1 | 2 | 3;

export class KycRejectedError extends Error {
  constructor(
    readonly reason: "IDENTITY_IN_USE" | "ALREADY_VERIFIED" | "IDENTITY_EXCLUDED",
    message: string,
  ) {
    super(message);
    this.name = "KycRejectedError";
  }
}

export class KycReviewError extends Error {
  constructor(
    readonly reason: "NOT_FOUND" | "ALREADY_REVIEWED",
    message: string,
  ) {
    super(message);
    this.name = "KycReviewError";
  }
}

export interface PendingKycReview {
  id: string;
  userId: string;
  email: string;
  createdAt: Date;
}

export interface VerifyIdentityParams {
  userId: string;
  bvn?: string;
  nin?: string;
  provider: "DOJAH" | "PAYSTACK" | "MANUAL";
  providerRef?: string;
  /** Tier granted by this verification. */
  level: KycTier;
}

export class KycService {
  constructor(private readonly wallet: WalletService = walletService) {}

  /**
   * Records a verified identity and raises the account's tier.
   *
   * The digest is computed here and the raw number is discarded immediately —
   * it never becomes a column, a log line, or a return value.
   *
   * Two refusals matter more than the happy path:
   *
   *  - An identity already attached to another account is multi-accounting,
   *    which is how bonus abuse and self-exclusion evasion both work.
   *  - An identity on the exclusion register cannot verify at all. Without
   *    this check a self-excluded person could register a fresh account and
   *    KYC it with the same BVN, and the placement-time check would then be
   *    the only thing standing in their way.
   */
  async verifyIdentity(params: VerifyIdentityParams): Promise<{ kycRecordId: string }> {
    if (!params.bvn && !params.nin) {
      throw new RangeError("verification requires a BVN or a NIN");
    }

    const bvnHash = params.bvn ? hashBvn(params.bvn) : null;
    const ninHash = params.nin ? hashNin(params.nin) : null;

    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      await this.assertIdentityNotExcluded(tx, [bvnHash, ninHash]);
      await this.assertIdentityUnused(tx, params.userId, bvnHash, ninHash);

      const [record] = await tx.execute<{ id: string }>(sql`
        INSERT INTO kyc_records (user_id, level, bvn_hash, nin_hash, provider, provider_ref, verified_at, status)
        VALUES (
          ${params.userId}::uuid,
          ${params.level},
          ${bvnHash},
          ${ninHash},
          ${params.provider}::kyc_provider,
          ${params.providerRef ?? null},
          now(),
          'APPROVED'
        )
        RETURNING id
      `);
      if (!record) throw new Error("kyc record insert returned no row");

      // The tier on the user row is the one every gate reads. It only ever
      // moves up here: a later, lower-tier verification must not silently
      // demote an account that already cleared a higher bar.
      await tx.execute(sql`
        UPDATE users
        SET kyc_level = GREATEST(kyc_level, ${params.level}), updated_at = now()
        WHERE id = ${params.userId}::uuid
      `);

      return { kycRecordId: record.id };
    });
  }

  /**
   * Uploads a supporting document and attaches its key to the user's record.
   *
   * The bytes go to private storage; the database only ever holds the key.
   */
  async attachDocument(params: {
    userId: string;
    kind: KycDocumentKind;
    contentType: string;
    body: Uint8Array;
  }): Promise<{ documentKey: string }> {
    const stored = await putKycDocument(params);

    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        INSERT INTO kyc_records (user_id, level, document_key, provider, status)
        VALUES (${params.userId}::uuid, 0, ${stored.key}, 'MANUAL'::kyc_provider, 'PENDING')
      `);
    });

    return { documentKey: stored.key };
  }

  /** Uploaded documents nobody has reviewed yet, oldest first. */
  async listPendingReviews(): Promise<PendingKycReview[]> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const rows = await tx.execute<{
        id: string;
        user_id: string;
        email: string;
        created_at: Date;
      }>(sql`
        SELECT r.id, r.user_id, u.email, r.created_at
        FROM kyc_records r
        JOIN users u ON u.id = r.user_id
        WHERE r.status = 'PENDING' AND r.document_key IS NOT NULL
        ORDER BY r.created_at ASC
      `);
      return rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        email: row.email,
        createdAt: new Date(row.created_at),
      }));
    });
  }

  /**
   * Admin decision on one uploaded document.
   *
   * Approving raises the account to `level` (never demotes, same as
   * verifyIdentity). Rejecting leaves the tier untouched — the account stays
   * at whatever it already had. Either way the update is guarded by
   * `status = 'PENDING'` so a review can only happen once; the trigger on
   * kyc_records makes a second attempt fail loudly instead of silently
   * overwriting the first reviewer's decision.
   */
  async reviewDocument(params: {
    kycRecordId: string;
    reviewerId: string;
    decision: "APPROVE" | "REJECT";
    level?: KycTier;
    note?: string;
  }): Promise<{ userId: string }> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const status = params.decision === "APPROVE" ? "APPROVED" : "REJECTED";
      const [row] = await tx.execute<{ user_id: string }>(sql`
        UPDATE kyc_records
        SET status = ${status}::kyc_review_status,
            reviewed_by = ${params.reviewerId}::uuid,
            reviewer_note = ${params.note ?? null},
            verified_at = CASE WHEN ${status} = 'APPROVED' THEN now() ELSE verified_at END
        WHERE id = ${params.kycRecordId}::uuid AND status = 'PENDING'
        RETURNING user_id
      `);
      if (!row) {
        const [existing] = await tx.execute<{ id: string }>(sql`
          SELECT id FROM kyc_records WHERE id = ${params.kycRecordId}::uuid
        `);
        throw existing
          ? new KycReviewError("ALREADY_REVIEWED", "this document has already been reviewed")
          : new KycReviewError("NOT_FOUND", "no such kyc record");
      }

      if (params.decision === "APPROVE") {
        const level = params.level ?? 2;
        await tx.execute(sql`
          UPDATE users SET kyc_level = GREATEST(kyc_level, ${level}), updated_at = now()
          WHERE id = ${row.user_id}::uuid
        `);
      }

      return { userId: row.user_id };
    });
  }

  /**
   * A short-lived link for a reviewer.
   *
   * Takes the key from OUR database rather than from the caller, so a request
   * cannot ask us to sign an arbitrary object.
   */
  async reviewUrlFor(kycRecordId: string): Promise<string | null> {
    const key = await this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [row] = await tx.execute<{ document_key: string | null }>(sql`
        SELECT document_key FROM kyc_records WHERE id = ${kycRecordId}::uuid
      `);
      return row?.document_key ?? null;
    });
    if (!key) return null;
    return signedDocumentUrl(key);
  }

  /** Highest tier this account has verified to. */
  async tierOf(userId: string): Promise<KycTier> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [row] = await tx.execute<{ kyc_level: number }>(sql`
        SELECT kyc_level FROM users WHERE id = ${userId}::uuid
      `);
      return (row?.kyc_level ?? 0) as KycTier;
    });
  }

  /** Everything the player-facing verification page needs in one read. */
  async statusFor(userId: string): Promise<{
    tier: KycTier;
    hasIdentity: boolean;
    document: { status: "PENDING" | "REJECTED"; note: string | null } | null;
  }> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [account] = await tx.execute<{ kyc_level: number }>(sql`
        SELECT kyc_level FROM users WHERE id = ${userId}::uuid
      `);
      const [identity] = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM kyc_records
        WHERE user_id = ${userId}::uuid AND (bvn_hash IS NOT NULL OR nin_hash IS NOT NULL)
      `);
      // Most recent document only: an old rejection should not keep blocking
      // the page once a new one has been submitted.
      const [document] = await tx.execute<{ status: "PENDING" | "REJECTED"; note: string | null }>(sql`
        SELECT status, reviewer_note AS note FROM kyc_records
        WHERE user_id = ${userId}::uuid AND document_key IS NOT NULL AND status <> 'APPROVED'
        ORDER BY created_at DESC LIMIT 1
      `);
      return {
        tier: (account?.kyc_level ?? 0) as KycTier,
        hasIdentity: Number(identity?.n ?? 0) > 0,
        document: document ?? null,
      };
    });
  }

  private async assertIdentityNotExcluded(
    tx: WalletTransaction,
    hashes: (string | null)[],
  ): Promise<void> {
    const present = hashes.filter((hash): hash is string => hash !== null);
    if (present.length === 0) return;

    const [row] = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
      FROM self_exclusions
      WHERE identity_hash IN (${sql.join(present.map((h) => sql`${h}`), sql`, `)})
        AND (until IS NULL OR until > now())
    `);
    if (Number(row?.n ?? 0) > 0) {
      throw new KycRejectedError(
        "IDENTITY_EXCLUDED",
        "this identity is self-excluded and cannot be verified",
      );
    }
  }

  private async assertIdentityUnused(
    tx: WalletTransaction,
    userId: string,
    bvnHash: string | null,
    ninHash: string | null,
  ): Promise<void> {
    const [row] = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
      FROM kyc_records
      WHERE user_id <> ${userId}::uuid
        AND (
          (${bvnHash}::text IS NOT NULL AND bvn_hash = ${bvnHash})
          OR (${ninHash}::text IS NOT NULL AND nin_hash = ${ninHash})
        )
    `);
    if (Number(row?.n ?? 0) > 0) {
      // Deliberately vague: confirming WHICH account holds it would let
      // someone probe for whether a given BVN is registered.
      throw new KycRejectedError(
        "IDENTITY_IN_USE",
        "this identity is already associated with another account",
      );
    }
  }
}

export const kycService = new KycService();
