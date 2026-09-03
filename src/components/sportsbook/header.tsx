"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ChevronDown, CircleDollarSign, LogIn, Search, Sparkles, Trophy, User, Wallet, X,
} from "lucide-react";
import { naira } from "@/lib/money";
import { NAV_ITEMS } from "@/lib/navigation";

/**
 * Two-level header.
 *
 * WHY TWO LEVELS. The previous single row carried seventeen products and
 * overflowed horizontally on anything narrower than a desktop. The primary row
 * now holds only what a customer uses to move around the product; sports live
 * on the second row, where a horizontal scroll is expected and harmless.
 *
 * WHY THE "MORE" LIST IS DERIVED. It used to be a hand-written array with a
 * blanket "Soon" tag on every entry — including Results and Livescore, which
 * are finished and working. Labelling a working page as unbuilt is the same
 * class of error as labelling an unbuilt page as working: both leave the
 * customer unable to trust the navigation. The list now comes from the
 * registry and each entry carries that product's real status.
 */

interface Props {
  signedIn: boolean;
  balanceMinor?: string | null;
  /** Sports with fixtures, for the second row. Never a hard-coded list. */
  sports?: { key: string; label: string; href: string }[];
  activeSport?: string;
}

/*
 * Pages where the sports row is suppressed.
 *
 * A customer on the sign-in page is not choosing a sport, and a row of tabs
 * under the form is one more thing between them and the password field. The
 * primary row stays, so the brand and a way out are always present.
 */
const WITHOUT_SPORTS = ["/signin", "/register", "/forgot-password"];

const PRIMARY = [
  { href: "/sports", label: "Sports" },
  { href: "/live", label: "Live" },
  { href: "/jackpot", label: "Jackpot" },
  { href: "/promotions", label: "Promotions" },
];

/** Everything not on the primary row, in registry order, with its real status. */
const MORE = NAV_ITEMS.filter(
  (item) =>
    item.group !== "ACCOUNT" &&
    !["home", "sports", "live", "jackpot", "promotions", "pluto-ai"].includes(item.key),
);

export function SportsbookHeader({ signedIn, balanceMinor, sports = [], activeSport }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  const isActive = (href: string) =>
    pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));

  // A menu that stays open after you click elsewhere is a menu you have to
  // fight. Escape closes it too, which is what a keyboard user expects.
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (event: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    const q = query.trim();
    // An empty search is a no-op rather than a navigation to an unfiltered
    // board the customer is probably already looking at.
    if (q === "") return;
    router.push(`/sports?q=${encodeURIComponent(q)}`);
    setSearchOpen(false);
  }

  const showSports = sports.length > 0 && !WITHOUT_SPORTS.includes(pathname);

  return (
    <header className="sb-header">
      <div className="sb-header__bar">
        <Link href="/" className="sb-navlink" style={{ padding: 0, gap: 8 }} aria-label="PlutoBet home">
          <span
            aria-hidden="true"
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 26, borderRadius: 7,
              background: "var(--sb-brand)", color: "var(--sb-brand-ink)",
            }}
          >
            <Trophy size={15} />
          </span>
          <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--sb-shell-ink)" }}>
            Pluto<span style={{ color: "var(--sb-brand)" }}>Bet</span>
          </span>
        </Link>

        <nav className="sb-header__nav" aria-label="Main">
          {PRIMARY.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="sb-navlink"
              aria-current={isActive(item.href) ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}

          <div style={{ position: "relative" }} ref={moreRef}>
            <button
              type="button"
              className="sb-navlink"
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              onClick={() => setMoreOpen((o) => !o)}
            >
              More <ChevronDown size={14} aria-hidden="true" />
            </button>
            {moreOpen ? (
              <div
                role="menu"
                style={{
                  position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 50,
                  minWidth: 230, padding: 6,
                  background: "var(--sb-shell-2)",
                  border: "1px solid var(--sb-shell-line)",
                  borderRadius: "var(--sb-r-md)",
                  boxShadow: "var(--sb-shadow-lg)",
                }}
              >
                {MORE.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    role="menuitem"
                    className="sb-navlink"
                    style={{ display: "flex", width: "100%", justifyContent: "space-between" }}
                    onClick={() => setMoreOpen(false)}
                  >
                    {item.label}
                    {item.status === "PLANNED" ? (
                      <span className="sb-xs" style={{ color: "var(--sb-shell-muted)" }}>
                        Not yet
                      </span>
                    ) : null}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>

          <Link href="/pluto" className="sb-navlink" aria-current={isActive("/pluto") ? "page" : undefined}>
            <Sparkles size={14} aria-hidden="true" /> Pluto AI
          </Link>
        </nav>

        <span className="sb-header__spacer" />

        {searchOpen ? (
          <form onSubmit={submitSearch} className="sb-headersearch" role="search">
            <label className="sb-sr" htmlFor="sb-search">Search teams and competitions</label>
            <Search size={14} aria-hidden="true" className="sb-headersearch__icon" />
            <input
              id="sb-search"
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Team or competition"
              onKeyDown={(event) => {
                if (event.key === "Escape") setSearchOpen(false);
              }}
            />
            <button type="button" onClick={() => setSearchOpen(false)} aria-label="Close search">
              <X size={15} aria-hidden="true" />
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="sb-navlink"
            aria-label="Search fixtures"
            aria-expanded={false}
            onClick={() => setSearchOpen(true)}
          >
            <Search size={16} aria-hidden="true" />
          </button>
        )}

        {signedIn ? (
          <>
            {/*
              THE SIGNED-IN HEADER OVERFLOWED ON A PHONE. Brand, search,
              balance, Deposit and an account icon came to 446px in a 412px
              viewport, and the page scrolled sideways on every authenticated
              route. Found by a Pixel 7 profile, not by narrowing a desktop
              window.

              Below 900px the balance keeps its figure — it is the thing a
              signed-in customer looks at — Deposit becomes icon-only with its
              label still read out, and the account icon goes entirely because
              the bottom bar already carries Account. Nothing is removed that
              is not reachable in one tap from what remains.
            */}
            <Link href="/wallet" className="sb-navlink" style={{ gap: 6 }}>
              <Wallet size={15} aria-hidden="true" />
              <span className="sb-num">{balanceMinor ? naira(balanceMinor) : "—"}</span>
            </Link>
            <Link
              href="/deposit"
              className="sb-btn sb-btn--primary sb-header__deposit"
              style={{ height: 32 }}
              aria-label="Deposit"
            >
              <CircleDollarSign size={15} aria-hidden="true" />
              <span className="sb-header__depositlabel">Deposit</span>
            </Link>
            <Link href="/account" className="sb-navlink sb-header__account" aria-label="Your account">
              <User size={16} aria-hidden="true" />
            </Link>
          </>
        ) : (
          <>
            <Link href="/signin" className="sb-btn sb-btn--dark" style={{ height: 32 }}>
              <LogIn size={15} aria-hidden="true" /> Sign in
            </Link>
            <Link href="/register" className="sb-btn sb-btn--primary" style={{ height: 32 }}>
              Register
            </Link>
          </>
        )}
      </div>

      {showSports ? (
        <div className="sb-subnav">
          <nav className="sb-subnav__inner" aria-label="Sports">
            {sports.map((sport) => (
              <Link
                key={sport.key}
                href={sport.href}
                className="sb-sporttab"
                aria-current={activeSport === sport.key ? "page" : undefined}
              >
                {sport.label}
              </Link>
            ))}
          </nav>
        </div>
      ) : null}
    </header>
  );
}
