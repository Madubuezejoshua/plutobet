import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { DateOfBirthAlreadySetError, DateOfBirthService } from "../date-of-birth.service";
import { UnderageError, InvalidDateOfBirthError } from "../age";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  seedMarket,
  slipKey,
  type BettingContext,
} from "@/modules/betting/__tests__/helpers";

/**
 * Completing a date of birth that was never recorded.
 *
 * WHY THESE ACCOUNTS EXIST AND WHY IT MATTERS. `users.date_of_birth` is
 * nullable, and the `users_minimum_age` trigger only fires when the column is
 * NOT NULL. An account created before the date was collected therefore sits
 * outside the age control entirely — not underage, but unverified, which is the
 * same thing to a regulator asking how you know.
 *
 * Every test here creates that state the only legitimate way: through the real
 * registration path, then clearing the column exactly as an older account would
 * have arrived. No date is ever invented.
 */

const IP = "102.89.0.1";
const contexts: BettingContext[] = [];
function context(): BettingContext {
  const created = createBettingContext();
  contexts.push(created);
  return created;
}

afterAll(async () => {
  await closeBettingContexts(contexts);
});

/**
 * An account in the pre-collection state.
 *
 * The column is cleared with the owner connection, which is how a legacy row
 * genuinely looks. This is test setup reproducing history, not the application
 * editing a date of birth — nothing in `src/` may do this.
 */
async function accountWithoutDateOfBirth(ctx: BettingContext, funds = 1_000_000n) {
  const created = await createFundedUser(ctx, funds);
  await ctx.database.execute(sql`
    UPDATE users SET date_of_birth = NULL WHERE id = ${created.userId}::uuid
  `);
  return created;
}

function service(ctx: BettingContext) {
  return new DateOfBirthService(ctx.wallet);
}

describe("detecting an account with no date of birth", () => {
  it("reports a legacy account as missing", async () => {
    const ctx = context();
    const { userId } = await accountWithoutDateOfBirth(ctx);
    expect(await service(ctx).isMissing(userId)).toBe(true);
  }, 120_000);

  it("reports an ordinary account as complete", async () => {
    const ctx = context();
    const { userId } = await createFundedUser(ctx, 0n);
    expect(await service(ctx).isMissing(userId)).toBe(false);
  }, 120_000);

  it("does not report an unknown user as missing", async () => {
    const ctx = context();
    // "Unknown user" is a different failure and the caller's own account check
    // reports it. Answering true here would send a nonexistent account to a
    // completion form.
    expect(await service(ctx).isMissing(randomUUID())).toBe(false);
  }, 120_000);
});

