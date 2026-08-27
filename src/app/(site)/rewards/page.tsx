import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { loyaltyService, TIERS } from "@/modules/promotions/loyalty.service";
import { UTILITY_ROUTES } from "@/lib/navigation";

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
  if (!session?.user) redirect(UTILITY_ROUTES.signIn);

  const standing = await loyaltyService.standingFor(session.user.id).catch((error: unknown) => {
    console.error("[rewards] standing unavailable", error);
    return null;
  });

  if (!standing) {
    return (
      <>
        <header className="page-head">
          <h1>Rewards</h1>
        </header>
        <p className="notice error">Your rewards standing is unavailable right now.</p>
      </>
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
    <>
      <header className="page-head">
        <h1>Rewards</h1>
        <p className="muted">
          {standing.tier.name} · {standing.points.toString()} points
        </p>
      </header>

      <section className="card">
        <h2>Your tier</h2>
        <p className="balance">{standing.tier.name}</p>

        {standing.next ? (
          <>
            <p className="muted small">
              {standing.pointsToNext.toString()} more points to {standing.next.name}
            </p>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
            </div>
          </>
        ) : (
          <p className="muted small">You have reached the highest tier.</p>
        )}
      </section>

      <section className="card">
        <h2>Tiers</h2>
        <table className="statement">
          <tbody>
            {TIERS.map((tier) => (
              <tr key={tier.key}>
                <td>
                  {tier.name}
                  {tier.key === standing.tier.key ? (
                    <>
                      {" "}
                      <span className="pill ok">You</span>
                    </>
                  ) : null}
                </td>
                <td className="right muted small">
                  {tier.threshold.toString()} lifetime points
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small legal">
          One point per ₦1 staked. Points earned are never taken away by redeeming a reward, so
          spending them cannot drop you a tier.
        </p>
      </section>

      <section className="card">
        <h2>Redeeming</h2>
        <p className="muted small">
          There is nothing to redeem points for yet. Rewards appear here once the catalogue
          exists — a spend button that leads nowhere would be worse than none.
        </p>
        <Link href="/promotions" className="btn ghost">
          See promotions
        </Link>
      </section>
    </>
  );
}
