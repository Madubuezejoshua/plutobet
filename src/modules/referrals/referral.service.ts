import { sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";

/**
 * Referrals.
 *
 * THE RULE THAT SHAPES THIS MODULE
 * A referral pays on QUALIFICATION, never on signup.
 *
 * Paying for a registration is paying for an email address, and ten thousand of
 * those cost less than any bonus worth offering. Requiring a real deposit and
 * real turnover first means the reward is funded by activity that actually
 * happened. Every scheme that pays on signup is farmed within a week.
 *
 * WHAT THIS CANNOT STOP, STATED PLAINLY
 * One person with two phones is indistinguishable from two friends. The
 * identity check below catches the same VERIFIED person twice, which is the
 * version that matters for money, but a determined farmer with two real
 * identities is a risk-team problem rather than a constraint problem — and
 * pretending otherwise would be worse than saying so.
 */

export interface ReferralTerms {
  /** The referred account must deposit at least this much. */
  minDepositMinor: bigint;
  /** ...and stake at least this much. */
  minWageredMinor: bigint;
  /** Paid to the REFERRER once both are met. */
  rewardMinor: bigint;
}

export const DEFAULT_REFERRAL_TERMS: ReferralTerms = {
  minDepositMinor: 200_000n, // ₦2,000
  minWageredMinor: 500_000n, // ₦5,000
  rewardMinor: 100_000n, // ₦1,000
};

export class ReferralError extends Error {
  constructor(
    readonly code: "SELF_REFERRAL" | "ALREADY_REFERRED" | "SHARED_IDENTITY" | "NOT_QUALIFIED",
    message: string,
  ) {
    super(message);
    this.name = "ReferralError";
  }
}

export class ReferralService {
  constructor(
    private readonly wallet: WalletService = walletService,
    private readonly terms: ReferralTerms = DEFAULT_REFERRAL_TERMS,
  ) {}

  /**
   * Records a referral at registration.
   *
   * Creates a PENDING row worth nothing. It becomes worth something only when
   * the referred account has deposited and staked.
   */
  async record(params: { referrerId: string; referredId: string }): Promise<{ id: string } | null> {
    if (params.referrerId === params.referredId) {
      throw new ReferralError("SELF_REFERRAL", "you cannot refer yourself");
    }

    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      /*
       * The check that actually matters: the same VERIFIED identity on both
       * sides. Email and phone are cheap to duplicate; a BVN is not, and the
       * digest comparison works without either party's number being readable
       * here.
       *
       * Only catches accounts that have already verified. An unverified pair
       * passes and is caught later, at KYC, when the identity is finally known.
       */
      const [shared] = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n
        FROM kyc_records a
        JOIN kyc_records b ON (
          (a.bvn_hash IS NOT NULL AND a.bvn_hash = b.bvn_hash)
          OR (a.nin_hash IS NOT NULL AND a.nin_hash = b.nin_hash)
        )
        WHERE a.user_id = ${params.referrerId}::uuid
          AND b.user_id = ${params.referredId}::uuid
      `);
      if (Number(shared?.n ?? 0) > 0) {
        throw new ReferralError(
          "SHARED_IDENTITY",
          "these accounts belong to the same verified person",
        );
      }

      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO referrals (referrer_id, referred_id)
        VALUES (${params.referrerId}::uuid, ${params.referredId}::uuid)
        ON CONFLICT (referred_id) DO NOTHING
        RETURNING id
      `);

      // Already referred by somebody else. Not an error: the customer did
      // nothing wrong, and the first introduction stands.
      return rows[0] ?? null;
    });
  }

  /** Records a deposit against a pending referral. */
  async recordDeposit(referredId: string, amountMinor: bigint): Promise<void> {
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        UPDATE referrals SET deposited_minor = deposited_minor + ${amountMinor}
        WHERE referred_id = ${referredId}::uuid AND status = 'PENDING'
      `);
    });
  }

  /** Records turnover against a pending referral. */
  async recordWagering(referredId: string, stakeMinor: bigint): Promise<void> {
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        UPDATE referrals SET wagered_minor = wagered_minor + ${stakeMinor}
        WHERE referred_id = ${referredId}::uuid AND status = 'PENDING'
      `);
    });
  }

  /**
   * Pays every referral that has met its terms.
   *
   * The reward goes to the REFERRER'S CASH wallet, not their bonus bucket. They
   * earned it by introducing a customer who deposited and staked — attaching a
   * wagering requirement to a reward for someone else's activity would be
   * changing the deal after the fact.
   */
  async payQualified(limit = 100): Promise<{ paid: number; totalMinor: bigint }> {
    const qualified = await this.wallet.withMoneyTransaction(async ({ tx }) => {
      return tx.execute<{ id: string; referrer_id: string }>(sql`
        SELECT id, referrer_id FROM referrals
        WHERE status = 'PENDING'
          AND deposited_minor >= ${this.terms.minDepositMinor}
          AND wagered_minor >= ${this.terms.minWageredMinor}
        ORDER BY created_at ASC
        LIMIT ${limit}
      `);
    });

    let paid = 0;
    let totalMinor = 0n;

    for (const referral of qualified) {
      try {
        await this.wallet.withMoneyTransaction(async ({ tx, credit }) => {
          const [wallet] = await tx.execute<{ id: string }>(sql`
            SELECT id FROM wallets
            WHERE user_id = ${referral.referrer_id}::uuid AND kind = 'USER'
              AND currency = 'NGN' AND bucket = 'CASH'
          `);
          if (!wallet) throw new Error(`no cash wallet for ${referral.referrer_id}`);

          const rewarded = await credit({
            walletId: wallet.id,
            amountMinor: this.terms.rewardMinor,
            type: "BONUS",
            // Keyed on the referral, so a retried run replays rather than
            // paying the same introduction twice.
            idempotencyKey: `referral:reward:${referral.id}`,
            actor: { type: "SYSTEM" },
            metadata: { kind: "REFERRAL_REWARD", referralId: referral.id },
          });

          await tx.execute(sql`
            UPDATE referrals
            SET status = 'REWARDED', qualified_at = now(),
                reward_minor = ${this.terms.rewardMinor},
                reward_txn_id = ${rewarded.transactionId}::uuid
            WHERE id = ${referral.id}::uuid AND status = 'PENDING'
          `);
        });

        paid += 1;
        totalMinor += this.terms.rewardMinor;
      } catch (error) {
        // One referral failing must not stop the rest. A missing wallet or a
        // lock conflict is a per-row problem, and the next run retries it.
        console.error("[referrals] could not pay", referral.id, error);
      }
    }

    return { paid, totalMinor };
  }

  /** A customer's own referral standing. */
  async standingFor(userId: string): Promise<{
    code: string | null;
    pending: number;
    rewarded: number;
    earnedMinor: bigint;
    terms: ReferralTerms;
  }> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [user] = await tx.execute<{ referral_code: string | null }>(sql`
        SELECT referral_code FROM users WHERE id = ${userId}::uuid
      `);

      const [stats] = await tx.execute<{
        pending: number;
        rewarded: number;
        earned: string;
      }>(sql`
        SELECT
          count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
          count(*) FILTER (WHERE status = 'REWARDED')::int AS rewarded,
          COALESCE(SUM(reward_minor) FILTER (WHERE status = 'REWARDED'), 0)::text AS earned
        FROM referrals WHERE referrer_id = ${userId}::uuid
      `);

      return {
        code: user?.referral_code ?? null,
        pending: Number(stats?.pending ?? 0),
        rewarded: Number(stats?.rewarded ?? 0),
        earnedMinor: BigInt(stats?.earned ?? "0"),
        terms: this.terms,
      };
    });
  }
}

export const referralService = new ReferralService();
