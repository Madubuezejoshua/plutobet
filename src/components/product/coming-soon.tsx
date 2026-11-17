import Link from "next/link";
import { Construction } from "lucide-react";
import { liveProducts, navItem } from "@/lib/navigation";
import { PageShell } from "@/components/sportsbook/page-shell";

/**
 * The placeholder shown for a product that has not been built yet.
 *
 * Empty pages, fake buttons and unmarked mock data are forbidden. The honest
 * alternative is this: say plainly that the product does not exist, say what
 * it is waiting on, and route the visitor to something that does work. No fake
 * game tiles, no dummy fixtures, no button that silently does nothing.
 *
 * WHAT CHANGED IN THE REDESIGN. This used to print "arrives in phase 13". A
 * build-phase number is an internal artefact: it means nothing to a customer,
 * and it reads as a delivery promise nobody has made. It is replaced with the
 * only two things a visitor can act on — that it is not available, and what
 * they can do instead.
 *
 * It reads its copy from the navigation registry, so a product's description
 * is written once and a status change here is a one-line edit there.
 *
 * INCLUDING THE REASON. This used to state one blocker for all three planned
 * products — "it needs a provider we have not connected" — which is true of a
 * streamed casino and a licensed draw, and false of Fantasy, which needs
 * building rather than connecting. Each product now carries its own reason in
 * the registry. A placeholder that reads as honest while giving a reason that
 * is not the real one is a fabricated blocker.
 */
export function ComingSoon({ productKey }: { productKey: string }) {
  const item = navItem(productKey);
  if (!item) throw new Error(`unknown product key: ${productKey}`);

  const alternatives = liveProducts()
    .filter((candidate) => !candidate.requiresAuth && candidate.key !== productKey)
    .slice(0, 2);

  return (
    <PageShell width="narrow">
      <section className="sb-panel" style={{ textAlign: "center", padding: "var(--sb-8) var(--sb-4)" }}>
        <Construction size={30} aria-hidden="true" style={{ color: "var(--sb-faint)" }} />

        <h1 style={{ margin: "var(--sb-3) 0 4px", fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>
          {item.label}
        </h1>
        <p className="sb-muted" style={{ margin: 0 }}>{item.blurb}</p>

        <p
          className="sb-note sb-note--warn"
          style={{ display: "inline-flex", margin: "var(--sb-4) 0 0" }}
        >
          Not available yet
        </p>

        <p className="sb-small sb-muted" style={{ maxWidth: 420, margin: "var(--sb-3) auto 0" }}>
          {item.waitingOn} We would rather show you nothing than a page that pretends to work —
          when it is real, it will appear here.
        </p>

        <div
          style={{
            display: "flex", gap: "var(--sb-2)", justifyContent: "center",
            flexWrap: "wrap", marginTop: "var(--sb-5)",
          }}
        >
          {alternatives.map((alternative) => (
            <Link key={alternative.key} href={alternative.href} className="sb-btn sb-btn--primary">
              {alternative.label}
            </Link>
          ))}
          <Link href="/" className="sb-btn sb-btn--ghost">
            Home
          </Link>
        </div>
      </section>
    </PageShell>
  );
}
