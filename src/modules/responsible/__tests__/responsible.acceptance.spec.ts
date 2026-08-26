import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashBvn } from "@/modules/kyc/identity";
import { users } from "@/modules/users/schema";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  seedMarket,
  slipKey,
  type BettingContext,
} from "@/modules/betting/__tests__/helpers";
import { AccountNotEligibleError } from "@/modules/betting/errors";
import { LIMIT_INCREASE_DELAY_MS, ResponsibleService, RgViolationError } from "../responsible.service";

const PEPPER = "test-pepper-at-least-32-characters-long!!";
const IP = "102.89.0.1";

const contexts: BettingContext[] = [];
function context(): BettingContext {
  const created = createBettingContext();
  contexts.push(created);
  return created;
}

beforeAll(() => {
  process.env.IDENTITY_PEPPER = PEPPER;
});

afterAll(async () => {
  await closeBettingContexts(contexts);
});

/** Records a verified BVN against a user, as KYC would. */
async function verifyIdentity(ctx: BettingContext, userId: string, bvn: string) {
  await ctx.database.execute(sql`
    INSERT INTO kyc_records (user_id, level, bvn_hash, provider, verified_at)
    VALUES (${userId}::uuid, 2, ${hashBvn(bvn)}, 'DOJAH', now())
  `);
  await ctx.database.update(users).set({ kycLevel: 2 }).where(eq(users.id, userId));
}

async function placeOneBet(ctx: BettingContext, userId: string, walletId: string) {
  const market = await seedMarket(ctx, { prices: { home: "2.000" } });
  return ctx.placement.placeBet({
    userId,
    walletId,
    ip: IP,
    stakeMinor: 100_000n,
    idempotencyKey: slipKey(),
    legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
  });
}

