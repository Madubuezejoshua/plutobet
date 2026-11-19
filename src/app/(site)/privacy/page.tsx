import Link from "next/link";
import { Database, Eye, Lock, ShieldCheck } from "lucide-react";
import { PageShell } from "@/components/sportsbook/page-shell";

export const metadata = {
  title: "Privacy Policy",
  description:
    "How PlutoBet collects, protects, retains, and processes player data in line with Nigerian data protection standards.",
};

export default function PrivacyPage() {
  return (
    <PageShell
      title="Privacy Policy"
      sub="How PlutoBet handles your personal, identity, and financial information."
      back={{ href: "/", label: "Home" }}
      width="narrow"
    >
      <div className="sb-stack-3">
        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <Database size={18} aria-hidden="true" />
            <h2>1. Information We Collect</h2>
          </div>
          <ul className="sb-trust-list">
            <li>
              <strong>Account &amp; contact details:</strong> Phone number, email address, display
              name, and date of birth (required for 18+ age verification).
            </li>
            <li>
              <strong>Identity verification (KYC):</strong> BVN/NIN verification inputs and
              government-issued ID documents submitted when upgrading your withdrawal tier.
            </li>
            <li>
              <strong>Payment &amp; ledger records:</strong> Dedicated virtual account references,
              verified Nigerian bank account numbers/names used for payouts, and complete wallet and
              bet transaction logs.
            </li>
            <li>
              <strong>Security &amp; device telemetry:</strong> IP address, login timestamps, and
              session metadata used to protect accounts against unauthorised access and fraud.
            </li>
          </ul>
        </section>

        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <Eye size={18} aria-hidden="true" />
            <h2>2. Why We Process Your Data</h2>
          </div>
          <ul className="sb-trust-list">
            <li>To verify you are 18 or older and prevent underage gambling.</li>
            <li>
              To process Naira deposits, resolve payout bank accounts, and enforce KYC/AML
              anti-money-laundering controls.
            </li>
            <li>
              To price, accept, settle, and audit your bets, cash-outs, and promotional rewards.
            </li>
            <li>
              To enforce your safer-gambling deposit/loss/wager limits, cool-offs, and
              self-exclusion requests.
            </li>
          </ul>
        </section>

        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <Lock size={18} aria-hidden="true" />
            <h2>3. Security, Storage &amp; Third Parties</h2>
          </div>
          <ul className="sb-trust-list">
            <li>
              <strong>Credential security:</strong> Passwords are hashed using Argon2 and are never
              stored or readable in plain text.
            </li>
            <li>
              <strong>Access controls:</strong> Administrative compliance and KYC views are isolated
              behind role-based access controls and every staff action writes to an append-only
              audit log.
            </li>
            <li>
              <strong>Service processors:</strong> We share only the minimum data necessary with
              regulated payment rails (such as Paystack for bank transfers and account resolution),
              identity verification providers, and hosting/infrastructure providers. We do not sell
              player data to third-party advertisers.
            </li>
          </ul>
        </section>

        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <ShieldCheck size={18} aria-hidden="true" />
            <h2>4. Retention, Cookies &amp; Your Rights</h2>
          </div>
          <ul className="sb-trust-list">
            <li>
              <strong>Cookies &amp; local storage:</strong> Used strictly for authenticated
              sessions, theme preference (dark/light), and keeping your active betslip selections on
              your device.
            </li>
            <li>
              <strong>Retention:</strong> Financial ledger entries, bet records, and KYC records are
              retained for the statutory period required by Nigerian financial, AML/SCUML, and
              gaming regulations even after account closure.
            </li>
            <li>
              <strong>Your rights:</strong> In line with the Nigeria Data Protection Act (NDPA), you
              may request access to your personal data, correction of inaccurate profile fields, or
              account closure (subject to statutory record-keeping duties). See{" "}
              <Link href="/support" className="sb-footer__cta">
                Help &amp; Support
              </Link>{" "}
              for assistance.
            </li>
          </ul>
        </section>
      </div>
    </PageShell>
  );
}
