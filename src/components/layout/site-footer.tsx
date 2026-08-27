import Link from "next/link";
import { UTILITY_ROUTES } from "@/lib/navigation";

/**
 * Footer.
 *
 * The responsible-gambling and age statements are not decoration — they are
 * licence conditions, and they appear on every page for that reason. The
 * "18+" mark is deliberately the most prominent thing here.
 */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell">
        <div className="footer-links">
          <Link href={UTILITY_ROUTES.responsible}>Responsible gambling</Link>
          <Link href={UTILITY_ROUTES.verify}>Verify identity</Link>
          <Link href="/results">Results</Link>
          <Link href="/promotions">Promotions</Link>
        </div>

        <p className="footer-legal">
          <span className="age-badge" aria-hidden="true">
            18+
          </span>
          You must be 18 or over to open an account or place a bet. Gambling carries a risk of
          financial loss — never stake more than you can afford. If it stops being a game, use
          the deposit limits, cooling-off and self-exclusion tools on your{" "}
          <Link href={UTILITY_ROUTES.responsible}>responsible gambling</Link> page.
        </p>
      </div>
    </footer>
  );
}
