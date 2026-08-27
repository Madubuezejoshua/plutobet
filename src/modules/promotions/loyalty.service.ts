import { sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";

/**
 * Loyalty tiers.
 *
 * Tier is DERIVED from lifetime points, never stored as a status somebody can
 * assign. A loyalty level that can be set by hand stops meaning anything, and
 * the first support agent who grants Diamond to an angry customer has broken
 * the whole scheme.
 *
 * Points come only from real turnover — one point per naira staked — so the
 * ladder measures something true.
 */

export const TIERS = [
  { key: "BRONZE", name: "Bronze", threshold: 0n },
  { key: "SILVER", name: "Silver", threshold: 50_000n },
  { key: "GOLD", name: "Gold", threshold: 250_000n },
  { key: "PLATINUM", name: "Platinum", threshold: 1_000_000n },
  { key: "DIAMOND", name: "Diamond", threshold: 5_000_000n },
] as const;

export type TierKey = (typeof TIERS)[number]["key"];

/** One point per whole naira staked. Kobo below a naira do not round up. */
export function pointsForStake(stakeMinor: bigint): bigint {
  return stakeMinor / 100n;
}

export function tierFor(lifetimePoints: bigint): (typeof TIERS)[number] {
  // Walk down from the top so the highest threshold met wins.
  for (let index = TIERS.length - 1; index >= 0; index -= 1) {
    if (lifetimePoints >= TIERS[index]!.threshold) return TIERS[index]!;
  }
  return TIERS[0]!;
}

export function nextTier(lifetimePoints: bigint): (typeof TIERS)[number] | null {
  return TIERS.find((tier) => tier.threshold > lifetimePoints) ?? null;
}

export interface LoyaltyStanding {
  points: bigint;
  lifetimePoints: bigint;
  tier: (typeof TIERS)[number];
  next: (typeof TIERS)[number] | null;
  pointsToNext: bigint;
}

export class LoyaltyService {
  constructor(private readonly wallet: WalletService = walletService) {}

  /**
   * Awards points for a stake.
   *
   * `points` and `lifetime_points` move together on the way up; only `points`
   * falls when a reward is redeemed. That is what stops redeeming a reward
   * from demoting somebody out of a tier they earned.
   */
  async awardForStake(userId: string, stakeMinor: bigint): Promise<{ awarded: bigint }> {
    const awarded = pointsForStake(stakeMinor);
    if (awarded <= 0n) return { awarded: 0n };

    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        INSERT INTO loyalty_accounts (user_id, points, lifetime_points)
        VALUES (${userId}::uuid, ${awarded}, ${awarded})
        ON CONFLICT (user_id) DO UPDATE SET
          points = loyalty_accounts.points + ${awarded},
          lifetime_points = loyalty_accounts.lifetime_points + ${awarded},
          updated_at = now()
      `);
    });

    return { awarded };
  }

  async standingFor(userId: string): Promise<LoyaltyStanding> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [row] = await tx.execute<{ points: string; lifetime_points: string }>(sql`
        SELECT points::text AS points, lifetime_points::text AS lifetime_points
        FROM loyalty_accounts WHERE user_id = ${userId}::uuid
      `);

      const points = BigInt(row?.points ?? "0");
      const lifetimePoints = BigInt(row?.lifetime_points ?? "0");
      const tier = tierFor(lifetimePoints);
      const next = nextTier(lifetimePoints);

      return {
        points,
        lifetimePoints,
        tier,
        next,
        pointsToNext: next ? next.threshold - lifetimePoints : 0n,
      };
    });
  }
}

export const loyaltyService = new LoyaltyService();
