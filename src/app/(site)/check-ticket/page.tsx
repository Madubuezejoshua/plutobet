import Link from "next/link";
import { PageShell } from "@/components/sportsbook/page-shell";
import { QuickCodeBar } from "@/components/sportsbook/quick-code-bar";

export const metadata = {
  title: "Check Ticket & Load Booking Code — PlutoBet",
  description:
    "Verify any PlutoBet ticket reference or load a shared booking code straight into your betslip.",
};

export default function CheckTicketPage() {
  return (
    <PageShell
      title="Check Ticket & Booking Codes"
      sub="Verify a bet ticket reference or load a shared booking code at live odds."
    >
      <div className="sb-stack" style={{ gap: "var(--sb-4)" }}>
        <QuickCodeBar defaultMode="ticket" />

        <section className="sb-panel sb-pad sb-stack">
          <h2 className="sb-panel__title" style={{ margin: 0 }}>
            How it works
          </h2>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            <strong>Load Code</strong> pulls a friend&apos;s saved selections directly into your
            betslip at current live prices — you pick your own stake before placing.
          </p>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            <strong>Check Ticket</strong> verifies any placed bet using the first 8+ characters of
            its reference ID, showing leg-by-leg outcomes without exposing any personal account
            details.
          </p>
          <div>
            <Link href="/sports" className="sb-btn sb-btn--ghost">
              Back to Sportsboard
            </Link>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
