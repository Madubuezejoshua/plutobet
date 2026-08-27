/**
 * Seeds demo fixtures and a funded player so the UI has something to show.
 *
 *   npx tsx scripts/seed-demo.ts
 *
 * DEVELOPMENT ONLY. It credits a wallet through the real wallet service — not
 * a raw INSERT — so even the demo data respects the ledger. Refuses to run
 * against a production database.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { hashPassword } from "@/modules/auth/password";
import { dbDirect } from "@/modules/wallet/db-direct";
import { walletService } from "@/modules/wallet/wallet.service";

const DEMO_EMAIL = "player@demo.local";
const DEMO_PASSWORD = "demo-password-1234";
const DEMO_ADMIN_EMAIL = "admin@demo.local";

const FIXTURES = [
  { league: "Premier League", home: "Arsenal", away: "Chelsea", hours: 3, prices: ["2.100", "3.400", "3.600"] },
  { league: "Premier League", home: "Liverpool", away: "Man City", hours: 5, prices: ["2.750", "3.500", "2.500"] },
  { league: "La Liga", home: "Real Madrid", away: "Barcelona", hours: 27, prices: ["2.300", "3.600", "3.000"] },
  { league: "NPFL", home: "Enyimba", away: "Rivers United", hours: 30, prices: ["1.900", "3.300", "4.200"] },
  { league: "Serie A", home: "Inter", away: "Juventus", hours: 51, prices: ["2.050", "3.200", "3.900"] },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("refusing to seed demo data into a production database");
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const { userId, walletId } = await dbDirect.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL ROLE app_role"));

    const [user] = await tx.execute<{ id: string }>(sql`
      INSERT INTO users (email, password_hash, kyc_level, status)
      VALUES (${DEMO_EMAIL}, ${passwordHash}, 2, 'ACTIVE')
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
      RETURNING id
    `);

    // All three buckets. The cash one is what the rest of the seed credits.
    await tx.execute(sql`
      INSERT INTO wallets (kind, user_id, currency, bucket, cached_balance_minor)
      SELECT 'USER', ${user!.id}::uuid, 'NGN', bucket_kind, 0
      FROM (VALUES ('CASH'::wallet_bucket), ('BONUS'::wallet_bucket), ('LOCKED'::wallet_bucket))
        AS b(bucket_kind)
      ON CONFLICT DO NOTHING
    `);

    const [wallet] = await tx.execute<{ id: string }>(sql`
      SELECT id FROM wallets
      WHERE user_id = ${user!.id}::uuid AND kind = 'USER'
        AND currency = 'NGN' AND bucket = 'CASH'
    `);

    await tx.execute(sql`
      INSERT INTO users (email, password_hash, kyc_level, status, role)
      VALUES (${DEMO_ADMIN_EMAIL}, ${passwordHash}, 3, 'ACTIVE', 'ADMIN')
      ON CONFLICT (email) DO UPDATE SET role = 'ADMIN'
    `);

    return { userId: user!.id, walletId: wallet!.id };
  });

  // Through the wallet service, so the demo balance is backed by real ledger
  // rows and the statement page has something truthful to render.
  const balance = await walletService.getBalance(walletId);
  if (balance < 100_000n) {
    await walletService.credit({
      walletId,
      amountMinor: 5_000_000n, // ₦50,000
      type: "DEPOSIT",
      idempotencyKey: `demo-seed:${walletId}`,
      actor: { type: "SYSTEM" },
      metadata: { kind: "DEMO_SEED" },
    });
  }

  let markets = 0;
  await dbDirect.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL ROLE app_role"));

    for (const fixture of FIXTURES) {
      const [event] = await tx.execute<{ id: string }>(sql`
        INSERT INTO events (provider, provider_event_id, sport, league, home, away, starts_at, status)
        VALUES (
          'demo', ${`demo-${randomUUID()}`}, 'football', ${fixture.league},
          ${fixture.home}, ${fixture.away},
          now() + (${fixture.hours}::text || ' hours')::interval, 'PENDING'
        )
        RETURNING id
      `);

      const [market] = await tx.execute<{ id: string }>(sql`
        INSERT INTO markets (event_id, key, status)
        VALUES (${event!.id}::uuid, '1x2', 'OPEN')
        RETURNING id
      `);

      const labels = [fixture.home, "Draw", fixture.away];
      const keys = ["home", "draw", "away"];
      for (let i = 0; i < 3; i++) {
        await tx.execute(sql`
          INSERT INTO selections (market_id, key, label, current_price_decimal, status)
          VALUES (${market!.id}::uuid, ${keys[i]}, ${labels[i]}, ${fixture.prices[i]}::numeric, 'OPEN')
        `);
      }
      markets += 1;
    }
  });

  console.log(`
Seeded ${markets} fixtures.

  player  ${DEMO_EMAIL} / ${DEMO_PASSWORD}   (₦50,000, KYC 2)
  admin   ${DEMO_ADMIN_EMAIL} / ${DEMO_PASSWORD}

  http://localhost:3000/sports
  http://localhost:3000/wallet
  http://localhost:3000/admin
`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
