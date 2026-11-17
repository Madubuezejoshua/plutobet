import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { ShieldCheck, Timer, Wallet } from "lucide-react";
import { authOptions } from "@/modules/auth/auth-options";
import { safeCallbackPath } from "@/lib/safe-redirect";
import { SignInForm } from "./signin-form";

/**
 * Sign in.
 *
 * This page exists because the product was previously sending customers to
 * NextAuth's built-in `/api/auth/signin` — an unbranded framework page with a
 * grey box on a white background. It is the first thing a returning customer
 * sees, and it looked like a different site.
 *
 * NOTHING about authentication itself changes here. The form posts through the
 * same credentials provider, the same `authorize()`, the same password
 * verification, the same status checks and the same session row. This is a
 * skin over an unchanged mechanism, which is the only kind of change worth
 * making to a sign-in flow.
 */

export const metadata = {
  title: "Sign in",
  description: "Sign in to your PlutoBet account.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const params = await searchParams;
  const callbackUrl = safeCallbackPath(params.callbackUrl);

  // Already signed in: send them where they were going rather than showing a
  // form that would sign them in as themselves again.
  const session = await getServerSession(authOptions);
  if (session?.user) redirect(callbackUrl);

  return (
    <div className="sb-auth">
      <aside className="sb-auth__aside">
        <div className="sb-auth__asideinner">
          <p className="sb-auth__lede">Welcome back.</p>
          <ul className="sb-auth__points">
            <li className="sb-auth__point">
              <Wallet size={18} aria-hidden="true" />
              <span>
                <strong className="sb-auth__pointtitle">Your balance, to the kobo</strong>
                Every credit and debit is a ledger entry you can read back in your wallet history.
              </span>
            </li>
            <li className="sb-auth__point">
              <Timer size={18} aria-hidden="true" />
              <span>
                <strong className="sb-auth__pointtitle">Settled from real results</strong>
                Bets settle from the match result feed, not by hand, and winnings are paid on
                settlement.
              </span>
            </li>
            <li className="sb-auth__point">
              <ShieldCheck size={18} aria-hidden="true" />
              <span>
                <strong className="sb-auth__pointtitle">Limits you control</strong>
                Deposit, loss and stake limits — and self-exclusion — take effect immediately.
              </span>
            </li>
          </ul>
        </div>
      </aside>

      <main className="sb-auth__main">
        <div className="sb-auth__card">
          <h1 className="sb-auth__title">Sign in</h1>
          <p className="sb-auth__sub">Use the email and password on your account.</p>

          <SignInForm callbackUrl={callbackUrl} initialError={params.error} />

          <p className="sb-auth__foot">
            New to PlutoBet? <Link href="/register">Create an account</Link>
          </p>
        </div>

        <p className="sb-legal" style={{ maxWidth: 400, textAlign: "center" }}>
          18+. Betting can be addictive.{" "}
          <Link href="/responsible">Set a limit or self-exclude</Link> at any time.
        </p>
      </main>
    </div>
  );
}
