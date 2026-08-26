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
        INSERT INTO kyc_records (user_id, level, bvn_hash, nin_hash, provider, provider_ref, verified_at)
        VALUES (
          ${params.userId}::uuid,
          ${params.level},
          ${bvnHash},
          ${ninHash},
          ${params.provider}::kyc_provider,
          ${params.providerRef ?? null},
          now()
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
        INSERT INTO kyc_records (user_id, level, document_key, provider)
        VALUES (${params.userId}::uuid, 0, ${stored.key}, 'MANUAL'::kyc_provider)
      `);
    });

    return { documentKey: stored.key };
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
