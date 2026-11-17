import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { assertReviewEnvironment } from "@/lib/review-mode";
import { hashPassword } from "@/modules/auth/password";
import { appendAuditLog } from "@/modules/audit/append";
import { walletService } from "@/modules/wallet/wallet.service";

/**
 * Disposable fixtures for the browser suite.
 *
 * THE PROBLEM THIS SOLVES, STATED PLAINLY. Several controls are irreversible
 * for the account that uses them — self-exclusion, cool-off, a KYC submission,
 * a password change, revoking every other session. The previous pass classified
 * every one of them as an "integration boundary" whose stated reason was, in
 * substance, that pressing it would break the rest of the run. That is not an
 * integration boundary. It is a shared-fixture problem wearing one's coat, and
 * the honest fix is a fresh account per test rather than a paragraph explaining
 * why the button was never pressed.
 *
 * WHAT IS AND IS NOT DONE BY HAND HERE:
 *
 *   - The user row and its three wallet buckets are INSERTed, exactly as
 *     `scripts/seed-demo.ts` does. A user is not money.
 *   - Funding goes through `walletService.credit`, so every ledger invariant,
 *     trigger, bucket rule and idempotency guarantee applies. There is no
 *     UPDATE of a balance in this file, and an audit row is written on the same
 *     transaction as the entries — money with nobody accountable is the thing
 *     an auditor asks about first.
 *   - Nothing here writes a bet status, a bet outcome, an event result, a
 *     payout, an outbox state or an exposure value. Those move only through the
 *     services and registered jobs that own them.
 */

const CASH_BUCKET = sql`kind = 'USER' AND currency = 'NGN' AND bucket = 'CASH'`;

export interface DisposableAccount {
  userId: string;
  email: string;
  password: string;
  walletId: string;
  balanceMinor: string;
}

export interface CreateAccountParams {
  /** Prefix only. The address is completed here so two runs cannot collide. */
  label: string;
  password?: string;
  /** Pass `null` to create an account in the legacy "no date of birth" state. */
  dateOfBirth?: string | null;
  kycLevel?: number;
  fundMinor?: string;
  status?: "ACTIVE" | "SUSPENDED";
}

export const DISPOSABLE_PASSWORD = "review-disposable-9781";

/**
 * `.local` is a reserved TLD. Even if a delivery adapter were somehow real,
 * nothing addressed here could leave the machine.
 */
export function disposableEmail(label: string): string {
  return `${label}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}@review.local`;
}

export async function createDisposableAccount(
  params: CreateAccountParams,
): Promise<DisposableAccount> {
  assertReviewEnvironment("QA fixtures");

  const email = disposableEmail(params.label);
  const password = params.password ?? DISPOSABLE_PASSWORD;
  const passwordHash = await hashPassword(password);
  const dateOfBirth = params.dateOfBirth === undefined ? "1990-01-01" : params.dateOfBirth;

  const { userId, walletId } = await walletService.withMoneyTransaction(async ({ tx }) => {
    const [user] = await tx.execute<{ id: string }>(sql`
      INSERT INTO users (email, password_hash, kyc_level, status, date_of_birth)
      VALUES (
        ${email},
        ${passwordHash},
        ${params.kycLevel ?? 2},
        ${params.status ?? "ACTIVE"}::user_status,
        ${dateOfBirth}::date
      )
      RETURNING id::text
    `);
    if (!user) throw new Error("disposable account insert returned no row");

    await tx.execute(sql`
      INSERT INTO wallets (kind, user_id, currency, bucket, cached_balance_minor)
      SELECT 'USER', ${user.id}::uuid, 'NGN', b.bucket_kind, 0
      FROM (VALUES ('CASH'::wallet_bucket), ('BONUS'::wallet_bucket), ('LOCKED'::wallet_bucket))
        AS b(bucket_kind)
      ON CONFLICT DO NOTHING
    `);

    // Named bucket. A predicate of (user_id, kind, currency) matches all three
    // rows and returns whichever the planner happens to hand back first.
    const [wallet] = await tx.execute<{ id: string }>(sql`
      SELECT id::text FROM wallets WHERE user_id = ${user.id}::uuid AND ${CASH_BUCKET}
    `);
    if (!wallet) throw new Error("disposable account has no CASH wallet");

    return { userId: user.id, walletId: wallet.id };
  });

  let balanceMinor = 0n;
  if (params.fundMinor && BigInt(params.fundMinor) > 0n) {
    balanceMinor = await fundDisposableAccount(userId, BigInt(params.fundMinor));
  }

  return { userId, email, password, walletId, balanceMinor: balanceMinor.toString() };
}

