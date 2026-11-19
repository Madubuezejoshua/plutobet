import Link from "next/link";
import { BookOpenCheck, Landmark, LockKeyhole, ShieldCheck, Smartphone, Ticket } from "lucide-react";
import { PageShell } from "@/components/sportsbook/page-shell";
import { PWAInstallButton } from "@/components/pwa/pwa-install-button";

export const metadata = {
  title: "About PlutoBet",
  description:
    "How PlutoBet is built: Naira-first sportsbook, audited double-entry wallet ledger, enforced safer gambling limits, and transparent regulatory status.",
};

export default function AboutPage() {
  return (
    <PageShell
      title="About PlutoBet"
      sub="A Naira-first sportsbook engineered around transparent odds, auditable accounting, and enforced player protections."
      back={{ href: "/", label: "Home" }}
      width="narrow"
    >
      <div className="sb-stack-3">
        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <Ticket size={18} aria-hidden="true" />
            <h2>What we are building</h2>
          </div>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            PlutoBet is designed for Nigerian and African sports fans who want fast mobile
            performance, clean markets across Football, Basketball, Tennis, Table Tennis, and
            Esports, shareable booking codes, early cash-out, and straightforward Naira bank
            transfers — without cluttered interfaces or hidden rules.
          </p>
        </section>

        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <LockKeyhole size={18} aria-hidden="true" />
            <h2>How the platform protects players</h2>
          </div>
          <div className="sb-trust-grid">
            <div className="sb-trust-card">
              <h3>Audited double-entry ledger</h3>
              <p className="sb-small sb-muted">
                Every Naira movement — deposits, stakes, cash-outs, wins, bonus conversions, and
                withdrawals — is written to an immutable ledger with separate cash and bonus
                buckets.
              </p>
            </div>
            <div className="sb-trust-card">
              <h3>Safer gambling on money paths</h3>
              <p className="sb-small sb-muted">
                Deposit, loss, and wager limits, cool-offs, and self-exclusion are enforced directly
                by the server transaction layer — not merely cosmetic UI toggles.
              </p>
            </div>
            <div className="sb-trust-card">
              <h3>Explicit price acceptance</h3>
              <p className="sb-small sb-muted">
                By default, if odds move before your bet is accepted, the slip rejects and prompts
                you to confirm the new price rather than silently accepting worse odds.
              </p>
            </div>
            <div className="sb-trust-card">
              <h3>Honest product labels</h3>
              <p className="sb-small sb-muted">
                Where a third-party vertical (such as a live casino studio or external aggregator)
                is not yet contracted, we state so plainly instead of publishing fake games.
              </p>
            </div>
          </div>
        </section>

        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <Landmark size={18} aria-hidden="true" />
            <h2>Regulatory &amp; licensing status</h2>
          </div>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            PlutoBet does <strong>not</strong> display a gambling licence number until a formal
            operating licence has been issued by the relevant gaming authority. Publishing an
            unverified or placeholder licence claim misleads players and violates regulatory
            standards. Corporate entity details and licence credentials will be published in this
            section and in the site footer as soon as licensing is granted.
          </p>
          <p className="sb-note" style={{ background: "var(--sb-surface-3)", color: "var(--sb-ink-2)" }}>
            <ShieldCheck size={14} aria-hidden="true" />
            18+ age enforcement, KYC identity checks, and safer-gambling controls are active in the
            platform from day one.
          </p>
        </section>

        <section className="sb-panel sb-pad sb-stack">
          <div className="sb-trust-head">
            <Smartphone size={18} aria-hidden="true" />
            <h2>Install PlutoBet on your phone</h2>
          </div>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            PlutoBet is installable as a Progressive Web App (PWA) on Android and iPhone so you can
            launch it directly from your home screen in full-screen mode with lightweight data usage.
          </p>
          <div className="sb-trust-actions">
            <PWAInstallButton variant="inline" />
            <Link href="/payments" className="sb-btn sb-btn--dark">
              Payments &amp; Limits
            </Link>
            <Link href="/terms" className="sb-btn sb-btn--ghost">
              <BookOpenCheck size={15} aria-hidden="true" /> Terms of Service
            </Link>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
