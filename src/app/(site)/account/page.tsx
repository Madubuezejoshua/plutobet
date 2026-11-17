import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import {
  ArrowDownToLine, ArrowUpFromLine, BadgeCheck, Gift, LogOut, Lock,
  ShieldCheck, SlidersHorizontal, Ticket, Wallet,
} from "lucide-react";
import { authOptions } from "@/modules/auth/auth-options";
import { UTILITY_ROUTES } from "@/lib/navigation";
import { profileService } from "@/modules/users/profile.service";
import { maskPhone } from "@/modules/notifications/phone";
import type { UserStatus } from "@/modules/users/schema";
import { PageShell } from "@/components/sportsbook/page-shell";
import { VerifyEmail } from "./verify-email";

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

const MANAGE = [
  { href: "/account/security", label: "Security", sub: "Password, devices, sessions", Icon: Lock },
  { href: "/account/preferences", label: "Preferences", sub: "Odds format, notifications", Icon: SlidersHorizontal },
  { href: "/wallet", label: "Wallet", sub: "Balance and statement", Icon: Wallet },
  { href: "/bets", label: "My bets", sub: "Open and settled tickets", Icon: Ticket },
  { href: UTILITY_ROUTES.deposit, label: "Deposit", sub: "Your dedicated account number", Icon: ArrowDownToLine },
  { href: UTILITY_ROUTES.withdraw, label: "Withdraw", sub: "Cash out to your bank", Icon: ArrowUpFromLine },
  { href: UTILITY_ROUTES.verify, label: "Verification", sub: "BVN, NIN and documents", Icon: BadgeCheck },
  { href: UTILITY_ROUTES.responsible, label: "Safer gambling", sub: "Limits and self-exclusion", Icon: ShieldCheck },
  { href: "/referrals", label: "Invite friends", sub: "Your code and what it pays", Icon: Gift },
];

export default async function AccountPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect(`${UTILITY_ROUTES.signIn}?callbackUrl=%2Faccount`);

  const profile = await profileService.get(session.user.id);
  const displayName =
    [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
    profile.username ||
    profile.email;

  return (
    <PageShell title="Account" sub={displayName}>
      {profile.status !== "ACTIVE" ? (
        <p className="sb-note sb-note--error" role="alert" style={{ marginBottom: "var(--sb-3)" }}>
          {STATUS_EXPLANATION[profile.status]}
        </p>
      ) : null}

      <section className="sb-panel" style={{ marginBottom: "var(--sb-3)" }}>
        <div className="sb-panel__head"><h2 className="sb-panel__title">Details</h2></div>
        <table className="sb-table">
          <tbody>
            <tr>
              <td className="sb-muted">Email</td>
              <td className="sb-table__num">
                {profile.email}{" "}
                <span className={profile.emailVerified ? "sb-pill sb-pill--won" : "sb-pill sb-pill--void"}>
                  {profile.emailVerified ? "Verified" : "Unverified"}
                </span>
                <VerifyEmail verified={profile.emailVerified} />
              </td>
            </tr>
            <tr>
              <td className="sb-muted">Phone</td>
              <td className="sb-table__num">
                {profile.phoneNumber ? maskPhone(profile.phoneNumber) : "Not added"}{" "}
                {profile.phoneNumber ? (
                  <span className={profile.phoneVerified ? "sb-pill sb-pill--won" : "sb-pill sb-pill--void"}>
                    {profile.phoneVerified ? "Verified" : "Unverified"}
                  </span>
                ) : null}
              </td>
            </tr>
            {profile.username ? (
              <tr>
                <td className="sb-muted">Username</td>
                <td className="sb-table__num">{profile.username}</td>
              </tr>
            ) : null}
            <tr>
              <td className="sb-muted">Date of birth</td>
              <td className="sb-table__num">
                {profile.dateOfBirth ? (
                  new Date(profile.dateOfBirth).toLocaleDateString("en-NG", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })
                ) : (
                  <span className="sb-pill sb-pill--void">Not on file</span>
                )}
              </td>
            </tr>
            <tr>
              <td className="sb-muted">Verification</td>
              <td className="sb-table__num">
                <span className={profile.kycLevel >= 1 ? "sb-pill sb-pill--won" : "sb-pill sb-pill--void"}>
                  {TIER_LABEL[profile.kycLevel] ?? `Tier ${profile.kycLevel}`}
                </span>
              </td>
            </tr>
            <tr>
              <td className="sb-muted">Status</td>
              <td className="sb-table__num">
                <span className={profile.status === "ACTIVE" ? "sb-pill sb-pill--won" : "sb-pill sb-pill--lost"}>
                  {profile.status.replace(/_/g, " ")}
                </span>
              </td>
            </tr>
            <tr>
              <td className="sb-muted">Member since</td>
              <td className="sb-table__num">
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
        <section className="sb-panel sb-pad" style={{ marginBottom: "var(--sb-3)" }}>
          <h2 className="sb-panel__title">Date of birth missing</h2>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            This account was created before we recorded dates of birth. We are legally required to
            confirm every account holder is 18 or over, so please contact support to add it.
          </p>
        </section>
      ) : null}

      {profile.kycLevel === 0 ? (
        <section className="sb-panel sb-pad sb-stack" style={{ marginBottom: "var(--sb-3)" }}>
          <h2 className="sb-panel__title">Verify to withdraw</h2>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            Unverified accounts cannot withdraw. Confirming your BVN or NIN takes a minute and
            unlocks cash-out up to ₦50,000 a day.
          </p>
          <Link href={UTILITY_ROUTES.verify} className="sb-btn sb-btn--primary">
            Verify identity
          </Link>
        </section>
      ) : null}

      <section className="sb-panel sb-pad" style={{ marginBottom: "var(--sb-3)" }}>
        <h2 className="sb-panel__title" style={{ marginBottom: "var(--sb-3)" }}>Manage</h2>
        <div className="sb-tiles">
          {MANAGE.map(({ href, label, sub, Icon }) => (
            <Link key={href} href={href} className="sb-tile">
              <Icon size={18} className="sb-tile__icon" aria-hidden="true" />
              <span>
                <span className="sb-tile__title">{label}</span>
                <span className="sb-tile__sub">{sub}</span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <p style={{ margin: 0 }}>
        <Link href={UTILITY_ROUTES.signOut} className="sb-btn sb-btn--ghost">
          <LogOut size={15} aria-hidden="true" /> Sign out
        </Link>
      </p>
    </PageShell>
  );
}
