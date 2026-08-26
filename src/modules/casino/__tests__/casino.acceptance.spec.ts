import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashBvn } from "@/modules/kyc/identity";
import { users } from "@/modules/users/schema";
import { ResponsibleService } from "@/modules/responsible/responsible.service";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  type BettingContext,
} from "@/modules/betting/__tests__/helpers";
import { CasinoError, CasinoService } from "../casino.service";
import { gameRounds } from "../schema";

const PROVIDER = "spribe";
const GAME = "aviator";
const PEPPER = "test-pepper-at-least-32-characters-long!!";

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

async function ledgerLegCount(
  ctx: BettingContext,
  walletId: string,
  type: string,
  direction: "DEBIT" | "CREDIT",
): Promise<number> {
  const rows = await ctx.database.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM ledger_entries le
    JOIN ledger_transactions lt ON lt.id = le.txn_id
    WHERE le.wallet_id = ${walletId}::uuid
      AND le.direction = ${direction}::ledger_direction
      AND lt.type = ${type}::ledger_transaction_type
  `);
  return Number(rows[0]?.n ?? 0);
}

async function openSession(ctx: BettingContext, service: CasinoService, userId: string) {
  const { token } = await service.createSession({ userId, provider: PROVIDER, game: GAME });
  return token;
}

describe("casino round money", () => {
  it("debits a stake once however many times the callback is replayed", async () => {
    const ctx = context();
    const service = new CasinoService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 1_000_000n);
    const token = await openSession(ctx, service, userId);
    const roundRef = `rnd_${randomUUID()}`;

    const results = [];
    for (let i = 0; i < 8; i++) {
      results.push(
        await service.debitRound({
          provider: PROVIDER,
          token,
          roundRef,
          game: GAME,
          amountMinor: 100_000n,
        }),
      );
    }

    expect(await ctx.wallet.getBalance(walletId)).toBe(900_000n);
    expect(await ledgerLegCount(ctx, walletId, "STAKE", "DEBIT")).toBe(1);
    expect(results[0]!.duplicate).toBe(false);
    expect(results.slice(1).every((r) => r.duplicate)).toBe(true);
  }, 120_000);

  it("credits a win once however many times the callback is replayed", async () => {
    const ctx = context();
    const service = new CasinoService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 1_000_000n);
    const token = await openSession(ctx, service, userId);
    const roundRef = `rnd_${randomUUID()}`;

    await service.debitRound({
      provider: PROVIDER,
      token,
      roundRef,
      game: GAME,
      amountMinor: 100_000n,
    });
    for (let i = 0; i < 8; i++) {
      await service.creditRound({ provider: PROVIDER, token, roundRef, amountMinor: 250_000n });
    }

    // 1,000,000 - 100,000 + 250,000, once.
    expect(await ctx.wallet.getBalance(walletId)).toBe(1_150_000n);
    expect(await ledgerLegCount(ctx, walletId, "PAYOUT", "CREDIT")).toBe(1);
  }, 120_000);

  it("keeps the stake and the win as separate idempotent operations", async () => {
    const ctx = context();
    const service = new CasinoService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 1_000_000n);
    const token = await openSession(ctx, service, userId);
    const roundRef = `rnd_${randomUUID()}`;

    // The trap this guards: keying idempotency on the round reference alone
    // would make the win collide with its own stake and never be paid.
    await service.debitRound({
      provider: PROVIDER,
      token,
      roundRef,
      game: GAME,
      amountMinor: 100_000n,
    });
    await service.creditRound({ provider: PROVIDER, token, roundRef, amountMinor: 100_000n });

    expect(await ctx.wallet.getBalance(walletId)).toBe(1_000_000n);
    expect(await ledgerLegCount(ctx, walletId, "STAKE", "DEBIT")).toBe(1);
    expect(await ledgerLegCount(ctx, walletId, "PAYOUT", "CREDIT")).toBe(1);
  }, 120_000);

  it("settles a losing round with no ledger entry", async () => {
    const ctx = context();
    const service = new CasinoService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 1_000_000n);
    const token = await openSession(ctx, service, userId);
    const roundRef = `rnd_${randomUUID()}`;

    await service.debitRound({
      provider: PROVIDER,
      token,
      roundRef,
      game: GAME,
      amountMinor: 100_000n,
    });
    // Zero payout is how an aggregator reports a loss; the ledger refuses
    // zero-amount movements, so the round must close without one.
    await service.creditRound({ provider: PROVIDER, token, roundRef, amountMinor: 0n });

    expect(await ctx.wallet.getBalance(walletId)).toBe(900_000n);
    expect(await ledgerLegCount(ctx, walletId, "PAYOUT", "CREDIT")).toBe(0);

    const [row] = await ctx.database
      .select()
      .from(gameRounds)
      .where(eq(gameRounds.providerRoundRef, roundRef));
    expect(row!.status).toBe("SETTLED");
  }, 120_000);

  it("returns the stake on rollback, once", async () => {
    const ctx = context();
    const service = new CasinoService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 1_000_000n);
    const token = await openSession(ctx, service, userId);
    const roundRef = `rnd_${randomUUID()}`;

    await service.debitRound({
      provider: PROVIDER,
      token,
      roundRef,
      game: GAME,
      amountMinor: 100_000n,
    });
    for (let i = 0; i < 5; i++) {
      await service.rollbackRound({ provider: PROVIDER, token, roundRef });
    }

    expect(await ctx.wallet.getBalance(walletId)).toBe(1_000_000n);
    expect(await ledgerLegCount(ctx, walletId, "REFUND", "CREDIT")).toBe(1);
  }, 120_000);

  it("refuses to roll back a round that already paid out", async () => {
    const ctx = context();
    const service = new CasinoService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 1_000_000n);
    const token = await openSession(ctx, service, userId);
    const roundRef = `rnd_${randomUUID()}`;

    await service.debitRound({
      provider: PROVIDER,
      token,
      roundRef,
      game: GAME,
      amountMinor: 100_000n,
    });
    await service.creditRound({ provider: PROVIDER, token, roundRef, amountMinor: 500_000n });

    // Reversing a settled win is an accounting correction with its own audit,
    // not something an automated callback may do.
    await expect(
      service.rollbackRound({ provider: PROVIDER, token, roundRef }),
    ).rejects.toBeInstanceOf(CasinoError);
    expect(await ctx.wallet.getBalance(walletId)).toBe(1_400_000n);
  }, 120_000);

  it("refuses a stake the player cannot fund", async () => {
    const ctx = context();
    const service = new CasinoService(ctx.wallet);
    const { userId, walletId } = await createFundedUser(ctx, 50_000n);
    const token = await openSession(ctx, service, userId);

    await expect(
      service.debitRound({
        provider: PROVIDER,
        token,
        roundRef: `rnd_${randomUUID()}`,
        game: GAME,
        amountMinor: 100_000n,
      }),
    ).rejects.toThrow();

    expect(await ctx.wallet.getBalance(walletId)).toBe(50_000n);
    const rows = await ctx.database
      .select()
      .from(gameRounds)
      .where(eq(gameRounds.userId, userId));
    expect(rows).toHaveLength(0);
  }, 120_000);
});

describe("casino sessions", () => {
  it("rejects an unknown or expired token", async () => {
    const ctx = context();
    const service = new CasinoService(ctx.wallet);
    const { userId } = await createFundedUser(ctx, 1_000_000n);

    await expect(service.getBalance(PROVIDER, "not-a-real-token")).rejects.toBeInstanceOf(
      CasinoError,
    );

    // Issued already-expired through the real API rather than by UPDATEing
    // the row: app_role has no UPDATE on casino_sessions, and a test that
    // needs more privilege than production grants is testing the wrong thing.
    const { token } = await service.createSession({
      userId,
      provider: PROVIDER,
      game: GAME,
      ttlSeconds: -60,
    });
    await expect(service.getBalance(PROVIDER, token)).rejects.toBeInstanceOf(CasinoError);
  }, 120_000);

  it("never stores the raw launch token", async () => {
    const ctx = context();
    const service = new CasinoService(ctx.wallet);
    const { userId } = await createFundedUser(ctx, 1_000_000n);
    const token = await openSession(ctx, service, userId);

    // A leaked row must not be replayable as a live session.
    const rows = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM casino_sessions WHERE token_hash = ${token}
    `);
    expect(Number(rows[0]!.n)).toBe(0);
  }, 120_000);
});