/**
 * Credits a disposable account through the real ledger service.
 *
 * THIS IS NOT A DEPOSIT and is never reported as one. Paystack is not involved
 * and nothing here says the payment rail works — it posts an ADJUSTMENT so the
 * betting engine can be exercised without a live payment provider, which is a
 * different claim entirely. `scripts/qa-credit.ts` makes the same one from a
 * terminal, and this is that script reachable from a browser test.
 */
export async function fundDisposableAccount(userId: string, amountMinor: bigint): Promise<bigint> {
  assertReviewEnvironment("QA fixtures");
  if (amountMinor <= 0n) throw new Error("funding amount must be positive");

  return walletService.withMoneyTransaction(async ({ tx, credit }) => {
    const [wallet] = await tx.execute<{ id: string; cached_balance_minor: string }>(sql`
      SELECT id::text, cached_balance_minor::text
      FROM wallets WHERE user_id = ${userId}::uuid AND ${CASH_BUCKET}
    `);
    if (!wallet) throw new Error(`no CASH wallet for ${userId}`);

    const idempotencyKey = `qa-review-credit:${userId}:${amountMinor}:${randomUUID()}`;
    const operation = await credit({
      walletId: wallet.id,
      amountMinor,
      type: "ADJUSTMENT",
      idempotencyKey,
      actor: { type: "SYSTEM" },
      metadata: { reason: "QA_VALIDATION_CREDIT", issuedBy: "api/qa/account" },
    });

    /*
     * An audit row on the SAME transaction as the ledger entries. The ledger
     * records that money moved; it does not record who decided it should, and
     * an audit row that can commit without its entries makes the trail look
     * complete when it is not.
     */
    await appendAuditLog(tx, {
      actorType: "SYSTEM",
      actorId: null,
      action: "WALLET_QA_CREDIT",
      entity: "wallet",
      entityId: wallet.id,
      reason: `QA_VALIDATION_CREDIT via /api/qa/account (idempotency key ${idempotencyKey})`,
      before: { balanceMinor: wallet.cached_balance_minor, bucket: "CASH", currency: "NGN" },
      after: {
        balanceMinor: operation.balanceAfterMinor.toString(),
        bucket: "CASH",
        currency: "NGN",
        amountMinor: amountMinor.toString(),
        userId,
      },
      ip: null,
    });

    return operation.balanceAfterMinor;
  });
}

export interface DisposableEvent {
  eventId: string;
  /*
   * The PROVIDER's identifier, returned alongside our own.
   *
   * The settlement drive needs it because `OddsProvider.getResults` speaks the
   * provider's ids, not ours, and mapping between the two is
   * `ResultIngestionService`'s job. A test that used our id would skip the part
   * of ingestion most likely to be wrong.
   */
  providerEventId: string;
  marketId: string;
  selections: { id: string; key: string; label: string; price: string }[];
  home: string;
  away: string;
}

/**
 * One fresh event with a 1x2 market, so a settlement test owns its own fixture.
 *
 * Sharing the seeded board between settlement tests would make each one's
 * result depend on whether another had already finished the match. A per-test
 * event costs five rows and removes the entire class of problem.
 */
