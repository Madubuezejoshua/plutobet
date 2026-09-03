import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { loyaltyService, TIERS } from "@/modules/promotions/loyalty.service";
import { UTILITY_ROUTES } from "@/lib/navigation";
import { PageShell } from "@/components/sportsbook/page-shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Rewards" };

/**
 * Loyalty standing.
 *
 * Tier is derived from lifetime points, which come only from real turnover, so
 * it measures something true rather than something an operator hands out.
 */
export default async function RewardsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect(`${UTILITY_ROUTES.signIn}?callbackUrl=%2Frewards`);

  const standing = await loyaltyService.standingFor(session.user.id).catch((error: unknown) => {
    console.error("[rewards] standing unavailable", error);
    return null;
  });

  if (!standing) {
    return (
      <PageShell title="Rewards" width="narrow">
        <p className="sb-note sb-note--error" role="alert">
          Your rewards standing is unavailable right now.
        </p>
      </PageShell>
    );
  }

  const progressPercent =
    standing.next === null
      ? 100
      : Math.min(
          100,
          Number(
            (standing.lifetimePoints * 100n) /
              (standing.next.threshold === 0n ? 1n : standing.next.threshold),
          ),
        );

  return (
    <PageShell
      title="Rewards"
      sub={`${standing.tier.name} · ${standing.points.toString()} points`}
      back={{ href: "/account", label: "Account" }}
    >
      <section className="sb-balance">
        <p className="sb-balance__label">Your tier</p>
        <p className="sb-balance__value">{standing.tier.name}</p>

        {standing.next ? (
          <>
            <p className="sb-small" style={{ color: "var(--sb-shell-muted)", margin: "var(--sb-3) 0 6px" }}>
              {standing.pointsToNext.toString()} more points to {standing.next.name}
            </p>
            <div
              className="sb-progress sb-progress--onshell"
              role="progressbar"
              aria-valuenow={progressPercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Progress to ${standing.next.name}`}
            >
              <div className="sb-progress__fill" style={{ width: `${progressPercent}%` }} />
            </div>
          </>
        ) : (
          <p className="sb-small" style={{ color: "var(--sb-shell-muted)", marginBottom: 0 }}>
            You have reached the highest tier.
          </p>
        )}
      </section>

      <section className="sb-panel" style={{ marginBottom: "var(--sb-3)" }}>
        <div className="sb-panel__head"><h2 className="sb-panel__title">Tiers</h2></div>
        <table className="sb-table">
          <tbody>
            {TIERS.map((tier) => (
              <tr key={tier.key}>
                <td>
                  {tier.name}
                  {tier.key === standing.tier.key ? (
                    <>
                      {" "}
                      <span className="sb-pill sb-pill--won">You</span>
                    </>
                  ) : null}
                </td>
                <td className="sb-table__num sb-muted sb-small">
                  {tier.threshold.toString()} lifetime points
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="sb-xs sb-muted" style={{ padding: "var(--sb-3)", margin: 0 }}>
          One point per ₦1 staked. Points earned are never taken away by redeeming a reward, so
          spending them cannot drop you a tier.
        </p>
      </section>

      <section className="sb-panel sb-pad sb-stack">
        <h2 className="sb-panel__title">Redeeming</h2>
        <p className="sb-small sb-muted" style={{ margin: 0 }}>
          There is nothing to redeem points for yet. Rewards appear here once the catalogue
          exists — a spend button that leads nowhere would be worse than none.
        </p>
        <Link href="/promotions" className="sb-btn sb-btn--ghost">
          See promotions
        </Link>
      </section>
    </PageShell>
  );
}
