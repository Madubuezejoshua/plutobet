import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { BadgeCheck, Smartphone, Wallet } from "lucide-react";
import { authOptions } from "@/modules/auth/auth-options";
import { RegisterForm } from "./register-form";

/**
 * Registration.
 *
 * The layout is balanced rather than a single narrow column on a wide empty
 * page: a supporting panel that says what an account is for, and the form.
 * Below 860px the supporting panel is dropped by CSS — on a phone it is only
 * distance between the customer and the first field.
 *
 * The FLOW is unchanged: phone first, then account. Every validation that was
 * enforced before is enforced now, in the same three places (the browser as a
 * courtesy, the registration service as a refusal, the database trigger as the
 * control that counts).
 */

export const metadata = {
  title: "Create an account",
  description: "Open a PlutoBet account. You must be 18 or over.",
};

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string }>;
}) {
  const params = await searchParams;
  // Accepted from the link a friend shared. Validated server-side at
  // registration; an unrecognised code records no referrer rather than
  // failing the signup.
  const referralCode = params.ref?.trim().toUpperCase().slice(0, 20);

  const session = await getServerSession(authOptions);
  if (session?.user) redirect("/sports");

  return (
    <div className="sb-auth">
      <aside className="sb-auth__aside">
        <div className="sb-auth__asideinner">
          <p className="sb-auth__lede">Open an account in two steps.</p>
          <ul className="sb-auth__points">
            <li className="sb-auth__point">
              <Smartphone size={18} aria-hidden="true" />
              <span>
                <strong className="sb-auth__pointtitle">Verify your phone first</strong>
                We text a six-digit code before the account is created, so a number that cannot be
                reached never becomes an account.
              </span>
            </li>
            <li className="sb-auth__point">
              <Wallet size={18} aria-hidden="true" />
              <span>
                <strong className="sb-auth__pointtitle">Deposit and withdraw in naira</strong>
                Bank transfer and card through Paystack. Withdrawals go to an account in your own
                name.
              </span>
            </li>
            <li className="sb-auth__point">
              <BadgeCheck size={18} aria-hidden="true" />
              <span>
                <strong className="sb-auth__pointtitle">18 and over only</strong>
                Your date of birth is checked when you register and again by the database. There is
                no way around it, and that is deliberate.
              </span>
            </li>
          </ul>
        </div>
      </aside>

      <main className="sb-auth__main">
        <div className="sb-auth__card sb-auth__card--wide">
          <h1 className="sb-auth__title">Create your account</h1>
          <p className="sb-auth__sub">You must be 18 or over to open an account.</p>

          <RegisterForm referralCode={referralCode} />

          <p className="sb-auth__foot">
            Already have an account? <Link href="/signin">Sign in</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
