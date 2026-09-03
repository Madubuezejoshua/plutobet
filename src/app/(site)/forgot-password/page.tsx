import Link from "next/link";
import { KeyRound, MailCheck, ShieldOff } from "lucide-react";
import { ResetForm } from "./reset-form";

/**
 * Password reset.
 *
 * Same two-panel auth layout as sign-in and registration, so the three pages a
 * signed-out customer can reach look like one product rather than three.
 */

export const metadata = {
  title: "Reset your password",
  description: "Reset the password on your PlutoBet account.",
};

export default function ForgotPasswordPage() {
  return (
    <div className="sb-auth">
      <aside className="sb-auth__aside">
        <div className="sb-auth__asideinner">
          <p className="sb-auth__lede">Locked out? This takes a minute.</p>
          <ul className="sb-auth__points">
            <li className="sb-auth__point">
              <MailCheck size={18} aria-hidden="true" />
              <span>
                <strong className="sb-auth__pointtitle">A code to your email</strong>
                Six digits, valid briefly. We give the same answer whether or not the address has an
                account — that is on purpose.
              </span>
            </li>
            <li className="sb-auth__point">
              <KeyRound size={18} aria-hidden="true" />
              <span>
                <strong className="sb-auth__pointtitle">Choose a new password</strong>
                At least ten characters. A long phrase beats a short one with symbols in it.
              </span>
            </li>
            <li className="sb-auth__point">
              <ShieldOff size={18} aria-hidden="true" />
              <span>
                <strong className="sb-auth__pointtitle">Every device signed out</strong>
                Resetting ends all existing sessions, so anyone who had your old password loses
                access immediately.
              </span>
            </li>
          </ul>
        </div>
      </aside>

      <main className="sb-auth__main">
        <div className="sb-auth__card">
          <h1 className="sb-auth__title">Reset your password</h1>
          <p className="sb-auth__sub">We will email you a code.</p>

          <ResetForm />

          <p className="sb-auth__foot">
            Remembered it? <Link href="/signin">Sign in</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
