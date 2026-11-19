import Link from "next/link";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BadgeCheck,
  Building2,
  Clock,
  ShieldAlert,
  Wallet,
} from "lucide-react";
import { PageShell } from "@/components/sportsbook/page-shell";
import { naira } from "@/lib/money";
import { DEFAULT_WITHDRAWAL_LIMITS } from "@/modules/payments/withdrawal.service";
import { DEFAULT_PLACEMENT_CONFIG } from "@/modules/betting/placement.service";

export const metadata = {
  title: "Payments & limits",
  description:
    "Naira deposit methods, Paystack dedicated bank transfer accounts, withdrawal caps by KYC tier, and stake limits on PlutoBet.",
};

const KYC_TIERS = [
  {
    tier: "Tier 0 — Unverified",
    requirements: "Phone / email registration only",
    dailyWithdrawal: "Not permitted (verification required)",
    note: "AML rules prohibit cash-outs before identity verification.",
  },
  {
    tier: "Tier 1 — Basic KYC",
    requirements: "Verified date of birth + BVN / NIN identity check",
    dailyWithdrawal: naira(DEFAULT_WITHDRAWAL_LIMITS.dailyCapMinor[1] ?? 0n),
    note: "Rolling 24-hour bank payout cap.",
  },
  {
    tier: "Tier 2 — Standard KYC",
    requirements: "Government-issued ID document review approved",
    dailyWithdrawal: naira(DEFAULT_WITHDRAWAL_LIMITS.dailyCapMinor[2] ?? 0n),
    note: "Rolling 24-hour bank payout cap.",
  },
  {
    tier: "Tier 3 — Enhanced KYC",
    requirements: "Enhanced due diligence & proof of address approved",
    dailyWithdrawal: naira(DEFAULT_WITHDRAWAL_LIMITS.dailyCapMinor[3] ?? 0n),
    note: "Rolling 24-hour bank payout cap.",
  },
];

export default function PaymentsPage() {
  return (
    <PageShell
      title="Payments & limits"
      sub="All PlutoBet accounts operate in Nigerian Naira (₦). Every figure below comes straight from our live wallet and betting limits."
      back={{ href: "/", label: "Home" }}
      width="narrow"
    >
      <div className="sb-stack-3">
        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <ArrowDownToLine size={18} aria-hidden="true" />
            <h2>Deposits (Nigerian Naira)</h2>
          </div>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            PlutoBet uses dedicated permanent virtual bank accounts (NUBAN) powered via Paystack so
            you can transfer directly from any Nigerian bank app, fintech wallet, or USSD rail
            without entering card details.
          </p>
          <dl className="sb-trust-dl">
            <div className="sb-total">
              <dt>Primary rail</dt>
              <dd>Bank transfer to your personal NUBAN (Paystack)</dd>
            </div>
            <div className="sb-total">
              <dt>PlutoBet deposit fee</dt>
              <dd>₦0 (standard bank transfer charges may apply)</dd>
            </div>
            <div className="sb-total">
              <dt>Typical crediting time</dt>
              <dd>Automatic on webhook confirmation (usually 1–3 minutes)</dd>
            </div>
            <div className="sb-total">
              <dt>Third-party transfers</dt>
              <dd>Not accepted — sender name must match account holder</dd>
            </div>
          </dl>
          <p className="sb-note sb-note--warn">
            <ShieldAlert size={14} aria-hidden="true" />
            Only transfer from a bank account held in your own legal name. Third-party deposits
            cannot be credited and are flagged for return.
          </p>
        </section>

        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <ArrowUpFromLine size={18} aria-hidden="true" />
            <h2>Withdrawals &amp; KYC tier limits</h2>
          </div>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            Withdrawals are paid directly to a verified Nigerian bank account resolved in your name.
            Only settled <strong>cash balances</strong> are withdrawable — bonus funds carry
            wagering conditions until converted.
          </p>

          <dl className="sb-trust-dl">
            <div className="sb-total">
              <dt>Minimum withdrawal</dt>
              <dd className="sb-num">{naira(DEFAULT_WITHDRAWAL_LIMITS.minWithdrawalMinor)}</dd>
            </div>
            <div className="sb-total">
              <dt>Funds reservation</dt>
              <dd>Held at request time; auto-refunded if a transfer fails or is rejected</dd>
            </div>
            <div className="sb-total">
              <dt>Verification check</dt>
              <dd>Mandatory before first cash-out (KYC Tier 1+)</dd>
            </div>
          </dl>

          <div className="sb-trust-tablewrap">
            <table className="sb-trust-table">
              <thead>
                <tr>
                  <th>KYC Tier</th>
                  <th>Requirement</th>
                  <th>24h Withdrawal Cap</th>
                </tr>
              </thead>
              <tbody>
                {KYC_TIERS.map((row) => (
                  <tr key={row.tier}>
                    <td>
                      <strong>{row.tier}</strong>
                    </td>
                    <td>{row.requirements}</td>
                    <td className="sb-num">{row.dailyWithdrawal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <Wallet size={18} aria-hidden="true" />
            <h2>Staking &amp; exposure rules</h2>
          </div>
          <dl className="sb-trust-dl">
            <div className="sb-total">
              <dt>Minimum stake</dt>
              <dd className="sb-num">{naira(DEFAULT_PLACEMENT_CONFIG.minStakeMinor)}</dd>
            </div>
            <div className="sb-total">
              <dt>Maximum single stake</dt>
              <dd className="sb-num">{naira(DEFAULT_PLACEMENT_CONFIG.maxStakeMinor)}</dd>
            </div>
            <div className="sb-total">
              <dt>Max open liability per account</dt>
              <dd className="sb-num">{naira(DEFAULT_PLACEMENT_CONFIG.maxUserExposureMinor)}</dd>
            </div>
            <div className="sb-total">
              <dt>Accounting integrity</dt>
              <dd>Double-entry immutable ledger with separate cash &amp; bonus buckets</dd>
            </div>
          </dl>
        </section>

        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <Building2 size={18} aria-hidden="true" />
            <h2>Merchant availability notice</h2>
          </div>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            <Clock size={14} aria-hidden="true" style={{ display: "inline", marginRight: 6 }} />
            Dedicated NUBAN issuing and automated Paystack bank payouts activate per environment
            only once live merchant credentials and regulatory onboarding are completed for that
            deployment.
          </p>
          <div className="sb-trust-actions">
            <Link href="/deposit" className="sb-btn sb-btn--primary">
              Go to Deposit
            </Link>
            <Link href="/kyc" className="sb-btn sb-btn--dark">
              <BadgeCheck size={15} aria-hidden="true" /> Verify Identity
            </Link>
            <Link href="/responsible" className="sb-btn sb-btn--ghost">
              Set Deposit Limits
            </Link>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
