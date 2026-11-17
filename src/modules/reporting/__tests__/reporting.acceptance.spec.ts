import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  seedMarket,
  slipKey,
  type BettingContext,
} from "@/modules/betting/__tests__/helpers";
import { ReportingService } from "../reporting.service";

const contexts: BettingContext[] = [];
function context(): BettingContext {
  const created = createBettingContext();
  contexts.push(created);
  return created;
}

afterAll(async () => {
  await closeBettingContexts(contexts);
});

const reporting = new ReportingService();
const IP = "102.89.0.1";

function wholeDayAround(when = new Date()): { from: Date; to: Date } {
  const from = new Date(when.getTime() - 24 * 60 * 60_000);
  const to = new Date(when.getTime() + 24 * 60 * 60_000);
  return { from, to };
}

describe("regulator reporting", () => {
  it("reports gross gaming revenue as stakes minus payouts and refunds", async () => {
    const ctx = context();
    const { userId, walletId } = await createFundedUser(ctx, 10_000_000n);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });

    await ctx.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 300_000n,
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
    });
    await ctx.wallet.credit({
      walletId,
      amountMinor: 100_000n,
      type: "PAYOUT",
      idempotencyKey: `test:payout:${randomUUID()}`,
      actor: { type: "SYSTEM" },
    });

    const rows = await reporting.dailyTurnover(wholeDayAround());
    const today = rows.at(-1)!;

    // The deposit that funded the account must NOT inflate revenue: money
    // moving into a wallet is not something the house earned.
    expect(BigInt(today.stakesMinor)).toBeGreaterThanOrEqual(300_000n);
    expect(BigInt(today.payoutsMinor)).toBeGreaterThanOrEqual(100_000n);
    expect(BigInt(today.grossGamingRevenueMinor)).toBe(
      BigInt(today.stakesMinor) - BigInt(today.payoutsMinor) - BigInt(today.refundsMinor),
    );
  }, 120_000);

  it("lists user-wallet movements without double-counting the system leg", async () => {
    const ctx = context();
    const { userId, walletId } = await createFundedUser(ctx, 1_000_000n);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });

    await ctx.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 100_000n,
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
    });

    const rows = await reporting.transactions(wholeDayAround());
    const mine = rows.filter((row) => row.userId === userId);

    // Every movement is double-entry, so a naive join over ledger_entries
    // would report each one twice — once for the user, once for the system
    // contra account.
    expect(mine).toHaveLength(2); // the deposit, and the stake
    expect(mine.every((row) => row.userId === userId)).toBe(true);
    expect(mine.map((row) => row.type).sort()).toEqual(["DEPOSIT", "STAKE"]);
  }, 120_000);

  it("flags movements at or above the AML threshold", async () => {
    const ctx = context();
    const { userId, walletId } = await createFundedUser(ctx, 0n);

    await ctx.wallet.credit({
      walletId,
      amountMinor: 600_000_000n, // ₦6,000,000
      type: "DEPOSIT",
      idempotencyKey: `test:big:${randomUUID()}`,
      actor: { type: "SYSTEM" },
    });

    const flagged = await reporting.largeTransactions(wholeDayAround(), 500_000_000n);
    const mine = flagged.filter((row) => row.userId === userId);

    expect(mine).toHaveLength(1);
    expect(BigInt(mine[0]!.amountMinor)).toBe(600_000_000n);
    // The reviewer needs to see the verification level beside the amount.
    expect(mine[0]!.kycLevel).toBe(0);
  }, 120_000);

  it("keeps money as integer kobo strings, never floats", async () => {
    const ctx = context();
    const { walletId } = await createFundedUser(ctx, 0n);
    await ctx.wallet.credit({
      walletId,
      amountMinor: 123_456_789n,
      type: "DEPOSIT",
      idempotencyKey: `test:precise:${randomUUID()}`,
      actor: { type: "SYSTEM" },
    });

    const rows = await reporting.transactions(wholeDayAround());
    const row = rows.find((r) => r.amountMinor === "123456789");
    expect(row).toBeDefined();
    // A float would round this in a filing and nobody would notice.
    expect(row!.amountMinor).not.toContain(".");
    expect(BigInt(row!.amountMinor)).toBe(123_456_789n);
  }, 120_000);
});

describe("CSV export", () => {
  it("quotes values so a comma cannot shift later columns", () => {
    const csv = reporting.toCsv([
      { name: "Ade, Oluwaseun", amountMinor: "500000" },
      { name: 'He said "hello"', amountMinor: "1000" },
    ]);

    const lines = csv.split("\n");
    expect(lines[0]).toBe('"name","amountMinor"');
    // Unquoted, this row would push the amount into a third column and the
    // filing would be silently wrong.
    expect(lines[1]).toBe('"Ade, Oluwaseun","500000"');
    // Internal quotes are doubled, per RFC 4180.
    expect(lines[2]).toBe('"He said ""hello""","1000"');
  });

  it("distinguishes a null from an empty string", () => {
    const csv = reporting.toCsv([
      { reference: null, amountMinor: "10" },
      { reference: "", amountMinor: "20" },
    ]);
    const lines = csv.split("\n");

    // A bare field is NULL; a quoted empty field is an empty string. Both are
    // valid RFC 4180, and keeping them distinct is the convention Postgres
    // COPY uses — in a regulator export "no reference was recorded" and "the
    // reference was blank" are not the same statement.
    expect(lines[1]).toBe(',"10"');
    expect(lines[2]).toBe('"","20"');
    // Neither must ever render as the literal text "null".
    expect(csv).not.toContain("null");
  });

  it("returns empty output for no rows", () => {
    expect(reporting.toCsv([])).toBe("");
  });
});
