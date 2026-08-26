import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { authOptions } from "@/modules/auth/auth-options";
import { ResponsibleControls } from "./controls";

export const dynamic = "force-dynamic";
export const metadata = { title: "Safer gambling" };

type ActiveLimitRow = {
  type: string;
  period_days: number;
  amount_minor: string;
  effective_from: Date;
};

/**
 * Player-facing safer gambling controls.
 *
 * The enforcement for all of this already sits on the money paths — a limit
 * the client could skip by calling the API directly would be decoration. This
 * page is where a player sets them, which is itself a licensing expectation:
 * controls that exist but cannot be reached are not controls.
 */
export default async function ResponsiblePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/api/auth/signin");

  // The limit in force plus any future-dated increase, so the page can show
  // "raised to X, live on Y" rather than silently appearing not to work.
  const limits = await db.execute<ActiveLimitRow>(sql`
    SELECT DISTINCT ON (type, period_days)
      type::text AS type, period_days, amount_minor::text AS amount_minor, effective_from
    FROM rg_limits
    WHERE user_id = ${session.user.id}::uuid
    ORDER BY type, period_days, effective_from DESC, created_at DESC
  `);

  const [account] = await db.execute<{ cool_off_until: Date | null; status: string }>(sql`
    SELECT cool_off_until, status::text AS status FROM users WHERE id = ${session.user.id}::uuid
  `);

  return (
    <main className="shell">
      <nav className="nav" aria-label="Primary navigation">
        <div className="brand">Bet Platform</div>
        <div className="nav-links">
          <a href="/sports">Sports</a>
          <a href="/bets">My bets</a>
          <a href="/wallet">Wallet</a>
          <a href="/deposit">Deposit</a>
        </div>
      </nav>

      <header className="page-head">
        <h1>Safer gambling</h1>
        <p className="muted">Set your own limits. Lowering one applies straight away.</p>
      </header>

      <ResponsibleControls
        limits={limits.map((row) => ({
          type: row.type,
          periodDays: row.period_days,
          amountMinor: row.amount_minor,
          effectiveFrom: new Date(row.effective_from).toISOString(),
        }))}
        coolOffUntil={account?.cool_off_until ? new Date(account.cool_off_until).toISOString() : null}
        status={account?.status ?? "ACTIVE"}
      />
    </main>
  );
}
