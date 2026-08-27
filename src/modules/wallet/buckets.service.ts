import { sql } from "drizzle-orm";
import { walletService, WalletService } from "./wallet.service";
import type { MoneyActor, WalletTransaction } from "./types";
import type { WalletBucket } from "./schema";

/**
 * Creating buckets, and moving money between them.
 *
 * A move between buckets is an ordinary double-entry TRANSFER — the same code
 * path, the same row locks in the same UUID order, the same balanced-at-commit
 * checks. Nothing here reaches around the ledger, which is the whole reason
 * buckets were modelled as wallet rows.
 *
 * Note what this module does NOT do: it never invents money. Locking funds
 * moves them from CASH to LOCKED; it does not reduce one without increasing
 * the other. The customer's total is unchanged by every operation here, and a
 * reconciliation replay proves it.
 */

export class BucketError extends Error {
  constructor(
    readonly code: "MISSING_WALLET" | "SAME_BUCKET",
    message: string,
  ) {
    super(message);
    this.name = "BucketError";
  }
}

export class BucketService {
  constructor(private readonly wallet: WalletService = walletService) {}

  /**
   * Ensures an account has all three wallets, creating any that are missing.
   *
   * Idempotent via ON CONFLICT, so it is safe to call at registration and
   * again later for accounts that predate a bucket.
   */
  async ensureBuckets(tx: WalletTransaction, userId: string): Promise<void> {
    await tx.execute(sql`
      INSERT INTO wallets (kind, user_id, currency, bucket, cached_balance_minor)
      SELECT 'USER', ${userId}::uuid, 'NGN', bucket_kind, 0
      FROM (VALUES ('CASH'::wallet_bucket), ('BONUS'::wallet_bucket), ('LOCKED'::wallet_bucket))
        AS b(bucket_kind)
      ON CONFLICT DO NOTHING
    `);
  }

  /** Wallet id for one bucket, inside an existing money transaction. */
  async walletIdFor(
    tx: WalletTransaction,
    userId: string,
    bucket: WalletBucket,
  ): Promise<string> {
    const [row] = await tx.execute<{ id: string }>(sql`
      SELECT id FROM wallets
      WHERE user_id = ${userId}::uuid
        AND kind = 'USER' AND currency = 'NGN'
        AND bucket = ${bucket}::wallet_bucket
    `);
    if (!row) {
      throw new BucketError("MISSING_WALLET", `no ${bucket} wallet for user ${userId}`);
    }
    return row.id;
  }

  /**
   * Moves money between two of one account's own buckets.
   *
   * `idempotencyKey` is mandatory rather than optional: every caller of this
   * is a retryable workflow — a withdrawal being held, a bonus converting —
   * and a bucket move without one is a double-move waiting for a timeout.
   */
  async move(params: {
    userId: string;
    from: WalletBucket;
    to: WalletBucket;
    amountMinor: bigint;
    idempotencyKey: string;
    reason: string;
    /**
     * Defaults to SYSTEM. Pass a real actor when a person caused the move —
     * `MoneyActor` requires an IP for anyone who is not the system, which is
     * what keeps the audit row answerable.
     */
    actor?: MoneyActor;
  }): Promise<{ transactionId: string }> {
    if (params.from === params.to) {
      throw new BucketError("SAME_BUCKET", "source and destination buckets are the same");
    }

    /*
     * The wallet ids are resolved in their own short read, then handed to
     * `transfer`, which opens and owns the money transaction itself — locking
     * both wallets in UUID order to avoid deadlock.
     *
     * A stale read here is harmless: transfer re-locks and re-validates both
     * rows, so the worst a wrong id can do is fail the transfer. It cannot
     * move the wrong money.
     */
    const { fromWalletId, toWalletId } = await this.wallet.withMoneyTransaction(async ({ tx }) => ({
      fromWalletId: await this.walletIdFor(tx, params.userId, params.from),
      toWalletId: await this.walletIdFor(tx, params.userId, params.to),
    }));

    const result = await this.wallet.transfer({
      fromWalletId,
      toWalletId,
      amountMinor: params.amountMinor,
      idempotencyKey: params.idempotencyKey,
      actor: params.actor ?? { type: "SYSTEM" },
      metadata: {
        kind: "BUCKET_MOVE",
        from: params.from,
        to: params.to,
        reason: params.reason,
      },
    });

    return { transactionId: result.transactionId };
  }

  /**
   * Holds funds: CASH → LOCKED.
   *
   * For money that is committed but not yet gone — a withdrawal under review,
   * a disputed amount. The customer keeps seeing it, labelled, rather than
   * watching their balance drop with no explanation.
   */
  async lock(params: {
    userId: string;
    amountMinor: bigint;
    idempotencyKey: string;
    reason: string;
  }): Promise<{ transactionId: string }> {
    return this.move({ ...params, from: "CASH", to: "LOCKED" });
  }

  /** Releases a hold: LOCKED → CASH. */
  async unlock(params: {
    userId: string;
    amountMinor: bigint;
    idempotencyKey: string;
    reason: string;
  }): Promise<{ transactionId: string }> {
    return this.move({ ...params, from: "LOCKED", to: "CASH" });
  }

  /**
   * Converts cleared bonus credit into cash: BONUS → CASH.
   *
   * Deliberately does NOT check wagering requirements — those do not exist
   * yet, and a check that always passes is worse than an absent one because it
   * looks like protection. The caller is responsible until the promotions
   * engine (phase 14) owns that decision, and this is the single place it will
   * need to be enforced when it does.
   */
  async convertBonus(params: {
    userId: string;
    amountMinor: bigint;
    idempotencyKey: string;
    reason: string;
  }): Promise<{ transactionId: string }> {
    return this.move({ ...params, from: "BONUS", to: "CASH" });
  }
}

export const bucketService = new BucketService();