describe("completing a date of birth", () => {
  it("records a real adult date and clears the flag", async () => {
    const ctx = context();
    const { userId } = await accountWithoutDateOfBirth(ctx);

    const result = await service(ctx).complete({
      userId,
      dateOfBirth: "1990-06-15",
      ip: IP,
    });

    expect(result.dateOfBirth).toBe("1990-06-15");
    expect(await service(ctx).isMissing(userId)).toBe(false);

    const [row] = await ctx.database.execute<{ dob: string }>(sql`
      SELECT date_of_birth::text AS dob FROM users WHERE id = ${userId}::uuid
    `);
    expect(row!.dob).toBe("1990-06-15");
  }, 120_000);

  it("writes an audit row on the same transaction, without the date in it", async () => {
    const ctx = context();
    const { userId } = await accountWithoutDateOfBirth(ctx);

    await service(ctx).complete({ userId, dateOfBirth: "1988-01-02", ip: IP });

    const [audit] = await ctx.database.execute<{ action: string; after: string }>(sql`
      SELECT action, after::text AS after FROM audit_log
      WHERE entity = 'user' AND entity_id = ${userId} AND action = 'DATE_OF_BIRTH_COMPLETED'
    `);
    expect(audit).toBeTruthy();
    // The value lives in the column. A second copy in an append-only log is a
    // second piece of personal data to protect for no extra evidence.
    expect(audit!.after).not.toContain("1988");
  }, 120_000);

  it("refuses someone under 18", async () => {
    const ctx = context();
    const { userId } = await accountWithoutDateOfBirth(ctx);

    const today = new Date();
    const seventeen = new Date(
      Date.UTC(today.getUTCFullYear() - 17, today.getUTCMonth(), today.getUTCDate()),
    )
      .toISOString()
      .slice(0, 10);

    await expect(
      service(ctx).complete({ userId, dateOfBirth: seventeen, ip: IP }),
    ).rejects.toBeInstanceOf(UnderageError);

    // Refused means nothing was written, so the account is still asked.
    expect(await service(ctx).isMissing(userId)).toBe(true);
  }, 120_000);

  it("refuses the day before an eighteenth birthday and accepts the day itself", async () => {
    const ctx = context();
    const today = new Date();

    const exactlyEighteen = new Date(
      Date.UTC(today.getUTCFullYear() - 18, today.getUTCMonth(), today.getUTCDate()),
    )
      .toISOString()
      .slice(0, 10);
    const oneDayShort = new Date(
      Date.UTC(today.getUTCFullYear() - 18, today.getUTCMonth(), today.getUTCDate() + 1),
    )
      .toISOString()
      .slice(0, 10);

    const shy = await accountWithoutDateOfBirth(ctx, 0n);
    await expect(
      service(ctx).complete({ userId: shy.userId, dateOfBirth: oneDayShort, ip: IP }),
    ).rejects.toBeInstanceOf(UnderageError);

    const adult = await accountWithoutDateOfBirth(ctx, 0n);
    await expect(
      service(ctx).complete({ userId: adult.userId, dateOfBirth: exactlyEighteen, ip: IP }),
    ).resolves.toBeTruthy();
  }, 120_000);

  it("refuses dates that are malformed, impossible, future or implausible", async () => {
    const ctx = context();

    for (const bad of [
      "15/06/1990", // not ISO
      "1990-6-5", // not zero-padded
      "2026-02-30", // does not exist; Date silently rolls this to 2026-03-02
      "1800-01-01", // implausible
      "3000-01-01", // future
      "not-a-date",
    ]) {
      const { userId } = await accountWithoutDateOfBirth(ctx, 0n);
      await expect(
        service(ctx).complete({ userId, dateOfBirth: bad, ip: IP }),
      ).rejects.toBeInstanceOf(InvalidDateOfBirthError);
      expect(await service(ctx).isMissing(userId)).toBe(true);
    }
  }, 180_000);

  it("is write-once", async () => {
    const ctx = context();
    const { userId } = await accountWithoutDateOfBirth(ctx);

    await service(ctx).complete({ userId, dateOfBirth: "1990-06-15", ip: IP });

    // The age gate rests on this value. An editable one would turn a refused
    // registration into an accepted one on the second attempt.
    await expect(
      service(ctx).complete({ userId, dateOfBirth: "1980-01-01", ip: IP }),
    ).rejects.toBeInstanceOf(DateOfBirthAlreadySetError);

    const [row] = await ctx.database.execute<{ dob: string }>(sql`
      SELECT date_of_birth::text AS dob FROM users WHERE id = ${userId}::uuid
    `);
    expect(row!.dob).toBe("1990-06-15");
  }, 120_000);

  it("keeps only one value when two submissions race", async () => {
    const ctx = context();
    const { userId } = await accountWithoutDateOfBirth(ctx);
    const svc = service(ctx);

    const results = await Promise.allSettled([
      svc.complete({ userId, dateOfBirth: "1990-06-15", ip: IP }),
      svc.complete({ userId, dateOfBirth: "1975-03-04", ip: IP }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const rows = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log
      WHERE entity_id = ${userId} AND action = 'DATE_OF_BIRTH_COMPLETED'
    `);
    expect(Number(rows[0]!.n)).toBe(1);
  }, 120_000);
});

describe("what an account without a date of birth cannot do", () => {
  it("cannot place a bet", async () => {
    const ctx = context();
    const { userId, walletId } = await accountWithoutDateOfBirth(ctx);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });

    const before = await ctx.wallet.getBalance(walletId);

    await expect(
      ctx.placement.placeBet({
        userId,
        walletId,
        ip: IP,
        stakeMinor: 10_000n,
        idempotencyKey: slipKey(),
        legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
      }),
    ).rejects.toMatchObject({ name: "AccountNotEligibleError" });

    // Refused before any money moved, not after.
    expect(await ctx.wallet.getBalance(walletId)).toBe(before);
    const [bets] = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM bets WHERE user_id = ${userId}::uuid
    `);
    expect(Number(bets!.n)).toBe(0);
  }, 120_000);

  it("can place a bet once the date is supplied", async () => {
    const ctx = context();
    const { userId, walletId } = await accountWithoutDateOfBirth(ctx);
    const market = await seedMarket(ctx, { prices: { home: "2.000" } });

    await service(ctx).complete({ userId, dateOfBirth: "1990-06-15", ip: IP });

    const placed = await ctx.placement.placeBet({
      userId,
      walletId,
      ip: IP,
      stakeMinor: 10_000n,
      idempotencyKey: slipKey(),
      legs: [{ selectionId: market.selectionIds.home!, odds: "2.000" }],
    });

    expect(placed.betId).toBeTruthy();
  }, 120_000);
});
