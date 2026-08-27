import { sql } from "drizzle-orm";
import { bucketService, BucketService } from "../wallet/buckets.service";
import { walletService, WalletService } from "../wallet/wallet.service";

/**
 * Bonuses and wagering.
 *
 * This is where the BONUS wallet bucket from phase 4 earns its keep.
 *
 * THE RULE
 * Bonus credit is not the customer's money until its wagering requirement is
 * met. Until then it may be staked but not withdrawn — and that is enforced by
 * the database, not by this service: a WITHDRAWAL may only debit a CASH
 * wallet, so there is no code path, present or future, that can pay bonus
 * credit out as cash.
 *
 * WAGERING PROGRESS IS ABSOLUTE, NOT A MULTIPLIER
 * "Wager it 5x" is how it is advertised; storing it that way would mean
 * recomputing the target whenever the promotion is edited and re-deriving
 * progress against a moving base. The target is fixed in kobo at grant time,
 * so progress is a sum that cannot drift and the customer cannot have the
 * goalposts moved.
 */

export class BonusError extends Error {
  constructor(
    readonly code:
      | "PROMOTION_NOT_FOUND"
      | "PROMOTION_CLOSED"
      | "ALREADY_CLAIMED"
      | "CLAIM_LIMIT_REACHED"
      | "DEPOSIT_TOO_SMALL"
      | "NOT_ELIGIBLE",
    message: string,
  ) {
    super(message);
    this.name = "BonusError";
  }
}

export interface ActiveBonus {
  id: string;
  promotionName: string;
  grantedMinor: bigint;
  wageringRequiredMinor: bigint;
  wageredMinor: bigint;
  /** 0-100, for a progress bar. */
  progressPercent: number;
  expiresAt: Date;
}

export class BonusService {
  constructor(
    private readonly wallet: WalletService = walletService,
    private readonly buckets: BucketService = bucketService,
  ) {}

  /**
   * Grants a bonus against a deposit.
   *
   * The credit lands in the BONUS bucket, never in cash. Every check happens
   * inside one transaction so two simultaneous claims cannot both pass a
   * per-user limit that only one of them should.
   */
  async claimDepositBonus(params: {
    userId: string;
    promotionCode: string;
    depositMinor: bigint;
    idempotencyKey: string;
  }): Promise<{ bonusId: string; grantedMinor: bigint }> {
    return this.wallet.withMoneyTransaction(async ({ tx, credit }) => {
      const [promotion] = await tx.execute<{
        id: string;
        name: string;
        match_basis_points: number | null;
        max_bonus_minor: string | null;
        min_deposit_minor: string;
        wagering_multiplier: number;
        bonus_validity_days: number;
        max_claims: number | null;
        max_claims_per_user: number;
        active: boolean;
        starts_at: Date;
        ends_at: Date | null;
      }>(sql`
        SELECT id, name, match_basis_points, max_bonus_minor::text AS max_bonus_minor,
               min_deposit_minor::text AS min_deposit_minor, wagering_multiplier,
               bonus_validity_days, max_claims, max_claims_per_user, active,
               starts_at, ends_at
        FROM promotions
        WHERE code = ${params.promotionCode.trim().toUpperCase()}
        FOR UPDATE
      `);

      if (!promotion) throw new BonusError("PROMOTION_NOT_FOUND", "no such promotion code");
      if (!promotion.active) throw new BonusError("PROMOTION_CLOSED", "this promotion is not running");

      const now = Date.now();
      if (new Date(promotion.starts_at).getTime() > now) {
        throw new BonusError("PROMOTION_CLOSED", "this promotion has not started yet");
      }
      if (promotion.ends_at && new Date(promotion.ends_at).getTime() <= now) {
        throw new BonusError("PROMOTION_CLOSED", "this promotion has ended");
      }
      if (params.depositMinor < BigInt(promotion.min_deposit_minor)) {
        throw new BonusError("DEPOSIT_TOO_SMALL", "this deposit is below the promotion minimum");
      }

      // Counted under the promotion's row lock taken above, so two concurrent
      // claims cannot both observe the same count and both pass the cap.
      const [claims] = await tx.execute<{ mine: number; total: number }>(sql`
        SELECT
          count(*) FILTER (WHERE user_id = ${params.userId}::uuid)::int AS mine,
          count(*)::int AS total
        FROM promotion_claims WHERE promotion_id = ${promotion.id}::uuid
      `);

      if (Number(claims?.mine ?? 0) >= Number(promotion.max_claims_per_user)) {
        throw new BonusError("ALREADY_CLAIMED", "you have already claimed this promotion");
      }
      if (promotion.max_claims && Number(claims?.total ?? 0) >= Number(promotion.max_claims)) {
        throw new BonusError("CLAIM_LIMIT_REACHED", "this promotion has been fully claimed");
      }

      const matched =
        (params.depositMinor * BigInt(promotion.match_basis_points ?? 0)) / 10_000n;
      const cap = promotion.max_bonus_minor ? BigInt(promotion.max_bonus_minor) : null;
      const grantedMinor = cap !== null && matched > cap ? cap : matched;

      if (grantedMinor <= 0n) {
        throw new BonusError("NOT_ELIGIBLE", "this deposit does not qualify for a bonus");
      }

      const bonusWalletId = await this.buckets.walletIdFor(tx, params.userId, "BONUS");
      const granted = await credit({
        walletId: bonusWalletId,
        amountMinor: grantedMinor,
        type: "BONUS",
        idempotencyKey: params.idempotencyKey,
        actor: { type: "SYSTEM" },
        metadata: { kind: "BONUS_GRANT", promotionId: promotion.id },
      });

      const expiresAt = new Date(
        now + Number(promotion.bonus_validity_days) * 24 * 60 * 60_000,
      );

      const [bonus] = await tx.execute<{ id: string }>(sql`
        INSERT INTO bonuses (
          promotion_id, user_id, granted_minor, wagering_required_minor,
          grant_txn_id, expires_at
        )
        VALUES (
          ${promotion.id}::uuid, ${params.userId}::uuid, ${grantedMinor},
          ${grantedMinor * BigInt(promotion.wagering_multiplier)},
          ${granted.transactionId}::uuid, ${expiresAt.toISOString()}::timestamptz
        )
        RETURNING id
      `);
      if (!bonus) throw new Error("bonus insert returned no row");

      await tx.execute(sql`
        INSERT INTO promotion_claims (promotion_id, user_id, bonus_id)
        VALUES (${promotion.id}::uuid, ${params.userId}::uuid, ${bonus.id}::uuid)
      `);

      return { bonusId: bonus.id, grantedMinor };
    });
  }

