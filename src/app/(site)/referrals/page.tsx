import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { referralService } from "@/modules/referrals/referral.service";
import { UTILITY_ROUTES } from "@/lib/navigation";
import { naira } from "@/lib/money";
import { PageShell } from "@/components/sportsbook/page-shell";
import { ShareCode } from "./share-code";

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
  if (!session?.user) redirect(`${UTILITY_ROUTES.signIn}?callbackUrl=%2Freferrals`);

  const standing = await referralService.standingFor(session.user.id).catch((error: unknown) => {
    console.error("[referrals] standing unavailable", error);
    return null;
  });

  if (!standing) {
    return (
      <PageShell title="Invite friends" width="narrow">
        <p className="sb-note sb-note--error" role="alert">
          Your referral standing is unavailable right now.
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Invite friends"
      sub={`${standing.rewarded} rewarded · ${standing.pending} pending`}
      back={{ href: "/account", label: "Account" }}
      width="narrow"
    >
      <section className="sb-panel sb-pad" style={{ marginBottom: "var(--sb-3)" }}>
        <h2 className="sb-panel__title">Your code</h2>
        {standing.code ? (
          <>
            <p className="sb-accountnumber">{standing.code}</p>
            <ShareCode code={standing.code} />
          </>
        ) : (
          <p className="sb-small sb-muted">No referral code on this account yet.</p>
        )}
      </section>

      <section className="sb-panel sb-pad" style={{ marginBottom: "var(--sb-3)" }}>
        <h2 className="sb-panel__title">What you earn</h2>
        <dl style={{ margin: "0 0 var(--sb-3)" }}>
          <div className="sb-total sb-total--major">
            <dt>Per friend</dt>
            <dd>{naira(standing.terms.rewardMinor)}</dd>
          </div>
          <div className="sb-total">
            <dt>Earned so far</dt>
            <dd>{naira(standing.earnedMinor)}</dd>
          </div>
        </dl>

        {/* Stated here rather than in linked terms. A scheme whose conditions
            only surface after someone has invited ten friends is a scheme
            designed not to pay. */}
        <p className="sb-note sb-note--warn">
          Your friend needs to deposit at least {naira(standing.terms.minDepositMinor)} and place
          at least {naira(standing.terms.minWageredMinor)} in bets before the reward is paid. We
          pay on real activity, not on signups.
        </p>

        <p className="sb-xs sb-muted">
          The reward goes straight to your cash balance — it is withdrawable immediately, with no
          wagering attached. Referring your own second account does not count and is detected
          when either account verifies its identity.
        </p>
      </section>

      {standing.pending > 0 ? (
        <section className="sb-panel sb-pad">
          <h2 className="sb-panel__title">Pending</h2>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            {standing.pending} {standing.pending === 1 ? "friend has" : "friends have"} signed up
            but not yet met the deposit and betting conditions.
          </p>
        </section>
      ) : null}
    </PageShell>
  );
}
