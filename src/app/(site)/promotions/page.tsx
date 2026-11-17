import Link from "next/link";
import { sql } from "drizzle-orm";
import { getServerSession } from "next-auth";
import { db } from "@/db/pooled";
import { authOptions } from "@/modules/auth/auth-options";
import { bonusService } from "@/modules/promotions/bonus.service";
import { naira } from "@/lib/money";
import { PageShell } from "@/components/sportsbook/page-shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Promotions" };

/**
 * Live promotions, and the customer's own bonuses.
 *
 * Every offer states its wagering requirement next to its headline. A bonus
 * advertised without the condition attached is the most common way gambling
 * promotions mislead, and burying it in linked terms is the same thing more
 * slowly.
 */
export default async function PromotionsPage() {
  const session = await getServerSession(authOptions);

  const [promotions, myBonuses] = await Promise.all([
    db
      .execute<{
        id: string;
        code: string | null;
        name: string;
        description: string;
        match_basis_points: number | null;
        max_bonus_minor: string | null;
        min_deposit_minor: string;
        wagering_multiplier: number;
        bonus_validity_days: number;
      }>(sql`
        SELECT id, code, name, description, match_basis_points,
               max_bonus_minor::text AS max_bonus_minor,
               min_deposit_minor::text AS min_deposit_minor,
               wagering_multiplier, bonus_validity_days
        FROM promotions
        WHERE active = true AND starts_at <= now()
          AND (ends_at IS NULL OR ends_at > now())
        ORDER BY created_at DESC
      `)
      .catch(() => []),
    session?.user
      ? bonusService.activeFor(session.user.id).catch(() => [])
      : Promise.resolve([]),
  ]);

  return (
    <PageShell title="Promotions" sub={`${promotions.length} running`}>
      {myBonuses.length > 0 ? (
        <section className="sb-panel sb-pad" style={{ marginBottom: "var(--sb-3)" }}>
          <h2 className="sb-panel__title" style={{ marginBottom: "var(--sb-3)" }}>Your bonuses</h2>
          {myBonuses.map((bonus) => (
            <div key={bonus.id} style={{ marginBottom: 16 }}>
              <div className="sb-row-between sb-bold">
                <span>{bonus.promotionName}</span>
                <span>{naira(bonus.grantedMinor)}</span>
              </div>
              {/* Progress as money staked against money required, not as a
                  multiplier — that is the figure a customer can actually
                  check against their own bet history. */}
              <p className="sb-small sb-muted" style={{ margin: "4px 0" }}>
                {naira(bonus.wageredMinor)} of {naira(bonus.wageringRequiredMinor)} wagered ·{" "}
                {bonus.progressPercent}% · expires{" "}
                {bonus.expiresAt.toLocaleDateString("en-NG")}
              </p>
              <div
                className="sb-progress"
                role="progressbar"
                aria-valuenow={bonus.progressPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${bonus.promotionName} wagering progress`}
              >
                <div className="sb-progress__fill" style={{ width: `${bonus.progressPercent}%` }} />
              </div>
            </div>
          ))}
          <p className="sb-xs sb-muted">
            Bonus credit can be staked but not withdrawn until its wagering requirement is met.
            Your cash balance is always withdrawable and is kept separate from it.
          </p>
        </section>
      ) : null}

      {promotions.length === 0 ? (
        <section className="sb-panel">
          <div className="sb-empty">
            <p className="sb-empty__title">No promotions right now</p>
            <p className="sb-small">
              When one is running it will appear here with its full terms — including what you
              have to stake before a bonus becomes withdrawable.
            </p>
          </div>
        </section>
      ) : (
        <div className="sb-stack-3">
          {promotions.map((promotion) => (
            <section className="sb-panel sb-pad" key={promotion.id}>
              <h2 className="sb-panel__title">{promotion.name}</h2>
              <p className="sb-small sb-muted">{promotion.description}</p>

              <dl style={{ margin: "0 0 var(--sb-3)" }}>
                {promotion.match_basis_points ? (
                  <div className="sb-total">
                    <dt>Match</dt>
                    <dd>{(Number(promotion.match_basis_points) / 100).toFixed(0)}%</dd>
                  </div>
                ) : null}
                {promotion.max_bonus_minor ? (
                  <div className="sb-total">
                    <dt>Up to</dt>
                    <dd>{naira(BigInt(promotion.max_bonus_minor))}</dd>
                  </div>
                ) : null}
                <div className="sb-total">
                  <dt>Min deposit</dt>
                  <dd>{naira(BigInt(promotion.min_deposit_minor))}</dd>
                </div>
              </dl>

              <p className="sb-note sb-note--warn">
                <strong>Wagering: {promotion.wagering_multiplier}x.</strong> You must stake the
                bonus {promotion.wagering_multiplier} times before it becomes withdrawable cash.
                It expires after {promotion.bonus_validity_days} days.
              </p>

              {promotion.code ? (
                <p className="sb-small sb-muted">
                  Use code <strong>{promotion.code}</strong> when depositing.
                </p>
              ) : null}
            </section>
          ))}
        </div>
      )}

      <p className="sb-xs sb-muted" style={{ marginTop: "var(--sb-4)" }}>
        <Link href="/responsible">Set a deposit limit</Link> if promotions are pushing you to
        stake more than you meant to.
      </p>
    </PageShell>
  );
}
