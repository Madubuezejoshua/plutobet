import { sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";
import type { WalletTransaction } from "../wallet/types";
import { RgViolationError } from "./errors";
import { rgLimits, type RgLimitType } from "./schema";

// Re-exported so existing callers keep one import site.
export { RgViolationError };

/**
 * Responsible gambling enforcement.
 *
 * These checks sit on the money paths rather than in the UI: a limit a client
 * can skip by calling the API directly is decoration. Everything here is
 * evaluated inside the caller's transaction, against the ledger, so it cannot
 * disagree with what actually happened.
 */

/**
 * How long a limit INCREASE waits before taking effect.
 *
 * A decrease applies immediately. An increase does not, because a player mid
 * session who can lift their own ceiling on the spot has no limit at all —
 * and regulators treat instant increases as non-compliant. 24 hours is the
 * common statutory floor.
 */
export const LIMIT_INCREASE_DELAY_MS = 24 * 60 * 60_000;

export interface ActiveLimit {
  type: RgLimitType;
  periodDays: number;
  amountMinor: bigint;
  effectiveFrom: Date;
}

export class ResponsibleService {
  constructor(private readonly wallet: WalletService = walletService) {}

  /**
   * Records a limit change.
   *
   * Always an INSERT — the history is the audit trail, and a scheduled
   * increase has to coexist with the limit still in force.
   */
  async setLimit(params: {
    userId: string;
    type: RgLimitType;
    periodDays: number;
    amountMinor: bigint;
  }): Promise<{ effectiveFrom: Date; deferred: boolean }> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const current = await this.activeLimit(tx, params.userId, params.type);

      // Tightening protects the user, so it lands now. Loosening waits.
      const isIncrease = current !== null && params.amountMinor > current.amountMinor;
      const effectiveFrom = isIncrease
        ? new Date(Date.now() + LIMIT_INCREASE_DELAY_MS)
        : new Date();

      await tx.insert(rgLimits).values({
        userId: params.userId,
        type: params.type,
        periodDays: params.periodDays,
        amountMinor: params.amountMinor,
        effectiveFrom,
      });

      return { effectiveFrom, deferred: isIncrease };
    });
  }

  /** The limit currently in force, ignoring any future-dated increase. */
  async activeLimit(
    tx: WalletTransaction,
    userId: string,
    type: RgLimitType,
  ): Promise<ActiveLimit | null> {
    const [row] = await tx.execute<{
      period_days: number;
      amount_minor: string;
      effective_from: Date;
    }>(sql`
      SELECT period_days, amount_minor::text AS amount_minor, effective_from
      FROM rg_limits
      WHERE user_id = ${userId}::uuid
        AND type = ${type}::rg_limit_type
        AND effective_from <= now()
      ORDER BY effective_from DESC, created_at DESC
      LIMIT 1
    `);
    if (!row) return null;
    return {
      type,
      periodDays: row.period_days,
      amountMinor: BigInt(row.amount_minor),
      effectiveFrom: row.effective_from,
    };
  }

  /**
   * THE CHECK THAT CLOSES §7.
   *
   * Self-exclusion is keyed on the verified identity digest, not the account,
   * so it survives re-registration under a new email. Checking
   * `users.status` alone — which is all placement did before — lets an
   * excluded person open a second account and carry on betting, which is the
   * precise failure the spec calls out.
   *
   * Also covers cooling-off, which is account-level and expires on its own.
   */
  async assertNotExcluded(tx: WalletTransaction, userId: string): Promise<void> {
    const [row] = await tx.execute<{
      status: string;
      cool_off_until: string | null;
      in_cool_off: boolean;
      excluded_until: string | null;
      is_excluded: boolean;
    }>(sql`
      SELECT
        u.status::text AS status,
        u.cool_off_until,
        -- Compared in SQL, against the database clock. Doing it in JS meant
        -- comparing a driver-returned string to a Date, which coerces to a
        -- lexicographic comparison that is quietly always false — the check
        -- passed while enforcing nothing.
        (u.cool_off_until IS NOT NULL AND u.cool_off_until > now()) AS in_cool_off,
        x.until AS excluded_until,
        (x.id IS NOT NULL) AS is_excluded
      FROM users u
      -- Every identity this account has verified, matched against the
      -- exclusion register. A NULL until-date is a permanent exclusion.
      LEFT JOIN LATERAL (
        SELECT se.id, se.until
        FROM kyc_records k
        JOIN self_exclusions se
          ON se.identity_hash = k.bvn_hash OR se.identity_hash = k.nin_hash
        WHERE k.user_id = u.id
          AND (se.until IS NULL OR se.until > now())
        ORDER BY se.until NULLS FIRST
        LIMIT 1
      ) x ON TRUE
      WHERE u.id = ${userId}::uuid
    `);

    if (!row) throw new RgViolationError("SELF_EXCLUSION", `unknown user ${userId}`);

    if (row.status === "SELF_EXCLUDED") {
      throw new RgViolationError("SELF_EXCLUSION", "this account is self-excluded");
    }
    if (row.is_excluded) {
      throw new RgViolationError(
        "SELF_EXCLUSION",
        row.excluded_until
          ? `this identity is self-excluded until ${new Date(row.excluded_until).toISOString()}`
          : "this identity is permanently self-excluded",
      );
    }
    if (row.in_cool_off) {
      throw new RgViolationError(
        "COOL_OFF",
        `this account is in a cooling-off period until ${
          row.cool_off_until ? new Date(row.cool_off_until).toISOString() : "further notice"
        }`,
      );
    }
  }

  /**
   * Checks a proposed stake against WAGER and LOSS limits.
   *
   * Both are computed from the ledger rather than from a running counter, so
   * they cannot drift from what actually happened — the same reason wallet
   * balances are reconstructible.
   */
  async assertStakeWithinLimits(
    tx: WalletTransaction,
    userId: string,
    stakeMinor: bigint,
  ): Promise<void> {
    const wager = await this.activeLimit(tx, userId, "WAGER");
    if (wager && wager.amountMinor >= 0n) {
      const staked = await this.stakedInWindow(tx, userId, wager.periodDays);
      if (staked + stakeMinor > wager.amountMinor) {
        throw new RgViolationError(
          "WAGER",
          `this stake would exceed your ${wager.periodDays}-day wager limit`,
        );
      }
    }

    const loss = await this.activeLimit(tx, userId, "LOSS");
    if (loss && loss.amountMinor >= 0n) {
      // Net loss, not turnover: stakes out minus everything that came back.
      // Counting gross stakes would lock out a player who is level or ahead.
      const netLoss = await this.netLossInWindow(tx, userId, loss.periodDays);
      if (netLoss + stakeMinor > loss.amountMinor) {
        throw new RgViolationError(
          "LOSS",
          `this stake would exceed your ${loss.periodDays}-day loss limit`,
        );
      }
    }
  }

  /** Checks a proposed deposit against the DEPOSIT limit. */
  async assertDepositWithinLimit(
    tx: WalletTransaction,
    userId: string,
    amountMinor: bigint,
  ): Promise<void> {
    const limit = await this.activeLimit(tx, userId, "DEPOSIT");
    if (!limit) return;

    const [row] = await tx.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(le.amount_minor), 0)::text AS total
      FROM ledger_entries le
      JOIN ledger_transactions lt ON lt.id = le.txn_id
      JOIN wallets w ON w.id = le.wallet_id
      WHERE w.user_id = ${userId}::uuid
        AND le.direction = 'CREDIT'
        AND lt.type = 'DEPOSIT'
        AND le.created_at > now() - (${limit.periodDays}::text || ' days')::interval
    `);
    const deposited = BigInt(row?.total ?? "0");
    if (deposited + amountMinor > limit.amountMinor) {
      throw new RgViolationError(
        "DEPOSIT",
        `this deposit would exceed your ${limit.periodDays}-day deposit limit`,
      );
    }
  }

  private async stakedInWindow(
    tx: WalletTransaction,
    userId: string,
    periodDays: number,
  ): Promise<bigint> {
    const [row] = await tx.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(le.amount_minor), 0)::text AS total
      FROM ledger_entries le
      JOIN ledger_transactions lt ON lt.id = le.txn_id
      JOIN wallets w ON w.id = le.wallet_id
      WHERE w.user_id = ${userId}::uuid
        AND le.direction = 'DEBIT'
        AND lt.type = 'STAKE'
        AND le.created_at > now() - (${periodDays}::text || ' days')::interval
    `);
    return BigInt(row?.total ?? "0");
  }

  private async netLossInWindow(
    tx: WalletTransaction,
    userId: string,
    periodDays: number,
  ): Promise<bigint> {
    const [row] = await tx.execute<{ net: string }>(sql`
      SELECT COALESCE(SUM(
        CASE
          WHEN lt.type = 'STAKE'  AND le.direction = 'DEBIT'  THEN le.amount_minor
          WHEN lt.type IN ('PAYOUT', 'REFUND') AND le.direction = 'CREDIT' THEN -le.amount_minor
          ELSE 0
        END
      ), 0)::text AS net
      FROM ledger_entries le
      JOIN ledger_transactions lt ON lt.id = le.txn_id
      JOIN wallets w ON w.id = le.wallet_id
      WHERE w.user_id = ${userId}::uuid
        AND le.created_at > now() - (${periodDays}::text || ' days')::interval
    `);
    const net = BigInt(row?.net ?? "0");
    // A player who is ahead has lost nothing; clamp so winnings do not create
    // headroom above the limit they set.
    return net > 0n ? net : 0n;
  }

  /**
   * Registers a self-exclusion against every identity this user has verified,
   * and closes the account.
   *
   * Keyed on identity so a new email does not reset it. `until = null` is
   * permanent and cannot be lifted by this service at all — reinstatement is
   * a supervised process, not a toggle.
   */
  async selfExclude(params: {
    userId: string;
    until: Date | null;
    reason?: string;
  }): Promise<{ identitiesRegistered: number }> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const identities = await tx.execute<{ identity_hash: string }>(sql`
        SELECT DISTINCT h.identity_hash
        FROM kyc_records k
        CROSS JOIN LATERAL (VALUES (k.bvn_hash), (k.nin_hash)) AS h(identity_hash)
        WHERE k.user_id = ${params.userId}::uuid
          AND h.identity_hash IS NOT NULL
      `);

      for (const row of identities) {
        // ISO string + explicit cast: postgres.js cannot bind a JS Date
        // through a raw fragment, and a null binds fine either way.
        await tx.execute(sql`
          INSERT INTO self_exclusions (identity_hash, until, reason)
          VALUES (
            ${row.identity_hash},
            ${params.until ? params.until.toISOString() : null}::timestamptz,
            ${params.reason ?? null}
          )
        `);
      }

      await tx.execute(sql`
        UPDATE users SET status = 'SELF_EXCLUDED', updated_at = now()
        WHERE id = ${params.userId}::uuid
      `);

      return { identitiesRegistered: identities.length };
    });
  }

  /** Starts a cooling-off period. Cannot be shortened once set. */
  async startCoolOff(userId: string, until: Date): Promise<void> {
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      // GREATEST is what makes this un-shortenable: a later call with an
      // earlier date cannot pull the end of a cooling-off period forward.
      await tx.execute(sql`
        UPDATE users
        SET cool_off_until = GREATEST(
              COALESCE(cool_off_until, now()),
              ${until.toISOString()}::timestamptz
            ),
            updated_at = now()
        WHERE id = ${userId}::uuid
      `);
    });
  }
}

export const responsibleService = new ResponsibleService();
