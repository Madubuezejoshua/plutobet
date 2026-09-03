import Link from "next/link";
import { Compass } from "lucide-react";

export const metadata = { title: "Page not found" };

/**
 * The 404.
 *
 * Next.js has a built-in one: black text on white, the word "404", and no way
 * out. A customer who mistypes a URL or follows a stale link from a message
 * lands on something that does not look like this product and offers them
 * nothing — the back button is their only option, and plenty of people close
 * the tab instead.
 *
 * IT LIVES AT THE APP ROOT, so it renders inside `app/layout.tsx` and NOT
 * inside `(site)/layout.tsx`. That means no header, no betslip provider and no
 * session — which is correct: a 404 must not depend on a database read, or an
 * unreachable database turns every wrong URL into a 500.
 *
 * So the chrome here is deliberately hand-rolled and minimal rather than shared
 * with the shell. It is the one page that has to work when nothing else does.
 */
export default function NotFound() {
  return (
    <div className="sb sb-notfound">
      <div className="sb-notfound__card">
        <Link href="/" className="sb-notfound__brand" aria-label="PlutoBet home">
          <span aria-hidden="true" className="sb-notfound__mark">
            <Compass size={16} />
          </span>
          Pluto<span style={{ color: "var(--sb-brand)" }}>Bet</span>
        </Link>

        <h1 className="sb-notfound__title">We could not find that page</h1>
        <p className="sb-notfound__text">
          The link may be old, or the address may have a typo in it. Nothing has happened to your
          account, your balance or any open bets.
        </p>

        <div className="sb-notfound__actions">
          <Link href="/" className="sb-btn sb-btn--primary">
            Go to the odds
          </Link>
          <Link href="/bets" className="sb-btn sb-btn--onshell">
            My bets
          </Link>
          <Link href="/wallet" className="sb-btn sb-btn--onshell">
            Wallet
          </Link>
        </div>
      </div>
    </div>
  );
}
