import Link from "next/link";
import {
  BadgeCheck,
  CreditCard,
  HelpCircle,
  KeyRound,
  ReceiptText,
  ShieldCheck,
  Ticket,
} from "lucide-react";
import { PageShell } from "@/components/sportsbook/page-shell";

export const metadata = {
  title: "Help & Support",
  description:
    "Answers to common questions about deposits, withdrawals, KYC verification, booking codes, cash-out, and account safety on PlutoBet.",
};

const FAQS = [
  {
    q: "How do I deposit Naira into my PlutoBet wallet?",
    a: "Sign in and open Deposit to view your permanent dedicated bank account number (NUBAN). Transfer from any Nigerian bank app or USSD rail using an account in your own name — funds credit automatically once confirmed by the payment rail.",
  },
  {
    q: "Why do I need to verify my identity before withdrawing?",
    a: "Anti-money-laundering (AML) rules prohibit paying out cash to unverified accounts. Open Verification (KYC) in your Account menu to verify your identity and unlock Tier 1 (₦50,000/day), Tier 2 (₦500,000/day), or Tier 3 (₦5,000,000/day) payout caps.",
  },
  {
    q: "How do Booking Codes work?",
    a: "Build your selections in the betslip and tap Book / Share Code to generate a short code. Anyone can enter that code into their betslip to load the exact same selections immediately at current live prices.",
  },
  {
    q: "How does Cash-Out work?",
    a: "When you have an eligible open ticket and live market pricing is active, a Cash-Out quote appears on your ticket under My Bets. Accepting the quote settles your bet early and credits the payout directly to your cash wallet.",
  },
  {
    q: "Why was my bet rejected when odds changed?",
    a: "PlutoBet defaults to strict price protection: if an odd moves before your ticket is confirmed, we reject the submission so you never get locked into a lower price without agreeing. You can adjust this preference in Account settings.",
  },
  {
    q: "How do I set a deposit limit or self-exclude?",
    a: "Visit the Safer Gambling page at any time. Lowering a deposit, loss, or wager limit takes effect immediately. Self-exclusion locks the account immediately and cannot be lifted early.",
  },
];

export default function SupportPage() {
  return (
    <PageShell
      title="Help & Support"
      sub="Quick answers, account recovery tools, and transparent guides for betting and payments."
      back={{ href: "/", label: "Home" }}
      width="narrow"
    >
      <div className="sb-stack-3">
        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <HelpCircle size={18} aria-hidden="true" />
            <h2>Quick self-service links</h2>
          </div>
          <div className="sb-trust-quickgrid">
            <Link href="/payments" className="sb-trust-quicklink">
              <CreditCard size={16} aria-hidden="true" />
              <div>
                <strong>Payments &amp; Limits</strong>
                <span className="sb-xs sb-muted">Naira rails &amp; KYC caps</span>
              </div>
            </Link>
            <Link href="/kyc" className="sb-trust-quicklink">
              <BadgeCheck size={16} aria-hidden="true" />
              <div>
                <strong>Verify Identity (KYC)</strong>
                <span className="sb-xs sb-muted">Unlock withdrawals</span>
              </div>
            </Link>
            <Link href="/bets" className="sb-trust-quicklink">
              <ReceiptText size={16} aria-hidden="true" />
              <div>
                <strong>My Bets &amp; Cash-Out</strong>
                <span className="sb-xs sb-muted">Check open &amp; settled slips</span>
              </div>
            </Link>
            <Link href="/responsible" className="sb-trust-quicklink">
              <ShieldCheck size={16} aria-hidden="true" />
              <div>
                <strong>Safer Gambling</strong>
                <span className="sb-xs sb-muted">Limits &amp; self-exclusion</span>
              </div>
            </Link>
            <Link href="/forgot-password" className="sb-trust-quicklink">
              <KeyRound size={16} aria-hidden="true" />
              <div>
                <strong>Reset Password</strong>
                <span className="sb-xs sb-muted">Recover account access</span>
              </div>
            </Link>
            <Link href="/terms" className="sb-trust-quicklink">
              <Ticket size={16} aria-hidden="true" />
              <div>
                <strong>Betting Rules &amp; Terms</strong>
                <span className="sb-xs sb-muted">Settlement &amp; void rules</span>
              </div>
            </Link>
          </div>
        </section>

        <section className="sb-panel sb-pad sb-stack">
          <h2>Frequently asked questions</h2>
          <div className="sb-faq-list">
            {FAQS.map((item) => (
              <details key={item.q} className="sb-faq-item">
                <summary>{item.q}</summary>
                <p className="sb-small sb-muted">{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="sb-panel sb-pad sb-stack">
          <h2>Disputes &amp; ticket checks</h2>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            When raising a query about a deposit, withdrawal, or settled ticket, keep your{" "}
            <strong>ticket ID</strong> or <strong>transaction reference</strong> from{" "}
            <Link href="/wallet" className="sb-footer__cta">
              Wallet
            </Link>{" "}
            ready. Dedicated live support channels (email desk and WhatsApp/live chat) will be
            published here as soon as customer operations go live on the production domain.
          </p>
        </section>
      </div>
    </PageShell>
  );
}
