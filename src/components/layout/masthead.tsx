"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  NAV_ITEMS,
  UTILITY_ROUTES,
  navByGroup,
  navItemForPath,
  type NavItem,
} from "@/lib/navigation";

/**
 * Top navigation.
 *
 * Client-side only because it needs `usePathname` to mark the current product
 * and to hold the drawer open/closed. The balance is passed in from the server
 * shell rather than fetched here — a wallet balance must never be resolved by
 * the browser.
 */

const GROUP_LABELS: Record<NavItem["group"], string> = {
  BETTING: "Betting",
  GAMING: "Games",
  INFO: "Discover",
  ACCOUNT: "My account",
};

export function Masthead({
  signedIn,
  balance,
}: {
  signedIn: boolean;
  /** Preformatted. The shell owns the kobo→naira conversion. */
  balance: string | null;
}) {
  const pathname = usePathname();
  const current = navItemForPath(pathname);

  /*
   * The drawer records WHICH page it was opened on, rather than a plain
   * boolean.
   *
   * Navigating must close it. Doing that with an effect that calls
   * setState on a pathname change is a cascading render — React flags it,
   * and it briefly paints the new page with the old drawer still over it.
   * Deriving "open" as "opened on the page we are still looking at" means a
   * navigation closes it during the same render, with no effect at all.
   */
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const drawerOpen = openedFor === pathname;
  const setDrawerOpen = (open: boolean) => setOpenedFor(open ? pathname : null);

  // Escape closes; the body must not scroll behind an open drawer.
  useEffect(() => {
    if (!drawerOpen) return;
    // `setOpenedFor` directly, not the `setDrawerOpen` helper: the helper
    // closes over `pathname` and is rebuilt every render, so depending on it
    // would tear this listener down and rebuild it on each paint.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenedFor(null);
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  return (
    <>
      <header className="masthead">
        <div className="shell masthead-inner">
          <Link href="/" className="brand">
            <span className="brand-mark" aria-hidden="true">
              ◆
            </span>
            Pluto<em>Bet</em>
          </Link>

          <nav className="nav-links" aria-label="Products">
            {NAV_ITEMS.filter((item) => item.key !== "home" && !item.requiresAuth).map((item) => (
              <Link
                key={item.key}
                href={item.href}
                aria-current={current?.key === item.key ? "page" : undefined}
                data-planned={item.status === "PLANNED" ? "true" : undefined}
                title={item.status === "PLANNED" ? `${item.label} — coming in phase ${item.phase}` : item.label}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="masthead-actions">
            {signedIn ? (
              <>
                <Link href="/wallet" className="balance-chip">
                  <span>Bal</span>
                  {balance ?? "—"}
                </Link>
                <Link href={UTILITY_ROUTES.deposit} className="btn primary sm">
                  Deposit
                </Link>
              </>
            ) : (
              <>
                <Link href={UTILITY_ROUTES.signIn} className="btn ghost sm">
                  Sign in
                </Link>
                <Link href={UTILITY_ROUTES.register} className="btn primary sm">
                  Join
                </Link>
              </>
            )}

            <button
              type="button"
              className="hamburger"
              aria-expanded={drawerOpen}
              aria-controls="mobile-drawer"
              aria-label="Open menu"
              onClick={() => setDrawerOpen(true)}
            >
              ☰
            </button>
          </div>
        </div>
      </header>

      {drawerOpen ? (
        <>
          <button
            type="button"
            className="drawer-backdrop"
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
          />
          <div id="mobile-drawer" className="drawer" role="dialog" aria-label="Menu" aria-modal="true">
            <div className="drawer-head">
              <span className="brand">
                <span className="brand-mark" aria-hidden="true">
                  ◆
                </span>
                Pluto<em>Bet</em>
              </span>
              <button
                type="button"
                className="drawer-close"
                aria-label="Close menu"
                onClick={() => setDrawerOpen(false)}
              >
                ✕
              </button>
            </div>

            {(["BETTING", "GAMING", "INFO", "ACCOUNT"] as const).map((group) => {
              const items = navByGroup(group).filter(
                (item) => !item.requiresAuth || signedIn,
              );
              if (items.length === 0) return null;

              return (
                <div className="drawer-group" key={group}>
                  <h3>{GROUP_LABELS[group]}</h3>
                  {items.map((item) => (
                    <Link
                      key={item.key}
                      href={item.href}
                      className="drawer-link"
                      aria-current={current?.key === item.key ? "page" : undefined}
                    >
                      <span className="ico" aria-hidden="true">
                        {item.icon}
                      </span>
                      {item.label}
                      {item.status === "PLANNED" ? <span className="soon">Soon</span> : null}
                    </Link>
                  ))}
                </div>
              );
            })}

            <div className="drawer-group">
              <h3>More</h3>
              <Link href={UTILITY_ROUTES.deposit} className="drawer-link">
                <span className="ico" aria-hidden="true">
                  ➕
                </span>
                Deposit
              </Link>
              <Link href={UTILITY_ROUTES.withdraw} className="drawer-link">
                <span className="ico" aria-hidden="true">
                  ➖
                </span>
                Withdraw
              </Link>
              <Link href={UTILITY_ROUTES.verify} className="drawer-link">
                <span className="ico" aria-hidden="true">
                  🪪
                </span>
                Verify identity
              </Link>
              <Link href={UTILITY_ROUTES.responsible} className="drawer-link">
                <span className="ico" aria-hidden="true">
                  🛡️
                </span>
                Responsible gambling
              </Link>
              <Link
                href={signedIn ? UTILITY_ROUTES.signOut : UTILITY_ROUTES.signIn}
                className="drawer-link"
              >
                <span className="ico" aria-hidden="true">
                  {signedIn ? "🚪" : "🔑"}
                </span>
                {signedIn ? "Sign out" : "Sign in"}
              </Link>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
