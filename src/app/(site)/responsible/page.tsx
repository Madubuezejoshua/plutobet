import Link from "next/link";
import { getServerSession } from "next-auth";
import { sql } from "drizzle-orm";
import {
  Clock,
  ExternalLink,
  Lock,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { db } from "@/db/pooled";
import { authOptions } from "@/modules/auth/auth-options";
import { ResponsibleControls } from "./controls";
import { PageShell } from "@/components/sportsbook/page-shell";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Safer gambling",
  description:
    "PlutoBet safer gambling policy, deposit and loss limits, cool-off breaks, self-exclusion, and independent support resources.",
};

type ActiveLimitRow = {
  type: string;
  period_days: number;
  amount_minor: string;
  effective_from: Date;
};

/**
 * Player-facing safer gambling information and controls.
 *
 * Publicly readable without signing in so prospective players, regulators, and
 * payment partners can inspect PlutoBet's protections upfront. Signed-in
 * players also get live controls that write directly to the database limits
 * enforced on every deposit and bet placement path.
 */
export default async function ResponsiblePage() {
  const session = await getServerSession(authOptions);
  const signedIn = Boolean(session?.user);

  let limits: ActiveLimitRow[] = [];
  let account: { cool_off_until: Date | null; status: string } | undefined;

  if (signedIn) {
    [limits, [account]] = await Promise.all([
      db.execute<ActiveLimitRow>(sql`
        SELECT DISTINCT ON (type, period_days)
          type::text AS type, period_days, amount_minor::text AS amount_minor, effective_from
        FROM rg_limits
        WHERE user_id = ${session!.user.id}::uuid
        ORDER BY type, period_days, effective_from DESC, created_at DESC
      `),
      db.execute<{ cool_off_until: Date | null; status: string }>(sql`
        SELECT cool_off_until, status::text AS status FROM users WHERE id = ${session!.user.id}::uuid
      `),
    ]);
  }

  return (
    <PageShell
      title="Safer gambling"
      sub="Betting should stay entertainment. Every limit below is enforced directly on our deposit and betting engines."
      back={signedIn ? { href: "/account", label: "Account" } : { href: "/", label: "Home" }}
      width="narrow"
    >
      <div className="sb-stack-3">
        {signedIn ? (
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
        ) : (
          <section className="sb-panel sb-pad sb-stack">
            <div className="sb-trust-head">
              <SlidersHorizontal size={18} aria-hidden="true" />
              <h2>Manage your personal limits</h2>
            </div>
            <p className="sb-small sb-muted" style={{ margin: 0 }}>
              Sign in to set daily, weekly, or monthly deposit, loss, and wager limits, schedule a
              cool-off break, or activate self-exclusion directly on your account.
            </p>
            <div className="sb-trust-actions">
              <Link href="/signin?callbackUrl=%2Fresponsible" className="sb-btn sb-btn--primary">
                Sign in to set limits
              </Link>
              <Link href="/register" className="sb-btn sb-btn--dark">
                Create account
              </Link>
            </div>
          </section>
        )}

        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <ShieldCheck size={18} aria-hidden="true" />
            <h2>Tools built into every PlutoBet account</h2>
          </div>

          <div className="sb-trust-grid">
            <div className="sb-trust-card">
              <h3>Deposit, loss &amp; wager limits</h3>
              <p className="sb-small sb-muted">
                Set ceilings per day, per week, or per month. Lowering a limit takes effect
                immediately. Increasing or removing a limit carries a mandatory cooling-off delay so
                heat-of-the-moment changes cannot bypass your cap.
              </p>
            </div>
            <div className="sb-trust-card">
              <h3>Cool-off breaks</h3>
              <p className="sb-small sb-muted">
                Step away for 24 hours, 7 days, or 30 days. During a cool-off period, deposits and
                new bets are blocked automatically while you retain access to withdraw eligible cash
                balances.
              </p>
            </div>
          </div>
        </section>

        <section id="self-exclusion" className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <Lock size={18} aria-hidden="true" />
            <h2>Self-exclusion</h2>
          </div>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            If betting stops feeling fun or feels hard to control, you can self-exclude from
            PlutoBet for a fixed period or indefinitely. Self-exclusion signs you out immediately,
            blocks deposits and bet placement at the database level, and cannot be reversed early by
            support or AI tools.
          </p>
          <p className="sb-note sb-note--warn">
            <ShieldAlert size={14} aria-hidden="true" />
            Strictly 18+. Every player must provide their date of birth and complete identity
            verification before withdrawing funds. Underage accounts are suspended permanently.
          </p>
        </section>

        <section id="reality-check" className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <Clock size={18} aria-hidden="true" />
            <h2>Reality checks &amp; full activity transparency</h2>
          </div>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            Every deposit, stake, win, cash-out, and withdrawal is recorded permanently in your
            wallet statement and bet history. Review your net activity regularly before adding funds
            and never chase losses.
          </p>
          <ul className="sb-trust-list">
            <li>Only bet money you can comfortably afford to lose.</li>
            <li>Set a monthly deposit limit before placing your first bet.</li>
            <li>Never borrow money or use household funds to stake.</li>
            <li>Avoid betting when tired, upset, or under the influence of alcohol.</li>
          </ul>
        </section>

        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <ExternalLink size={18} aria-hidden="true" />
            <h2>Independent help &amp; support organisations</h2>
          </div>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            Free, confidential, non-judgemental support is available worldwide, including online chat
            and peer support accessible from Nigeria:
          </p>
          <dl className="sb-trust-dl">
            <div className="sb-total">
              <dt>Gambling Therapy (Global / Online)</dt>
              <dd>
                <a
                  href="https://www.gamblingtherapy.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sb-footer__cta"
                >
                  gamblingtherapy.org
                </a>
              </dd>
            </div>
            <div className="sb-total">
              <dt>Gamblers Anonymous</dt>
              <dd>
                <a
                  href="https://www.gamblersanonymous.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sb-footer__cta"
                >
                  gamblersanonymous.org
                </a>
              </dd>
            </div>
            <div className="sb-total">
              <dt>GambleAware Information</dt>
              <dd>
                <a
                  href="https://www.gambleaware.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sb-footer__cta"
                >
                  gambleaware.org
                </a>
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </PageShell>
  );
}