  /**
   * Counts a stake towards wagering, converting any bonus that completes.
   *
   * Applied oldest-first so the bonus closest to expiring clears first — the
   * customer-friendly order, and the one that avoids a bonus expiring while a
   * later one absorbed all the turnover.
   *
   * Called after a bet is placed. Failing here must never fail the bet: the
   * stake is already debited and the bet already exists, and refusing to
   * record progress is a far smaller problem than rolling back a placed wager.
   */
  async recordWagering(params: {
    userId: string;
    stakeMinor: bigint;
  }): Promise<{ converted: string[] }> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const active = await tx.execute<{
        id: string;
        granted_minor: string;
        wagering_required_minor: string;
        wagered_minor: string;
      }>(sql`
        SELECT id, granted_minor::text AS granted_minor,
               wagering_required_minor::text AS wagering_required_minor,
               wagered_minor::text AS wagered_minor
        FROM bonuses
        WHERE user_id = ${params.userId}::uuid AND status = 'ACTIVE' AND expires_at > now()
        ORDER BY expires_at ASC
        FOR UPDATE
      `);

      let remaining = params.stakeMinor;
      const converted: string[] = [];

      for (const bonus of active) {
        if (remaining <= 0n) break;

        const required = BigInt(bonus.wagering_required_minor);
        const already = BigInt(bonus.wagered_minor);
        const outstanding = required - already;
        if (outstanding <= 0n) continue;

        // A stake counts towards ONE bonus at a time, not towards all of them.
        // Crediting the same turnover against several requirements would let a
        // customer clear three bonuses with one bet's worth of risk.
        const applied = remaining < outstanding ? remaining : outstanding;
        remaining -= applied;

        await tx.execute(sql`
          UPDATE bonuses SET wagered_minor = wagered_minor + ${applied}
          WHERE id = ${bonus.id}::uuid
        `);

        if (already + applied >= required) converted.push(bonus.id);
      }

