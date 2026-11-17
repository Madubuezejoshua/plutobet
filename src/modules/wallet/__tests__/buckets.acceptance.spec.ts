import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { BucketService } from "../buckets.service";
import { createWalletTestContext, type WalletTestContext } from "./helpers";

/**
 * Balance segregation.
 *
 * The point of modelling a bucket as a wallet ROW rather than a column is that
 * every existing ledger invariant covers it for free. These tests exist to
 * prove that claim rather than assume it — particularly that a bucket move
 * conserves money and that a reconciliation replay still agrees afterwards.
 */
describe("wallet buckets", () => {
  let context: WalletTestContext;
  let buckets: BucketService;

  beforeAll(() => {
    context = createWalletTestContext();
    buckets = new BucketService(context.wallet);
  });

  afterAll(async () => {
    await context.sql.end({ timeout: 5 });
  });

  async function createAccount(cashMinor = 0n): Promise<string> {
    const userId = await context.wallet.withMoneyTransaction(async ({ tx }) => {
      const [user] = await tx.execute<{ id: string }>(sql`
        INSERT INTO users (email, password_hash)
        VALUES (${`${randomUUID()}@buckets.test`}, 'test-only-not-a-real-hash')
        RETURNING id
      `);
      await buckets.ensureBuckets(tx, user!.id);
      return user!.id;
    });

    if (cashMinor > 0n) {
      const walletId = await walletFor(userId, "CASH");
      await context.wallet.credit({
        walletId,
        amountMinor: cashMinor,
        type: "DEPOSIT",
        idempotencyKey: `seed:${randomUUID()}`,
        actor: { type: "SYSTEM" },
      });
    }
    return userId;
  }

  async function walletFor(userId: string, bucket: string): Promise<string> {
    return context.wallet.withMoneyTransaction(async ({ tx }) => {
      const [row] = await tx.execute<{ id: string }>(sql`
        SELECT id FROM wallets
        WHERE user_id = ${userId}::uuid AND kind = 'USER' AND bucket = ${bucket}::wallet_bucket
      `);
      return row!.id;
    });
  }


  /**
   * Drizzle wraps a database error, so the trigger's own message lives on
   * `cause`. Asserting against the wrapper text would pass for any failed
   * insert — including the wrong one.
   */
  async function rejectionMessage(work: Promise<unknown>): Promise<string> {
    try {
      await work;
      return "";
    } catch (error) {
      const parts: string[] = [];
      let current: unknown = error;
      while (current instanceof Error) {
        parts.push(current.message);
        current = (current as { cause?: unknown }).cause;
      }
      return parts.join(" | ");
    }
  }

  async function balances(userId: string) {
    return context.wallet.withMoneyTransaction(async ({ tx }) => {
      const rows = await tx.execute<{ bucket: string; balance: string }>(sql`
        SELECT bucket::text AS bucket, cached_balance_minor::text AS balance
        FROM wallets WHERE user_id = ${userId}::uuid AND kind = 'USER'
      `);
      const of = (bucket: string) =>
        BigInt(rows.find((row) => row.bucket === bucket)?.balance ?? "0");
      return { cash: of("CASH"), bonus: of("BONUS"), locked: of("LOCKED") };
    });
  }

  it("gives every new account all three buckets, opening at zero", async () => {
    const userId = await createAccount();
    expect(await balances(userId)).toEqual({ cash: 0n, bonus: 0n, locked: 0n });
  });

  it("creates buckets idempotently", async () => {
    const userId = await createAccount();
    await context.wallet.withMoneyTransaction(async ({ tx }) => {
      await buckets.ensureBuckets(tx, userId);
      await buckets.ensureBuckets(tx, userId);
    });

    const [count] = await context.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM wallets WHERE user_id = ${userId}::uuid AND kind = 'USER'
    `);
    expect(Number(count!.n)).toBe(3);
  });

  describe("moving money between buckets", () => {
    it("conserves the total", async () => {
      const userId = await createAccount(100_000n);
      const before = await balances(userId);

      await buckets.lock({
        userId,
        amountMinor: 30_000n,
        idempotencyKey: `lock:${randomUUID()}`,
        reason: "withdrawal under review",
      });

      const after = await balances(userId);
      expect(after.cash).toBe(70_000n);
      expect(after.locked).toBe(30_000n);
      // The customer is no poorer for having funds held.
      expect(after.cash + after.bonus + after.locked).toBe(
        before.cash + before.bonus + before.locked,
      );
    });

    it("releases a hold back to cash", async () => {
      const userId = await createAccount(50_000n);
      const key = randomUUID();

      await buckets.lock({
        userId,
        amountMinor: 20_000n,
        idempotencyKey: `lock:${key}`,
        reason: "review",
      });
      await buckets.unlock({
        userId,
        amountMinor: 20_000n,
        idempotencyKey: `unlock:${key}`,
        reason: "review cleared",
      });

      expect(await balances(userId)).toEqual({ cash: 50_000n, bonus: 0n, locked: 0n });
    });

    it("refuses to move more than the source bucket holds", async () => {
      const userId = await createAccount(10_000n);

      await expect(
        buckets.lock({
          userId,
          amountMinor: 25_000n,
          idempotencyKey: `lock:${randomUUID()}`,
          reason: "too much",
        }),
      ).rejects.toThrow();

      // The failed move left nothing behind.
      expect(await balances(userId)).toEqual({ cash: 10_000n, bonus: 0n, locked: 0n });
    });

    it("replays rather than moving twice on a repeated key", async () => {
      const userId = await createAccount(80_000n);
      const key = `lock:${randomUUID()}`;

      await buckets.lock({ userId, amountMinor: 25_000n, idempotencyKey: key, reason: "hold" });
      await buckets.lock({ userId, amountMinor: 25_000n, idempotencyKey: key, reason: "hold" });

      const after = await balances(userId);
      expect(after.cash).toBe(55_000n);
      expect(after.locked).toBe(25_000n);
    });

    it("refuses a move to the same bucket", async () => {
      const userId = await createAccount(1_000n);
      await expect(
        buckets.move({
          userId,
          from: "CASH",
          to: "CASH",
          amountMinor: 100n,
          idempotencyKey: `same:${randomUUID()}`,
          reason: "nonsense",
        }),
      ).rejects.toThrow(/same/i);
    });
  });

  describe("bonus credit is not cash", () => {
    it("keeps bonus out of the cash balance", async () => {
      const userId = await createAccount(10_000n);
      const bonusWallet = await walletFor(userId, "BONUS");

      await context.wallet.credit({
        walletId: bonusWallet,
        amountMinor: 5_000n,
        type: "BONUS",
        idempotencyKey: `bonus:${randomUUID()}`,
        actor: { type: "SYSTEM" },
      });

      const after = await balances(userId);
      expect(after.cash).toBe(10_000n);
      expect(after.bonus).toBe(5_000n);
    });

    /*
     * The control that matters most in this phase. Paying out bonus credit as
     * if it were the customer's own money is a direct loss and, in a licensed
     * operation, a misrepresentation of what the balance meant. Enforced by a
     * database trigger rather than by remembering to pass the right wallet id.
     */
    it("refuses a WITHDRAWAL debit against the bonus wallet", async () => {
      const userId = await createAccount();
      const bonusWallet = await walletFor(userId, "BONUS");

      await context.wallet.credit({
        walletId: bonusWallet,
        amountMinor: 40_000n,
        type: "BONUS",
        idempotencyKey: `bonus:${randomUUID()}`,
        actor: { type: "SYSTEM" },
      });

      const message = await rejectionMessage(
        context.wallet.debit({
          walletId: bonusWallet,
          amountMinor: 40_000n,
          type: "WITHDRAWAL",
          idempotencyKey: `cashout:${randomUUID()}`,
          actor: { type: "SYSTEM" },
        }),
      );
      expect(message).toMatch(/may only debit a CASH wallet/i);
      expect(message).toMatch(/BONUS/);
    });

    it("refuses a WITHDRAWAL debit against the locked wallet", async () => {
      const userId = await createAccount(30_000n);
      await buckets.lock({
        userId,
        amountMinor: 30_000n,
        idempotencyKey: `lock:${randomUUID()}`,
        reason: "held",
      });
      const lockedWallet = await walletFor(userId, "LOCKED");

      const message = await rejectionMessage(
        context.wallet.debit({
          walletId: lockedWallet,
          amountMinor: 30_000n,
          type: "WITHDRAWAL",
          idempotencyKey: `cashout:${randomUUID()}`,
          actor: { type: "SYSTEM" },
        }),
      );
      expect(message).toMatch(/may only debit a CASH wallet/i);
      expect(message).toMatch(/LOCKED/);
    });

    it("still allows a WITHDRAWAL debit against cash", async () => {
      const userId = await createAccount(30_000n);
      const cashWallet = await walletFor(userId, "CASH");

      const result = await context.wallet.debit({
        walletId: cashWallet,
        amountMinor: 30_000n,
        type: "WITHDRAWAL",
        idempotencyKey: `cashout:${randomUUID()}`,
        actor: { type: "SYSTEM" },
      });

      expect(result.balanceAfterMinor).toBe(0n);
    });

    it("allows converting bonus to cash", async () => {
      const userId = await createAccount();
      const bonusWallet = await walletFor(userId, "BONUS");

      await context.wallet.credit({
        walletId: bonusWallet,
        amountMinor: 12_000n,
        type: "BONUS",
        idempotencyKey: `bonus:${randomUUID()}`,
        actor: { type: "SYSTEM" },
      });
      await buckets.convertBonus({
        userId,
        amountMinor: 12_000n,
        idempotencyKey: `convert:${randomUUID()}`,
        reason: "wagering met",
      });

      expect(await balances(userId)).toEqual({ cash: 12_000n, bonus: 0n, locked: 0n });
    });
  });

  /*
   * REGRESSION GUARD for the worst bug this phase produced.
   *
   * Giving each account three wallet rows silently broke every query that
   * resolved "the user's wallet" by (user_id, kind, currency) — a filter that
   * used to match exactly one row and now matches three. Those queries took
   * whichever row the planner happened to return first, so deposits,
   * settlement payouts, casino wins and cash-outs were all crediting an
   * ARBITRARY bucket. Cash-out is where it surfaced; it was never specific to
   * cash-out.
   *
   * What makes it nasty is that it is not a crash. The money still moves, the
   * ledger still balances, reconciliation still passes — it just lands
   * somewhere the customer cannot spend. This test pins the shape of the
   * filter so a future query written from the old pattern fails loudly.
   */
  it("cannot identify a user's wallet without naming a bucket", async () => {
    const userId = await createAccount(10_000n);

    const ambiguous = await context.wallet.withMoneyTransaction(async ({ tx }) =>
      tx.execute<{ id: string }>(sql`
        SELECT id FROM wallets
        WHERE user_id = ${userId}::uuid AND kind = 'USER' AND currency = 'NGN'
      `),
    );
    // Three, not one. Any query shaped like this is picking at random.
    expect(ambiguous).toHaveLength(3);

    const specific = await context.wallet.withMoneyTransaction(async ({ tx }) =>
      tx.execute<{ id: string }>(sql`
        SELECT id FROM wallets
        WHERE user_id = ${userId}::uuid AND kind = 'USER' AND currency = 'NGN'
          AND bucket = 'CASH'
      `),
    );
    expect(specific).toHaveLength(1);
  });

  /*
   * The claim the whole design rests on: buckets ride the existing invariant
   * machinery. If a bucket move produced a ledger the replay disagreed with,
   * this is where it would show.
   */
  it("leaves every bucket reconciling against its own ledger", async () => {
    const userId = await createAccount(90_000n);
    await buckets.lock({
      userId,
      amountMinor: 40_000n,
      idempotencyKey: `lock:${randomUUID()}`,
      reason: "review",
    });

    const walletIds = await context.wallet.withMoneyTransaction(async ({ tx }) => {
      const rows = await tx.execute<{ id: string }>(sql`
        SELECT id FROM wallets WHERE user_id = ${userId}::uuid AND kind = 'USER'
      `);
      return rows.map((row) => row.id);
    });

    for (const walletId of walletIds) {
      const outcome = await context.reconciliation.reconcileWallet(walletId);
      expect(outcome.status, `wallet ${walletId} drifted`).toBe("CLEAN");
      expect(outcome.driftMinor).toBe(0n);
    }
  });
});
