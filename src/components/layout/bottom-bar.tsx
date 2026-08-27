"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItem, navItemForPath, UTILITY_ROUTES } from "@/lib/navigation";

/**
 * Mobile bottom navigation.
 *
 * Five destinations, which is the most that stays comfortably tappable on the
 * 360px-wide Android screens this product targets. Everything else lives in
 * the drawer.
 *
 * "Betslip" links to the odds board rather than showing a live count. The slip
 * is currently local state inside the sports page, so a count here would have
 * to be invented — and an invented number on a money surface is exactly what
 * the build rules forbid. It becomes a real badge when Phase 7 lifts the slip
 * into shared state.
 */

const ENTRIES = [
  { key: "home", label: "Home", icon: "🏠", href: "/" },
  { key: "sports", label: "Sports", icon: "⚽", href: "/sports" },
  { key: "__betslip__", label: "Betslip", icon: "🧾", href: "/sports" },
  { key: "bets", label: "My Bets", icon: "🎫", href: "/bets" },
  { key: "account", label: "Account", icon: "👤", href: "/account" },
] as const;

export function BottomBar({ signedIn }: { signedIn: boolean }) {
  const pathname = usePathname();
  const current = navItemForPath(pathname);

  return (
    <nav className="bottom-bar" aria-label="Primary">
      {ENTRIES.map((entry) => {
        const item = entry.key === "__betslip__" ? undefined : navItem(entry.key);
        const requiresAuth = item?.requiresAuth ?? false;
        const href = requiresAuth && !signedIn ? UTILITY_ROUTES.signIn : entry.href;
        const active = entry.key !== "__betslip__" && current?.key === entry.key;

        return (
          <Link
            key={entry.key}
            href={href}
            className="bottom-item"
            aria-current={active ? "page" : undefined}
          >
            <span className="ico" aria-hidden="true">
              {entry.icon}
            </span>
            {entry.label}
          </Link>
        );
      })}
    </nav>
  );
}
