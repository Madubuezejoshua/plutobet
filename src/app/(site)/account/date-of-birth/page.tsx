import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { ShieldCheck } from "lucide-react";
import { authOptions } from "@/modules/auth/auth-options";
import { dateOfBirthService } from "@/modules/users/date-of-birth.service";
import { PageShell } from "@/components/sportsbook/page-shell";
import { DateOfBirthForm } from "./date-of-birth-form";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Confirm your date of birth",
  description: "Confirm your date of birth to continue using your PlutoBet account.",
};

/**
 * The one screen an account with no date of birth on file has to pass.
 *
 * Reached from the banner in the shell, and from the refusal message on any
 * money or wagering action. It is a normal page rather than a modal so it can
 * be linked to, bookmarked by a support agent, and read with a screen reader
 * without fighting a focus trap.
 *
 * An account that already has a date is sent to the account page instead of
 * being shown a form it must not use — the value is write-once.
 */
export default async function DateOfBirthPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/signin?callbackUrl=%2Faccount%2Fdate-of-birth");

  const missing = await dateOfBirthService.isMissing(session.user.id);
  if (!missing) redirect("/account");

  return (
    <PageShell
      title="Confirm your date of birth"
      sub="We need this before you can bet, deposit or withdraw."
      width="narrow"
    >
      <section className="sb-panel sb-pad sb-stack-3">
        <p className="sb-note" style={{ background: "var(--sb-surface-3)", color: "var(--sb-ink-2)" }}>
          <ShieldCheck size={15} aria-hidden="true" />
          <span>
            Your account was opened before we recorded dates of birth. We are required to confirm
            every account holder is 18 or over, so this is a one-time question.
          </span>
        </p>

        <DateOfBirthForm />
      </section>

      <p className="sb-legal">
        You can only enter this once, so please check it before you submit. If you make a mistake,
        contact support — we will not change it without a record of why.
      </p>
    </PageShell>
  );
}
