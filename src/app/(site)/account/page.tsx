import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { UTILITY_ROUTES } from "@/lib/navigation";
import { profileService } from "@/modules/users/profile.service";
import { maskPhone } from "@/modules/notifications/phone";
import type { UserStatus } from "@/modules/users/schema";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account" };

const TIER_LABEL: Record<number, string> = {
  0: "Unverified",
  1: "Basic",
  2: "Full",
  3: "Enhanced",
};

/**
 * What each status means to the person in it.
 *
 * Written plainly and without euphemism: someone whose account is restricted
 * should be able to find out what they can still do without contacting
 * support.
 */
const STATUS_EXPLANATION: Record<UserStatus, string> = {
  ACTIVE: "Your account is in good standing.",
  SUSPENDED: "Your account is suspended. You cannot bet or withdraw. Contact support.",
  RESTRICTED: "Your account is restricted. You can withdraw, but not place new bets.",
  VERIFICATION_REQUIRED: "Verify your identity to continue using your account.",
  SELF_EXCLUDED: "You have self-excluded. This cannot be reversed before the period ends.",
  CLOSED: "This account is closed.",
};

export default async function AccountPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect(UTILITY_ROUTES.signIn);

  const profile = await profileService.get(session.user.id);
  const displayName =
    [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
    profile.username ||
    profile.email;

  return (
    <>
      <header className="page-head">
        <h1>Account</h1>
        <p className="muted">{displayName}</p>
      </header>

      {profile.status !== "ACTIVE" ? (
        <p className="notice error">{STATUS_EXPLANATION[profile.status]}</p>
      ) : null}

      <section className="card">
        <h2>Details</h2>
        <table className="statement">
          <tbody>
            <tr>
              <td className="muted">Email</td>
              <td className="right">
                {profile.email}{" "}
                <span className={profile.emailVerified ? "pill ok" : "pill warning"}>
                  {profile.emailVerified ? "Verified" : "Unverified"}
                </span>
              </td>
            </tr>
            <tr>
              <td className="muted">Phone</td>
              <td className="right">
                {profile.phoneNumber ? maskPhone(profile.phoneNumber) : "Not added"}{" "}
                {profile.phoneNumber ? (
                  <span className={profile.phoneVerified ? "pill ok" : "pill warning"}>
                    {profile.phoneVerified ? "Verified" : "Unverified"}
                  </span>
                ) : null}
              </td>
            </tr>
            {profile.username ? (
              <tr>
                <td className="muted">Username</td>
                <td className="right">{profile.username}</td>
              </tr>
            ) : null}
            <tr>
              <td className="muted">Date of birth</td>
              <td className="right">
                {profile.dateOfBirth ? (
                  new Date(profile.dateOfBirth).toLocaleDateString("en-NG", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })
                ) : (
                  <span className="pill warning">Not on file</span>
                )}
              </td>
            </tr>
            <tr>
              <td className="muted">Verification</td>
              <td className="right">
                <span className={profile.kycLevel >= 1 ? "pill ok" : "pill warning"}>
                  {TIER_LABEL[profile.kycLevel] ?? `Tier ${profile.kycLevel}`}
                </span>
              </td>
            </tr>
            <tr>
              <td className="muted">Status</td>
              <td className="right">
                <span className={profile.status === "ACTIVE" ? "pill ok" : "pill critical"}>
                  {profile.status.replace(/_/g, " ")}
                </span>
              </td>
            </tr>
            <tr>
              <td className="muted">Member since</td>
              <td className="right">
                {profile.createdAt.toLocaleDateString("en-NG", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {!profile.dateOfBirth ? (
        <section className="card">
          <h2>Date of birth missing</h2>
          <p className="muted small">
            This account was created before we recorded dates of birth. We are legally required to
            confirm every account holder is 18 or over, so please contact support to add it.
          </p>
        </section>
      ) : null}

      {profile.kycLevel === 0 ? (
        <section className="card">
          <h2>Verify to withdraw</h2>
          <p className="muted small">
            Unverified accounts cannot withdraw. Confirming your BVN or NIN takes a minute and
            unlocks cash-out up to ₦50,000 a day.
          </p>
          <Link href={UTILITY_ROUTES.verify} className="btn primary">
            Verify identity
          </Link>
        </section>
      ) : null}

      {profile.referralCode ? (
        <section className="card">
          <h2>Invite a friend</h2>
          <p className="muted small">Share your code. Rewards arrive with promotions in phase 14.</p>
          <p className="account-number">{profile.referralCode}</p>
        </section>
      ) : null}

      <section className="section">
        <div className="section-head">
          <h2>Manage</h2>
        </div>
        <div className="tile-row">
          <Link href="/account/security" className="tile">
            <span className="ico" aria-hidden="true">🔒</span>
            Security
          </Link>
          <Link href="/account/preferences" className="tile">
            <span className="ico" aria-hidden="true">⚙️</span>
            Preferences
          </Link>
          <Link href="/wallet" className="tile">
            <span className="ico" aria-hidden="true">👛</span>
            Wallet
          </Link>
          <Link href="/bets" className="tile">
            <span className="ico" aria-hidden="true">🎫</span>
            My Bets
          </Link>
          <Link href={UTILITY_ROUTES.deposit} className="tile">
            <span className="ico" aria-hidden="true">➕</span>
            Deposit
          </Link>
          <Link href={UTILITY_ROUTES.withdraw} className="tile">
            <span className="ico" aria-hidden="true">➖</span>
            Withdraw
          </Link>
          <Link href={UTILITY_ROUTES.verify} className="tile">
            <span className="ico" aria-hidden="true">🪪</span>
            Verification
          </Link>
          <Link href={UTILITY_ROUTES.responsible} className="tile">
            <span className="ico" aria-hidden="true">🛡️</span>
            Limits
          </Link>
        </div>
      </section>

      <p style={{ margin: "8px 0 40px" }}>
        <Link href={UTILITY_ROUTES.signOut} className="btn ghost">
          Sign out
        </Link>
      </p>
    </>
  );
}
