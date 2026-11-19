import Link from "next/link";
import { FileText, Scale, ShieldCheck } from "lucide-react";
import { PageShell } from "@/components/sportsbook/page-shell";
import { naira } from "@/lib/money";
import { DEFAULT_PLACEMENT_CONFIG } from "@/modules/betting/placement.service";
import { DEFAULT_WITHDRAWAL_LIMITS } from "@/modules/payments/withdrawal.service";

export const metadata = {
  title: "Terms of Service",
  description:
    "PlutoBet Terms of Service, eligibility rules, bet acceptance, settlement, cash-out, bonus terms, and safer gambling obligations.",
};

export default function TermsPage() {
  return (
    <PageShell
      title="Terms of Service & Betting Rules"
      sub="Clear, plain-language rules governing account use, deposits, bet placement, settlement, and withdrawals on PlutoBet."
      back={{ href: "/", label: "Home" }}
      width="narrow"
    >
      <div className="sb-stack-3">
        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <FileText size={18} aria-hidden="true" />
            <h2>1. Eligibility &amp; Account Registration</h2>
          </div>
          <ul className="sb-trust-list">
            <li>
              <strong>Minimum age (18+):</strong> You must be at least 18 years old to register,
              deposit, or place a bet. We require your date of birth and reserve the right to
              verify identity at any time.
            </li>
            <li>
              <strong>One account per person:</strong> Customers may hold only one PlutoBet account.
              Duplicate accounts created to evade limits, self-exclusion, or promotional caps may be
              suspended.
            </li>
            <li>
              <strong>Accurate details:</strong> Registration and KYC information must match your
              legal identity and the bank accounts you use to deposit and withdraw.
            </li>
          </ul>
        </section>

        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <Scale size={18} aria-hidden="true" />
            <h2>2. Deposits, Withdrawals &amp; KYC Verification</h2>
          </div>
          <ul className="sb-trust-list">
            <li>
              All balances, stakes, and payouts are denominated in Nigerian Naira (₦).
            </li>
            <li>
              Deposits must originate from a bank account in your own name. Third-party transfers
              are not permitted.
            </li>
            <li>
              Identity verification (KYC Tier 1 or higher) is mandatory before any withdrawal can be
              processed. Minimum withdrawal is{" "}
              <strong className="sb-num">{naira(DEFAULT_WITHDRAWAL_LIMITS.minWithdrawalMinor)}</strong>
              , subject to rolling 24-hour KYC tier limits detailed on our{" "}
              <Link href="/payments" className="sb-footer__cta">
                Payments &amp; Limits
              </Link>{" "}
              page.
            </li>
            <li>
              Only settled <strong>cash balances</strong> may be withdrawn. Promotional bonus funds
              remain locked until stated wagering requirements are fulfilled.
            </li>
          </ul>
        </section>

        <section className="sb-panel sb-pad sb-stack">
          <h2>3. Placing Bets, Odds Changes &amp; Limits</h2>
          <ul className="sb-trust-list">
            <li>
              <strong>Stake limits:</strong> Minimum stake is{" "}
              <strong className="sb-num">{naira(DEFAULT_PLACEMENT_CONFIG.minStakeMinor)}</strong> and
              maximum single stake is{" "}
              <strong className="sb-num">{naira(DEFAULT_PLACEMENT_CONFIG.maxStakeMinor)}</strong>,
              subject to market and per-account open exposure ceilings.
            </li>
            <li>
              <strong>Odds drift policy:</strong> By default, if a price moves between viewing a
              selection and submitting your slip, the bet is rejected so you can review the updated
              odds before confirming. You may adjust your odds-change preference inside account
              settings.
            </li>
            <li>
              <strong>Binding confirmation:</strong> A bet is valid only once accepted by the server
              and issued a ticket ID in{" "}
              <Link href="/bets" className="sb-footer__cta">
                My Bets
              </Link>
              . Booking codes share selections only and do not lock odds until placed.
            </li>
          </ul>
        </section>

        <section className="sb-panel sb-pad sb-stack">
          <h2>4. Settlement, Voids &amp; Cash-Out</h2>
          <ul className="sb-trust-list">
            <li>
              <strong>Official results:</strong> Markets are settled based on official match results
              for regular time (including stoppage time) unless a market explicitly states extra
              time or penalties.
            </li>
            <li>
              <strong>Postponed or abandoned events:</strong> Selections on voided events are
              settled at odds of 1.00 (single stakes refunded; accumulators recalculate on remaining
              legs).
            </li>
            <li>
              <strong>Cash-Out:</strong> Early cash-out is offered on eligible open bets when live
              pricing is available. Cash-out is not guaranteed on every fixture or at all times
              during a match, and once confirmed it is final.
            </li>
          </ul>
        </section>

        <section className="sb-panel sb-pad sb-stack">
          <h2>5. Promotions, Fair Use &amp; Integrity</h2>
          <ul className="sb-trust-list">
            <li>
              Each promotion displays its wagering multiplier, minimum odds, and expiry rules before
              opt-in on the{" "}
              <Link href="/promotions" className="sb-footer__cta">
                Promotions
              </Link>{" "}
              page.
            </li>
            <li>
              We reserve the right to void obvious palpable pricing errors, suspend accounts linked
              to fraud, chargebacks, or collusion, and report suspicious activity as required by
              applicable AML regulations.
            </li>
          </ul>
        </section>

        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <ShieldCheck size={18} aria-hidden="true" />
            <h2>6. Safer Gambling &amp; Disputes</h2>
          </div>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            You may set deposit, loss, and wager limits, initiate a cool-off break, or self-exclude
            at any time on our{" "}
            <Link href="/responsible" className="sb-footer__cta">
              Safer Gambling
            </Link>{" "}
            page. For ticket queries or account disputes, review our{" "}
            <Link href="/support" className="sb-footer__cta">
              Help &amp; Support
            </Link>{" "}
            guidance.
          </p>
        </section>
      </div>
    </PageShell>
  );
}
