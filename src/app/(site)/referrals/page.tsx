import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { referralService } from "@/modules/referrals/referral.service";
import { UTILITY_ROUTES } from "@/lib/navigation";
import { naira } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Invite friends" };

/**
 * A customer's referral standing.
 *
 * The qualifying conditions are stated up front rather than in linked terms. A
 * referral scheme whose requirements only appear after somebody has invited ten
 * friends is a scheme designed not to pay.
 */
export default async function ReferralsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect(UTILITY_ROUTES.signIn);

  const standing = await referralService.standingFor(session.user.id).catch((error: unknown) => {
    console.error("[referrals] standing unavailable", error);
    return null;
  });

  if (!standing) {
    return (
      <>
        <header className="page-head">
          <h1>Invite friends</h1>
        </header>
        <p className="notice error">Your referral standing is unavailable right now.</p>
      </>
    );
  }

  return (
    <>
      <header className="page-head">
        <h1>Invite friends</h1>
        <p className="muted">
          {standing.rewarded} rewarded · {standing.pending} pending
        </p>
      </header>

      <section className="card">
        <h2>Your code</h2>
        {standing.code ? (
          <>
            <p className="account-number">{standing.code}</p>
            <p className="muted small">
              Share this, or the link below. Anyone who signs up with it is linked to you.
            </p>
            <p className="muted small">
              <code>/register?ref={standing.code}</code>
            </p>
          </>
        ) : (
          <p className="muted small">No referral code on this account yet.</p>
        )}
      </section>

      <section className="card">
        <h2>What you earn</h2>
        <dl className="totals">
          <div className="payout">
            <dt>Per friend</dt>
            <dd>{naira(standing.terms.rewardMinor)}</dd>
          </div>
          <div>
            <dt>Earned so far</dt>
            <dd>{naira(standing.earnedMinor)}</dd>
          </div>
        </dl>

        {/* Stated here rather than in linked terms. A scheme whose conditions
            only surface after someone has invited ten friends is a scheme
            designed not to pay. */}
        <p className="notice info">
          Your friend needs to deposit at least {naira(standing.terms.minDepositMinor)} and place
          at least {naira(standing.terms.minWageredMinor)} in bets before the reward is paid. We
          pay on real activity, not on signups.
        </p>

        <p className="muted small legal">
          The reward goes straight to your cash balance — it is withdrawable immediately, with no
          wagering attached. Referring your own second account does not count and is detected
          when either account verifies its identity.
        </p>
      </section>

      {standing.pending > 0 ? (
        <section className="card">
          <h2>Pending</h2>
          <p className="muted small">
            {standing.pending} {standing.pending === 1 ? "friend has" : "friends have"} signed up
            but not yet met the deposit and betting conditions.
          </p>
        </section>
      ) : null}
    </>
  );
}
