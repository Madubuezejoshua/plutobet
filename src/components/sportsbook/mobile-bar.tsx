"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { Flame, Home, Ticket, Trophy, User } from "lucide-react";
import { useBetslip } from "./betslip-store";
import { BetslipPanel } from "./betslip-panel";

/**
 * Mobile navigation and the betslip sheet.
 *
 * The betslip is a bottom sheet rather than a route, because losing the board
 * behind a full page navigation is what makes mobile betting feel slow — the
 * customer wants to check the slip and carry on scrolling.
 *
 * Touch targets are at least 44px, set in CSS via `--sb-h-touch` rather than
 * left to whatever the icon happens to measure.
 */

export function MobileBar({
  signedIn,
  balanceMinor,
}: {
  signedIn: boolean;
  balanceMinor?: string | null;
}) {
  const pathname = usePathname();
  const slip = useBetslip();

  // A sheet that leaves the page scrollable behind it feels broken.
  useEffect(() => {
    if (!slip.open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [slip.open]);

  // Escape closes it, as a dialog should.
  useEffect(() => {
    if (!slip.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") slip.setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slip]);

  const active = (href: string) =>
    pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));

  return (
    <>
      <nav className="sb-bottombar" aria-label="Primary">
        <Link href="/" className="sb-bottombar__item" aria-current={active("/") && pathname === "/" ? "page" : undefined}>
          <Home size={19} aria-hidden="true" />
          Home
        </Link>
        <Link href="/sports" className="sb-bottombar__item" aria-current={active("/sports") ? "page" : undefined}>
          <Trophy size={19} aria-hidden="true" />
          Sports
        </Link>
        <Link href="/live" className="sb-bottombar__item" aria-current={active("/live") ? "page" : undefined}>
          <Flame size={19} aria-hidden="true" />
          Live
        </Link>
        <button
          type="button"
          className="sb-bottombar__item"
          aria-expanded={slip.open}
          aria-haspopup="dialog"
          onClick={() => slip.setOpen(!slip.open)}
        >
          <Ticket size={19} aria-hidden="true" />
          Betslip
          {slip.picks.length > 0 ? (
            <span className="sb-badge" aria-label={`${slip.picks.length} selections`}>
              {slip.picks.length}
            </span>
          ) : null}
        </button>
        <Link
          href={signedIn ? "/account" : "/signin"}
          className="sb-bottombar__item"
          aria-current={active("/account") ? "page" : undefined}
        >
          <User size={19} aria-hidden="true" />
          {signedIn ? "Account" : "Sign in"}
        </Link>
      </nav>

      {slip.open ? (
        <>
          <button
            type="button"
            className="sb-scrim"
            aria-label="Close betslip"
            onClick={() => slip.setOpen(false)}
          />
          <div className="sb-sheet" role="dialog" aria-modal="true" aria-label="Betslip">
            <div className="sb-sheet__grab" aria-hidden="true" />
            <div style={{ overflowY: "auto" }}>
              <BetslipPanel signedIn={signedIn} balanceMinor={balanceMinor} compact />
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