describe("responsible gambling covers casino", () => {
  it("refuses a session to an excluded identity", async () => {
    const ctx = context();
    const service = new CasinoService(ctx.wallet);
    const { userId } = await createFundedUser(ctx, 1_000_000n);
    const bvn = "33345678901";
    await ctx.database.execute(sql`
      INSERT INTO kyc_records (user_id, level, bvn_hash, provider, verified_at)
      VALUES (${userId}::uuid, 2, ${hashBvn(bvn)}, 'DOJAH', now())
    `);
    await ctx.database.execute(sql`
      INSERT INTO self_exclusions (identity_hash, until) VALUES (${hashBvn(bvn)}, NULL)
    `);

    // Refused at launch, so the player never loads the game at all.
    await expect(
      service.createSession({ userId, provider: PROVIDER, game: GAME }),
    ).rejects.toThrow();
  }, 120_000);

  it("counts casino turnover against the wager limit", async () => {
    const ctx = context();
    const responsible = new ResponsibleService(ctx.wallet);
    const service = new CasinoService(ctx.wallet, responsible);
    const { userId, walletId } = await createFundedUser(ctx, 5_000_000n);

    await responsible.setLimit({ userId, type: "WAGER", periodDays: 1, amountMinor: 150_000n });
    const token = await openSession(ctx, service, userId);

    await service.debitRound({
      provider: PROVIDER,
      token,
      roundRef: `rnd_${randomUUID()}`,
      game: GAME,
      amountMinor: 100_000n,
    });

    // A limit that only covered sports would not be a limit on spending.
    await expect(
      service.debitRound({
        provider: PROVIDER,
        token,
        roundRef: `rnd_${randomUUID()}`,
        game: GAME,
        amountMinor: 100_000n,
      }),
    ).rejects.toThrow();

    expect(await ctx.wallet.getBalance(walletId)).toBe(4_900_000n);
  }, 120_000);

  it("blocks a cooling-off player from starting a session", async () => {
    const ctx = context();
    const responsible = new ResponsibleService(ctx.wallet);
    const service = new CasinoService(ctx.wallet, responsible);
    const { userId } = await createFundedUser(ctx, 1_000_000n);

    await responsible.startCoolOff(userId, new Date(Date.now() + 60 * 60_000));
    await expect(
      service.createSession({ userId, provider: PROVIDER, game: GAME }),
    ).rejects.toThrow();
  }, 120_000);
});
