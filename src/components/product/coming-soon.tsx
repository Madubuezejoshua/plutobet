import Link from "next/link";
import { liveProducts, navItem } from "@/lib/navigation";

/**
 * The placeholder shown for a product that has not been built yet.
 *
 * The master build rules forbid empty pages, fake buttons and unmarked mock
 * data. The honest alternative is this: say plainly that the product does not
 * exist, name the phase that delivers it, and route the visitor to something
 * that does work. No fake game tiles, no dummy fixtures, no button that
 * silently does nothing.
 *
 * It reads its copy from the navigation registry, so a product's description
 * is written once and a status change here is a one-line edit there.
 */
export function ComingSoon({ productKey }: { productKey: string }) {
  const item = navItem(productKey);
  if (!item) throw new Error(`unknown product key: ${productKey}`);

  const alternatives = liveProducts()
    .filter((candidate) => !candidate.requiresAuth && candidate.key !== productKey)
    .slice(0, 2);

  return (
    <section className="placeholder">
      <span className="ico" aria-hidden="true">
        {item.icon}
      </span>
      <h1>{item.label}</h1>
      <p>{item.blurb}</p>

      <span className="phase-tag">Not built yet · arrives in phase {item.phase}</span>

      <p className="small muted">
        We would rather show you nothing than show you a page that pretends to work. When this
        product is connected to a real provider, it will appear here.
      </p>

      <div className="placeholder-actions">
        {alternatives.map((alternative) => (
          <Link key={alternative.key} href={alternative.href} className="btn primary">
            {alternative.label}
          </Link>
        ))}
        <Link href="/" className="btn ghost">
          Home
        </Link>
      </div>
    </section>
  );
}