describe("self-exclusion at identity level", () => {
  it("refuses to attach one verified identity to a second account", async () => {
    const ctx = context();
    const bvn = "22345678901";

    const first = await createFundedUser(ctx, 5_000_000n);
    await verifyIdentity(ctx, first.userId, bvn);

    // The first line of defence against multi-accounting, and it is a
    // database constraint rather than a service check: the same BVN simply
    // cannot be verified onto two accounts.
    const second = await createFundedUser(ctx, 5_000_000n);
    await expect(verifyIdentity(ctx, second.userId, bvn)).rejects.toThrow();
  }, 120_000);

  // THE §7 HOLE THIS PHASE CLOSES.
  it("blocks an ACTIVE account whose identity is on the exclusion register", async () => {
    const ctx = context();
    const { userId, walletId } = await createFundedUser(ctx, 5_000_000n);
    const bvn = "22345678911";
    await verifyIdentity(ctx, userId, bvn);

    // The identity is excluded without this account ever being flagged —
    // a national/shared register entry, or an exclusion carried over from
    // another operator. The account itself stays ACTIVE.
    await ctx.database.execute(sql`
      INSERT INTO self_exclusions (identity_hash, until, reason)
      VALUES (${hashBvn(bvn)}, NULL, 'registered elsewhere')
    `);

    const [row] = await ctx.database
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, userId));
    // Checking users.status alone — all placement did before this phase —
    // would happily accept the bet below.
    expect(row!.status).toBe("ACTIVE");

    await expect(placeOneBet(ctx, userId, walletId)).rejects.toBeInstanceOf(RgViolationError);
    expect(await ctx.wallet.getBalance(walletId)).toBe(5_000_000n);
  }, 120_000);

  it("registers every identity on the account when someone self-excludes", async () => {
    const ctx = context();
    const service = new ResponsibleService(ctx.wallet);
    const { userId } = await createFundedUser(ctx, 5_000_000n);
    await verifyIdentity(ctx, userId, "22345678921");

    const registered = await service.selfExclude({
      userId,
      // A dated exclusion, so the Date binding is actually exercised.
      until: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      reason: "player request",
    });
    expect(registered.identitiesRegistered).toBe(1);

    const rows = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM self_exclusions
      WHERE identity_hash = ${hashBvn("22345678921")} AND until > now()
    `);
    expect(Number(rows[0]!.n)).toBe(1);
  }, 120_000);

  it("blocks the original account too", async () => {
    const ctx = context();
    const service = new ResponsibleService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 5_000_000n);
    await verifyIdentity(ctx, userId, "22345678902");

    await service.selfExclude({ userId, until: null });

    // Caught by the account-status check before the identity lookup.
    await expect(placeOneBet(ctx, userId, walletId)).rejects.toBeInstanceOf(
      AccountNotEligibleError,
    );
  }, 120_000);

  it("lets an unrelated identity keep betting", async () => {
    const ctx = context();
    const service = new ResponsibleService(ctx.wallet);

    const excluded = await createFundedUser(ctx, 5_000_000n);
    await verifyIdentity(ctx, excluded.userId, "22345678903");
    await service.selfExclude({ userId: excluded.userId, until: null });

    const other = await createFundedUser(ctx, 5_000_000n);
    await verifyIdentity(ctx, other.userId, "22345678904");

    // The register must not become a blanket ban.
    const placed = await placeOneBet(ctx, other.userId, other.walletId);
    expect(placed.betId).toBeTruthy();
  }, 120_000);

  it("stops blocking once a time-boxed exclusion has expired", async () => {
    const ctx = context();
    const { userId, walletId } = await createFundedUser(ctx, 5_000_000n);
    const bvn = "22345678905";
    await verifyIdentity(ctx, userId, bvn);

    // An exclusion that already lapsed.
    await ctx.database.execute(sql`
      INSERT INTO self_exclusions (identity_hash, until)
      VALUES (${hashBvn(bvn)}, now() - interval '1 day')
    `);

    const placed = await placeOneBet(ctx, userId, walletId);
    expect(placed.betId).toBeTruthy();
  }, 120_000);
});

describe("cooling-off", () => {
  it("blocks betting until the period ends", async () => {
    const ctx = context();
    const service = new ResponsibleService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 5_000_000n);

    await service.startCoolOff(userId, new Date(Date.now() + 60 * 60_000));

    await expect(placeOneBet(ctx, userId, walletId)).rejects.toBeInstanceOf(RgViolationError);
    expect(await ctx.wallet.getBalance(walletId)).toBe(5_000_000n);
  }, 120_000);

  it("cannot be shortened once set", async () => {
    const ctx = context();
    const service = new ResponsibleService(ctx.wallet);
    const { userId } = await createFundedUser(ctx, 5_000_000n);

    const long = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    await service.startCoolOff(userId, long);
    // A player mid-urge asking to cut it short must not be able to.
    await service.startCoolOff(userId, new Date(Date.now() + 60_000));

    const [row] = await ctx.database
      .select({ coolOff: sql<Date>`cool_off_until` })
      .from(users)
      .where(eq(users.id, userId));
    expect(new Date(row!.coolOff).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60_000);
  }, 120_000);
});

describe("limit changes", () => {
  it("applies a decrease immediately but defers an increase", async () => {
    const ctx = context();
    const service = new ResponsibleService(ctx.wallet);
    const { userId } = await createFundedUser(ctx, 0n);

    const initial = await service.setLimit({
      userId,
      type: "WAGER",
      periodDays: 1,
      amountMinor: 1_000_000n,
    });
    expect(initial.deferred).toBe(false);

    // Tightening protects the player: effective now.
    const decrease = await service.setLimit({
      userId,
      type: "WAGER",
      periodDays: 1,
      amountMinor: 200_000n,
    });
    expect(decrease.deferred).toBe(false);

    // Loosening waits. A player who can lift their own ceiling mid-session
    // has no limit at all.
    const increase = await service.setLimit({
      userId,
      type: "WAGER",
      periodDays: 1,
      amountMinor: 9_000_000n,
    });
    expect(increase.deferred).toBe(true);
    expect(increase.effectiveFrom.getTime()).toBeGreaterThan(
      Date.now() + LIMIT_INCREASE_DELAY_MS - 60_000,
    );

    // The tighter limit is still the one in force.
    const active = await ctx.wallet.withMoneyTransaction(({ tx }) =>
      service.activeLimit(tx, userId, "WAGER"),
    );
    expect(active!.amountMinor).toBe(200_000n);
  }, 120_000);
});

describe("wager and loss limits on placement", () => {
  it("refuses a stake that would breach the wager limit", async () => {
    const ctx = context();
    const service = new ResponsibleService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 5_000_000n);

    await service.setLimit({ userId, type: "WAGER", periodDays: 1, amountMinor: 150_000n });

    // First ₦1,000 stake fits under the ₦1,500 ceiling.
    await placeOneBet(ctx, userId, walletId);
    // Second would take turnover to ₦2,000.
    await expect(placeOneBet(ctx, userId, walletId)).rejects.toBeInstanceOf(RgViolationError);

    expect(await ctx.wallet.getBalance(walletId)).toBe(4_900_000n);
  }, 120_000);

  it("counts net loss, not turnover, against the loss limit", async () => {
    const ctx = context();
    const service = new ResponsibleService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 5_000_000n);

    await service.setLimit({ userId, type: "LOSS", periodDays: 1, amountMinor: 150_000n });
    await placeOneBet(ctx, userId, walletId);

    // The bet is refunded, so the player is level again — a loss limit that
    // counted gross turnover would now lock out someone who has lost nothing.
    await ctx.wallet.credit({
      walletId,
      amountMinor: 100_000n,
      type: "REFUND",
      idempotencyKey: `test:refund:${randomUUID()}`,
      actor: { type: "SYSTEM" },
    });

    const placed = await placeOneBet(ctx, userId, walletId);
    expect(placed.betId).toBeTruthy();
  }, 120_000);

  it("leaves an unlimited account alone", async () => {
    const ctx = context();
    const { userId, walletId } = await createFundedUser(ctx, 5_000_000n);
    const placed = await placeOneBet(ctx, userId, walletId);
    expect(placed.betId).toBeTruthy();
  }, 120_000);
});