      return { converted };
    });
  }

  /**
   * Converts a cleared bonus into withdrawable cash.
   *
   * Separate from `recordWagering` because it moves money between buckets, and
   * that transfer opens its own transaction. Attempting it inside the progress
   * update would nest one money transaction inside another.
   */
  async convert(bonusId: string): Promise<{ convertedMinor: bigint } | null> {
    const bonus = await this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [row] = await tx.execute<{
        id: string;
        user_id: string;
        granted_minor: string;
        wagering_required_minor: string;
        wagered_minor: string;
        status: string;
      }>(sql`
        SELECT id, user_id, granted_minor::text AS granted_minor,
               wagering_required_minor::text AS wagering_required_minor,
               wagered_minor::text AS wagered_minor, status::text AS status
        FROM bonuses WHERE id = ${bonusId}::uuid
      `);
      return row ?? null;
    });

    if (!bonus || bonus.status !== "ACTIVE") return null;
    if (BigInt(bonus.wagered_minor) < BigInt(bonus.wagering_required_minor)) return null;

    const convertedMinor = BigInt(bonus.granted_minor);

    const moved = await this.buckets.convertBonus({
      userId: bonus.user_id,
      amountMinor: convertedMinor,
      idempotencyKey: `bonus:convert:${bonusId}`,
      reason: "wagering requirement met",
    });

    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        UPDATE bonuses
        SET status = 'CONVERTED', conversion_txn_id = ${moved.transactionId}::uuid,
            settled_at = now()
        WHERE id = ${bonusId}::uuid AND status = 'ACTIVE'
      `);
    });

    return { convertedMinor };
  }

  /** A customer's live bonuses, with progress. */
  async activeFor(userId: string): Promise<ActiveBonus[]> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const rows = await tx.execute<{
        id: string;
        name: string;
        granted_minor: string;
        wagering_required_minor: string;
        wagered_minor: string;
        expires_at: Date;
      }>(sql`
        SELECT b.id, p.name, b.granted_minor::text AS granted_minor,
               b.wagering_required_minor::text AS wagering_required_minor,
               b.wagered_minor::text AS wagered_minor, b.expires_at
        FROM bonuses b
        JOIN promotions p ON p.id = b.promotion_id
        WHERE b.user_id = ${userId}::uuid AND b.status = 'ACTIVE' AND b.expires_at > now()
        ORDER BY b.expires_at ASC
      `);

      return rows.map((row) => {
        const required = BigInt(row.wagering_required_minor);
        const wagered = BigInt(row.wagered_minor);
        return {
          id: row.id,
          promotionName: row.name,
          grantedMinor: BigInt(row.granted_minor),
          wageringRequiredMinor: required,
          wageredMinor: wagered,
          progressPercent:
            required === 0n
              ? 100
              : Math.min(100, Number((wagered * 100n) / required)),
          expiresAt: new Date(row.expires_at),
        };
      });
    });
  }

  /**
   * Expires bonuses whose window has closed.
   *
   * The unconverted credit is debited back out of the BONUS bucket, because it
   * was never the customer's money — leaving it there would show a balance
   * they can neither use nor withdraw, which is worse than removing it.
   */
  async expireLapsed(): Promise<{ expired: number }> {
    const lapsed = await this.wallet.withMoneyTransaction(async ({ tx }) => {
      const rows = await tx.execute<{ id: string; user_id: string; granted_minor: string }>(sql`
        SELECT id, user_id, granted_minor::text AS granted_minor
        FROM bonuses
        WHERE status = 'ACTIVE' AND expires_at <= now()
        LIMIT 200
      `);
      return rows;
    });

    for (const bonus of lapsed) {
      await this.wallet.withMoneyTransaction(async ({ tx, debit }) => {
        const bonusWalletId = await this.buckets.walletIdFor(tx, bonus.user_id, "BONUS");
        const [wallet] = await tx.execute<{ balance: string }>(sql`
          SELECT cached_balance_minor::text AS balance FROM wallets
          WHERE id = ${bonusWalletId}::uuid
        `);

        // Take back only what is still there. A customer who staked the bonus
        // may hold less than was granted, and the wallet cannot go negative.
        const available = BigInt(wallet?.balance ?? "0");
        const granted = BigInt(bonus.granted_minor);
        const clawback = available < granted ? available : granted;

        if (clawback > 0n) {
          await debit({
            walletId: bonusWalletId,
            amountMinor: clawback,
            type: "ADJUSTMENT",
            idempotencyKey: `bonus:expire:${bonus.id}`,
            actor: { type: "SYSTEM" },
            metadata: { kind: "BONUS_EXPIRED", bonusId: bonus.id },
          });
        }

        await tx.execute(sql`
          UPDATE bonuses SET status = 'EXPIRED', settled_at = now()
          WHERE id = ${bonus.id}::uuid AND status = 'ACTIVE'
        `);
      });
    }

    return { expired: lapsed.length };
  }
}

export const bonusService = new BonusService();
