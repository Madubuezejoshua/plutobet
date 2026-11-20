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
import { bootstrapSuperAdmin } from "@/modules/admin/bootstrap";
import { rbacService } from "@/modules/admin/rbac.service";

const DEMO_EMAIL = "player@demo.local";
const DEMO_PASSWORD = "demo-password-1234";
const DEMO_ADMIN_EMAIL = "admin@demo.local";
const DEMO_SUPPORT_EMAIL = "support@demo.local";

const FIXTURES: Array<{
  sport: string;
  league: string;
  home: string;
  away: string;
  hours: number;
  prices: [string, string, string] | [string, string];
  total?: { line: string; over: string; under: string };
}> = [
  { sport: "football", league: "Premier League", home: "Arsenal", away: "Chelsea", hours: 3, prices: ["2.100", "3.400", "3.600"], total: { line: "2.5", over: "1.880", under: "1.950" } },
  { sport: "football", league: "Premier League", home: "Liverpool", away: "Man City", hours: 5, prices: ["2.750", "3.500", "2.500"], total: { line: "2.5", over: "1.740", under: "2.100" } },
  { sport: "football", league: "La Liga", home: "Real Madrid", away: "Barcelona", hours: 27, prices: ["2.300", "3.600", "3.000"], total: { line: "2.5", over: "1.680", under: "2.180" } },
  { sport: "football", league: "NPFL", home: "Enyimba", away: "Rivers United", hours: 30, prices: ["1.900", "3.300", "4.200"], total: { line: "2.5", over: "2.050", under: "1.780" } },
  { sport: "football", league: "Serie A", home: "Inter", away: "Juventus", hours: 51, prices: ["2.050", "3.200", "3.900"], total: { line: "2.5", over: "1.950", under: "1.860" } },
  { sport: "basketball", league: "USA - NBA", home: "Los Angeles Lakers", away: "Boston Celtics", hours: 4, prices: ["2.150", "1.720"], total: { line: "226.5", over: "1.900", under: "1.900" } },
  { sport: "basketball", league: "USA - NBA", home: "Golden State Warriors", away: "Denver Nuggets", hours: 6, prices: ["1.850", "1.960"], total: { line: "231.5", over: "1.880", under: "1.920" } },
  { sport: "basketball", league: "Europe - EuroLeague", home: "Real Madrid Baloncesto", away: "Olympiacos", hours: 9, prices: ["1.620", "2.300"], total: { line: "163.5", over: "1.910", under: "1.890" } },
  { sport: "tennis", league: "ATP - Tour Finals", home: "Carlos Alcaraz", away: "Jannik Sinner", hours: 4, prices: ["1.920", "1.900"] },
  { sport: "tennis", league: "WTA - Tour", home: "Iga Swiatek", away: "Aryna Sabalenka", hours: 7, prices: ["1.800", "2.020"] },
  { sport: "table-tennis", league: "International - WTT Series", home: "Fan Zhendong", away: "Felix Lebrun", hours: 2, prices: ["1.450", "2.720"] },
  { sport: "table-tennis", league: "Europe - TT Cup", home: "Tomas Polansky", away: "Lubomir Jancarik", hours: 3, prices: ["1.760", "2.040"] },
  { sport: "esports", league: "Counter-Strike 2 - ESL Pro League", home: "Natus Vincere", away: "FaZe Clan", hours: 3, prices: ["1.720", "2.120"] },
  { sport: "esports", league: "League of Legends - LCK", home: "T1", away: "Gen.G", hours: 8, prices: ["2.050", "1.780"] },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("refusing to seed demo data into a production database");
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const { walletId, adminId, supportId } = await dbDirect.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL ROLE app_role"));

    /*
     * A DATE OF BIRTH, or the demo account cannot bet.
     *
     * Stage 5d closed the gap where accounts predating the column sat outside
     * the age control: betting and withdrawal now refuse until a date is
     * supplied. This seed did not set one, so `player@demo.local` was created
     * in exactly that legacy state — the shell showed the "Confirm your date of
     * birth" banner and every placement was refused. The browser suite had
     * therefore never once placed a bet, and nothing said so, because the
     * refusal is correct behaviour and looked like a passing test.
     *
     * This is NOT the forbidden "inventing a date of birth". That rule protects
     * real customers, where a fabricated date turns "we do not know" into a
     * false record. This is a synthetic account in a disposable database whose
     * email and password are equally invented, and the date is obviously so.
     */
    const [user] = await tx.execute<{ id: string }>(sql`
      INSERT INTO users (email, password_hash, kyc_level, status, date_of_birth)
      VALUES (${DEMO_EMAIL}, ${passwordHash}, 2, 'ACTIVE', DATE '1990-01-01')
      ON CONFLICT (email) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            date_of_birth = COALESCE(users.date_of_birth, EXCLUDED.date_of_birth)
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

    const [admin] = await tx.execute<{ id: string }>(sql`
      INSERT INTO users (email, password_hash, kyc_level, status, role)
      VALUES (${DEMO_ADMIN_EMAIL}, ${passwordHash}, 3, 'ACTIVE', 'ADMIN')
      ON CONFLICT (email) DO UPDATE SET role = 'ADMIN'
      RETURNING id
    `);

    /*
     * A SECOND administrator, holding only SUPPORT_AGENT.
     *
     * Without one, "a support agent cannot perform a super-admin action" can
     * only be asserted in a unit test, and the browser audit has nothing to
     * press. RBAC separation is the control most worth exercising through the
     * real interface, because the failure mode is a page that renders for
     * somebody who should never see it.
     */
    const [support] = await tx.execute<{ id: string }>(sql`
      INSERT INTO users (email, password_hash, kyc_level, status, role)
      VALUES (${DEMO_SUPPORT_EMAIL}, ${passwordHash}, 3, 'ACTIVE', 'ADMIN')
      ON CONFLICT (email) DO UPDATE SET role = 'ADMIN'
      RETURNING id
    `);

    return { userId: user!.id, walletId: wallet!.id, adminId: admin!.id, supportId: support!.id };
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

  /*
   * ADMIN POWERS, ISSUED THE WAY THE APPLICATION ISSUES THEM.
   *
   * Not an INSERT into `admin_role_grants`. `bootstrapSuperAdmin` is the one
   * function allowed to make the first super admin, and it refuses the moment
   * any live super admin exists — so re-running this seed cannot re-elevate a
   * revoked account. The support agent's role then goes through the real
   * `RbacService.grant`, which insists on a super-admin actor, refuses
   * self-granting, demands a reason, and writes the audit row. Granting by hand
   * here would have tested a fiction.
   */
  await dbDirect.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('seed:initial-admin', 0))`);
    const outcome = await bootstrapSuperAdmin(tx, adminId);
    console.log(
      outcome.granted
        ? "  bootstrapped SUPER_ADMIN for the demo administrator"
        : `  SUPER_ADMIN not granted (${outcome.skipped}) — a super admin already exists, which is the guard working`,
    );
  });

  try {
    await rbacService.grant({
      actorUserId: adminId,
      targetUserId: supportId,
      role: "SUPPORT_AGENT",
      reason: "demo seed: a second administrator with support-only powers, so RBAC can be exercised",
      ip: "127.0.0.1",
    });
    console.log("  granted SUPPORT_AGENT to the demo support account");
  } catch (error) {
    // Re-running the seed hits the unique grant; that is not a failure.
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  SUPPORT_AGENT not re-granted: ${message}`);
  }

  let markets = 0;
  await dbDirect.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL ROLE app_role"));

    for (const fixture of FIXTURES) {
      /*
       * IDEMPOTENT BY THE FIXTURE ITSELF, not by a fresh UUID.
       *
       * This used to mint `demo-${randomUUID()}` every run, so seeding twice
       * produced two Arsenal v Chelsea, and seeding eight times produced eight.
       * The board then rendered a wall of repeated matches — and because the
       * review screenshots are a committed deliverable, anyone reading them
       * would reasonably conclude the BOARD duplicates fixtures. It does not;
       * the seed did.
       *
       * Skipping rather than deleting: some of these events have bets against
       * them from earlier test runs, and removing an event a bet points at is
       * not a tidy-up, it is data loss.
       */
      const [existing] = await tx.execute<{ id: string }>(sql`
        SELECT id FROM events
        WHERE provider = 'demo'
          AND sport = ${fixture.sport}
          AND league = ${fixture.league}
          AND home = ${fixture.home}
          AND away = ${fixture.away}
          AND status = 'PENDING'
        LIMIT 1
      `);
      if (existing) continue;

      const [event] = await tx.execute<{ id: string }>(sql`
        INSERT INTO events (provider, provider_event_id, sport, league, home, away, starts_at, status)
        VALUES (
          'demo', ${`demo-${randomUUID()}`}, ${fixture.sport}, ${fixture.league},
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

      const entries: Array<[string, string, string]> =
        fixture.prices.length === 3
          ? [
              ["home", fixture.home, fixture.prices[0]],
              ["draw", "Draw", fixture.prices[1]],
              ["away", fixture.away, fixture.prices[2]],
            ]
          : [
              ["home", fixture.home, fixture.prices[0]],
              ["away", fixture.away, fixture.prices[1]],
            ];

      for (const [key, label, price] of entries) {
        await tx.execute(sql`
          INSERT INTO selections (market_id, key, label, current_price_decimal, status)
          VALUES (${market!.id}::uuid, ${key}, ${label}, ${price}::numeric, 'OPEN')
        `);
      }

      if (fixture.total) {
        const [ouMarket] = await tx.execute<{ id: string }>(sql`
          INSERT INTO markets (event_id, key, status)
          VALUES (${event!.id}::uuid, 'over_under', 'OPEN')
          RETURNING id
        `);
        await tx.execute(sql`
          INSERT INTO selections (market_id, key, label, line, current_price_decimal, status)
          VALUES
            (${ouMarket!.id}::uuid, ${`over_${fixture.total.line}`}, ${`Over ${fixture.total.line}`}, ${fixture.total.line}::numeric, ${fixture.total.over}::numeric, 'OPEN'),
            (${ouMarket!.id}::uuid, ${`under_${fixture.total.line}`}, ${`Under ${fixture.total.line}`}, ${fixture.total.line}::numeric, ${fixture.total.under}::numeric, 'OPEN')
        `);
      }
      markets += 1;
    }
  });

  console.log(`
Seeded ${markets} fixtures.

  player  ${DEMO_EMAIL} / ${DEMO_PASSWORD}   (₦50,000, KYC 2)
  admin   ${DEMO_ADMIN_EMAIL} / ${DEMO_PASSWORD}   (SUPER_ADMIN)
  support ${DEMO_SUPPORT_EMAIL} / ${DEMO_PASSWORD}   (SUPPORT_AGENT only)

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
