import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { markets, events, selections } from "@/modules/odds/schema";
import { users } from "@/modules/users/schema";
import { createDirectDatabase, createDirectSqlClient } from "@/modules/wallet/db-direct";
import { WalletService } from "@/modules/wallet/wallet.service";
import { PlacementService, type PlacementConfig } from "../placement.service";

export function directUrl(): string {
  const value = process.env.DIRECT_DATABASE_URL;
  if (!value) throw new Error("DIRECT_DATABASE_URL is missing from the test environment");
  return value;
}

export function createBettingContext(config?: Partial<PlacementConfig>) {
  const sqlClient = createDirectSqlClient(directUrl());
  const database = createDirectDatabase(sqlClient);
  const wallet = new WalletService(database);
  const placement = new PlacementService(database, wallet, {
    driftPolicy: "REJECT",
    minStakeMinor: 10_000n,
    maxStakeMinor: 50_000_000n,
    defaultMarketCeilingMinor: 500_000_000n,
    // Generous by default so existing tests exercise what they were written
    // for; the per-user cap gets its own tests with a tight value.
    maxUserExposureMinor: 100_000_000_000n,
    ...config,
  });
  return { sql: sqlClient, database, wallet, placement };
}

export type BettingContext = ReturnType<typeof createBettingContext>;

export async function createFundedUser(
  context: BettingContext,
  balanceMinor: bigint,
): Promise<{ userId: string; walletId: string }> {
  const { userId, walletId } = await context.database.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
    const [user] = await tx
      .insert(users)
      .values({
        email: `${randomUUID()}@betting.test`,
        passwordHash: "test-only-not-an-authentication-hash",
      })
      .returning({ id: users.id });

    await tx.execute(sql`
      INSERT INTO wallets (kind, user_id, currency, bucket, cached_balance_minor)
      SELECT 'USER', ${user!.id}::uuid, 'NGN', bucket_kind, 0
      FROM (VALUES ('CASH'::wallet_bucket), ('BONUS'::wallet_bucket), ('LOCKED'::wallet_bucket))
        AS b(bucket_kind)
    `);

    const [row] = await tx.execute<{ id: string }>(sql`
      SELECT id FROM wallets
      WHERE user_id = ${user!.id}::uuid AND kind = 'USER'
        AND currency = 'NGN' AND bucket = 'CASH'
    `);
    return { userId: user!.id, walletId: row!.id };
  });

  if (balanceMinor > 0n) {
    await context.wallet.credit({
      walletId,
      amountMinor: balanceMinor,
      type: "DEPOSIT",
      idempotencyKey: `test:fund:${randomUUID()}`,
      actor: { type: "SYSTEM" },
    });
  }
  return { userId, walletId };
}

export interface SeededMarket {
  eventId: string;
  marketId: string;
  selectionIds: Record<string, string>;
}

/** Seeds one football event with a 1X2 market priced for betting. */
export async function seedMarket(
  context: BettingContext,
  opts?: { startsAt?: Date; prices?: Record<string, string> },
): Promise<SeededMarket> {
  const prices = opts?.prices ?? { home: "2.000", draw: "3.500", away: "4.000" };

  return context.database.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
    const [event] = await tx
      .insert(events)
      .values({
        provider: "test-provider",
        providerEventId: `evt-${randomUUID()}`,
        sport: "football",
        league: "Test League",
        home: "Home FC",
        away: "Away FC",
        startsAt: opts?.startsAt ?? new Date(Date.now() + 3 * 60 * 60_000),
        status: "PENDING",
      })
      .returning({ id: events.id });

    const [market] = await tx
      .insert(markets)
      .values({ eventId: event!.id, key: "1x2", status: "OPEN" })
      .returning({ id: markets.id });

    const selectionIds: Record<string, string> = {};
    for (const [key, price] of Object.entries(prices)) {
      const [row] = await tx
        .insert(selections)
        .values({
          marketId: market!.id,
          key,
          label: key,
          currentPriceDecimal: price,
          status: "OPEN",
        })
        .returning({ id: selections.id });
      selectionIds[key] = row!.id;
    }

    return { eventId: event!.id, marketId: market!.id, selectionIds };
  });
}

export function slipKey(): string {
  return `test:slip:${randomUUID()}`;
}

export async function closeBettingContexts(contexts: BettingContext[]): Promise<void> {
  await Promise.all(contexts.map((context) => context.sql.end({ timeout: 5 })));
}