export async function createDisposableEvent(params: {
  label: string;
  startsInHours?: number;
  prices?: [string, string, string];
  /**
   * Defaults to `review`, which keeps the fixture off the board.
   *
   * One test needs the opposite: the odds-drift warning is produced by the
   * odds TILE noticing a new price, so the fixture has to be somewhere a tile
   * renders. That test asks for `football` explicitly and accepts the one extra
   * row it puts in the competition rail.
   */
  sport?: string;
}): Promise<DisposableEvent> {
  assertReviewEnvironment("QA fixtures");
  const prices = params.prices ?? ["2.000", "3.400", "3.800"];
  const home = `${params.label} Home`;
  const away = `${params.label} Away`;

  return walletService.withMoneyTransaction(async ({ tx }) => {
    const providerEventId = `review-${randomUUID()}`;
    /*
     * SPORT 'review', NOT 'football', AND THAT IS NOT COSMETIC.
     *
     * The board renders `listUpcoming({ sport: "football" })`, so a disposable
     * fixture created as football joins the real board and the competition
     * rail. Sixty of them across a run did exactly that: the rail filled with
     * "Review League" rows, the first real competition was pushed below the
     * fold, and two board tests failed clicking a link that existed and could
     * not be seen. The failure was in the fixtures, not the product, which is
     * the worst kind of red.
     *
     * An unlisted sport keeps every one of these off the board and out of the
     * screenshots while changing nothing about the flow: the event page is
     * reached by provider id, and the betslip lives on the board whether or not
     * the fixture is listed there.
     */
    const [event] = await tx.execute<{ id: string }>(sql`
      INSERT INTO events (provider, provider_event_id, sport, league, home, away, starts_at, status)
      VALUES (
        'demo', ${providerEventId}, ${params.sport ?? "review"}, 'Review League',
        ${home}, ${away},
        now() + make_interval(secs => ${Math.round((params.startsInHours ?? 4) * 3600)}),
        'PENDING'
      )
      RETURNING id::text
    `);
    if (!event) throw new Error("disposable event insert returned no row");

    const [market] = await tx.execute<{ id: string }>(sql`
      INSERT INTO markets (event_id, key, status)
      VALUES (${event.id}::uuid, '1x2', 'OPEN')
      RETURNING id::text
    `);
    if (!market) throw new Error("disposable market insert returned no row");

    const keys = ["home", "draw", "away"];
    const labels = [home, "Draw", away];
    const selections: DisposableEvent["selections"] = [];
    for (let i = 0; i < 3; i += 1) {
      const [selection] = await tx.execute<{ id: string }>(sql`
        INSERT INTO selections (market_id, key, label, current_price_decimal, status)
        VALUES (${market.id}::uuid, ${keys[i]}, ${labels[i]}, ${prices[i]}::numeric, 'OPEN')
        RETURNING id::text
      `);
      selections.push({ id: selection!.id, key: keys[i]!, label: labels[i]!, price: prices[i]! });
    }

    return { eventId: event.id, providerEventId, marketId: market.id, selections, home, away };
  });
}

/**
 * Suspends, closes or reprices a selection — which is what an odds feed does.
 *
 * NOT one of the forbidden manual writes. The prohibition covers wallet
 * balances, ledger rows, BET statuses, bet outcomes, payout records, event
 * RESULTS, settlement-outbox status and exposure values. A selection's price
 * and trading state are market data, republished by a provider every few
 * seconds in normal operation, and the only reason to change one here is that
 * a review server has no live feed to do it. `syncOddsDelta` writes these same
 * two columns in production.
 */
export async function setSelectionState(params: {
  selectionId: string;
  /*
   * The four values `market_status` actually has. Selections share that enum
   * with markets — there is no separate `selection_status` type — so this list
   * is the schema's, not a convenient subset of it.
   */
  status?: "OPEN" | "SUSPENDED" | "SETTLED" | "VOID";
  priceDecimal?: string;
}): Promise<{ status: string; price: string }> {
  assertReviewEnvironment("QA fixtures");
  if (params.priceDecimal && !/^\d{1,3}\.\d{1,3}$/.test(params.priceDecimal)) {
    throw new Error("price must be a decimal such as 2.150");
  }

  return walletService.withMoneyTransaction(async ({ tx }) => {
    const [row] = await tx.execute<{ status: string; current_price_decimal: string }>(sql`
      UPDATE selections
      SET status = COALESCE(${params.status ?? null}::market_status, status),
          current_price_decimal =
            COALESCE(${params.priceDecimal ?? null}::numeric, current_price_decimal),
          updated_at = now()
      WHERE id = ${params.selectionId}::uuid
      RETURNING status::text, current_price_decimal::text
    `);
    if (!row) throw new Error(`no selection ${params.selectionId}`);
    return { status: row.status, price: row.current_price_decimal };
  });
}

export async function setMarketStatus(params: {
  marketId: string;
  status: "OPEN" | "SUSPENDED" | "SETTLED" | "VOID";
}): Promise<{ status: string }> {
  assertReviewEnvironment("QA fixtures");
  return walletService.withMoneyTransaction(async ({ tx }) => {
    const [row] = await tx.execute<{ status: string }>(sql`
      UPDATE markets SET status = ${params.status}::market_status, updated_at = now()
      WHERE id = ${params.marketId}::uuid
      RETURNING status::text
    `);
    if (!row) throw new Error(`no market ${params.marketId}`);
    return { status: row.status };
  });
}
