import Link from "next/link";
import { sql } from "drizzle-orm";
import { getServerSession } from "next-auth";
import { db } from "@/db/pooled";
import { authOptions } from "@/modules/auth/auth-options";
import { bonusService } from "@/modules/promotions/bonus.service";
import { naira } from "@/lib/money";

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
    <>
      <header className="page-head">
        <h1>Promotions</h1>
        <p className="muted">{promotions.length} running</p>
      </header>

      {myBonuses.length > 0 ? (
        <section className="card">
          <h2>Your bonuses</h2>
          {myBonuses.map((bonus) => (
            <div key={bonus.id} style={{ marginBottom: 16 }}>
              <div className="fixture-head">
                <span>{bonus.promotionName}</span>
                <span>{naira(bonus.grantedMinor)}</span>
              </div>
              {/* Progress as money staked against money required, not as a
                  multiplier — that is the figure a customer can actually
                  check against their own bet history. */}
              <p className="muted small">
                {naira(bonus.wageredMinor)} of {naira(bonus.wageringRequiredMinor)} wagered ·{" "}
                {bonus.progressPercent}% · expires{" "}
                {bonus.expiresAt.toLocaleDateString("en-NG")}
              </p>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${bonus.progressPercent}%` }} />
              </div>
            </div>
          ))}
          <p className="muted small legal">
            Bonus credit can be staked but not withdrawn until its wagering requirement is met.
            Your cash balance is always withdrawable and is kept separate from it.
          </p>
        </section>
      ) : null}

      {promotions.length === 0 ? (
        <section className="card empty">
          <p>
            No promotions are running at the moment. When one is, it will appear here with its
            full terms — including what you have to stake before a bonus becomes withdrawable.
          </p>
        </section>
      ) : (
        <div className="stack">
          {promotions.map((promotion) => (
            <section className="card" key={promotion.id}>
              <h2>{promotion.name}</h2>
              <p className="muted small">{promotion.description}</p>

              <dl className="totals">
                {promotion.match_basis_points ? (
                  <div>
                    <dt>Match</dt>
                    <dd>{(Number(promotion.match_basis_points) / 100).toFixed(0)}%</dd>
                  </div>
                ) : null}
                {promotion.max_bonus_minor ? (
                  <div>
                    <dt>Up to</dt>
                    <dd>{naira(BigInt(promotion.max_bonus_minor))}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Min deposit</dt>
                  <dd>{naira(BigInt(promotion.min_deposit_minor))}</dd>
                </div>
              </dl>

              <p className="notice warn">
                <strong>Wagering: {promotion.wagering_multiplier}x.</strong> You must stake the
                bonus {promotion.wagering_multiplier} times before it becomes withdrawable cash.
                It expires after {promotion.bonus_validity_days} days.
              </p>

              {promotion.code ? (
                <p className="muted small">
                  Use code <strong>{promotion.code}</strong> when depositing.
                </p>
              ) : null}
            </section>
          ))}
        </div>
      )}

      <p className="muted small legal" style={{ marginBottom: 40 }}>
        <Link href="/responsible">Set a deposit limit</Link> if promotions are pushing you to
        stake more than you meant to.
      </p>
    </>
  );
}
