"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import {
  Activity,
  ArrowRight,
  Award,
  CheckSquare,
  CreditCard,
  Flame,
  Gift,
  HelpCircle,
  Home,
  Radio,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  Trophy,
  User,
  Wallet,
  X,
} from "lucide-react";
import { PWAInstallButton } from "@/components/pwa/pwa-install-button";

interface SidebarProps {
  signedIn: boolean;
  liveCount: number;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

interface SideLink {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
  badge?: string | number;
  badgeVariant?: "red" | "purple";
  goldIcon?: boolean;
  matchExact?: boolean;
}

export function SportsbookSidebar({
  signedIn,
  liveCount,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const pathname = usePathname();

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseMobile();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen, onCloseMobile]);

  const isActive = (href: string, exact = false) => {
    if (exact || href === "/") return pathname === href;
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  const mainLinks: SideLink[] = [
    { href: "/", label: "Home", icon: Home, matchExact: true },
    { href: "/sports", label: "Sports", icon: Trophy },
    {
      href: "/live",
      label: "Live Matches",
      icon: Radio,
      badge: liveCount > 0 ? liveCount : undefined,
      badgeVariant: "red",
    },
    { href: "/livescore", label: "Livescore", icon: Activity },
    { href: "/results", label: "Results", icon: CheckSquare },
  ];

  const productLinks: SideLink[] = [
    {
      href: "/jackpot",
      label: "Jackpot",
      icon: Flame,
      badge: "HOT",
      badgeVariant: "purple",
      goldIcon: true,
    },
    { href: "/promotions", label: "Promotions", icon: Gift },
    { href: "/rewards", label: "Rewards", icon: Award },
    { href: "/pluto", label: "Pluto AI", icon: Sparkles },
  ];

  const accountLinks: SideLink[] = [
    { href: "/bets", label: "My Bets", icon: ReceiptText },
    { href: "/wallet", label: "Wallet", icon: Wallet },
    { href: signedIn ? "/account" : "/signin", label: signedIn ? "Account" : "Sign in", icon: User },
  ];

  const helpLinks: SideLink[] = [
    { href: "/payments", label: "Payments & Limits", icon: CreditCard },
    { href: "/responsible", label: "Safer Gambling", icon: ShieldCheck },
    { href: "/support", label: "Help & Support", icon: HelpCircle },
  ];

  const renderGroup = (label: string, items: SideLink[]) => (
    <div className="sb-sidebar__group">
      <p className="sb-sidebar__group-label">{label}</p>
      <div className="sb-sidebar__nav">
        {items.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href, item.matchExact);
          return (
            <Link
              key={item.href}
              href={item.href}
              className="sb-sideitem"
              aria-current={active ? "page" : undefined}
              onClick={onCloseMobile}
            >
              <span className="sb-sideitem__left">
                <Icon
                  size={16}
                  className={`sb-sideitem__icon${item.goldIcon && !active ? " sb-sideitem__badge--gold" : ""}`}
                  aria-hidden={true}
                />
                <span className="sb-truncate">{item.label}</span>
              </span>
              {item.badge !== undefined ? (
                <span
                  className={`sb-sideitem__badge ${
                    item.badgeVariant === "red"
                      ? "sb-sideitem__badge--red"
                      : "sb-sideitem__badge--purple"
                  }`}
                >
                  {item.badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>
    </div>
  );

  const asideBody = (
    <aside className="sb-sidebar" aria-label="Sportsbook sidebar">
      <div className="sb-sidebar__scroll">
        <div className="sb-sidebar__brandwrap">
          <Link href="/" className="sb-brand" aria-label="PlutoBet home" onClick={onCloseMobile}>
            <span className="sb-brand__word">
              Pluto<span className="sb-brand__grad">Bet</span>
            </span>
            <span className="sb-brand__sub">SPORTSBOOK · 2026</span>
          </Link>
          <button
            type="button"
            className="sb-sidebar__close"
            onClick={onCloseMobile}
            aria-label="Close navigation"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <nav aria-label="Sidebar Navigation">
          {renderGroup("Board", mainLinks)}
          {renderGroup("Products", productLinks)}
          {renderGroup("Account", accountLinks)}
          {renderGroup("Help & Trust", helpLinks)}
          <div className="sb-sidebar__group">
            <PWAInstallButton variant="sidebar" onAction={onCloseMobile} />
          </div>
        </nav>
      </div>

      <div className="sb-sidebar__promo">
        <Link href="/sports" className="sb-promo-card" onClick={onCloseMobile}>
          <div className="sb-promo-card__media">
            <Image
              src="/assets/crops/trophy_bg.png"
              alt="World Cup 2026 Trophy"
              fill
              sizes="200px"
              referrerPolicy="no-referrer"
              className="sb-promo-card__img"
            />
            <div className="sb-promo-card__overlay" aria-hidden="true" />
            <div className="sb-promo-card__copy">
              <span className="sb-promo-card__eyebrow">MATCHDAY BOARD</span>
              <span className="sb-promo-card__year">2026</span>
              <span className="sb-promo-card__dates">LIVE ODDS &amp; MARKETS</span>
              <span className="sb-promo-card__hosts">FOOTBALL · JACKPOT · AI</span>
            </div>
          </div>
          <div className="sb-promo-card__foot">
            <span className="sb-promo-card__cta">
              <span>Explore Odds</span>
              <ArrowRight size={13} aria-hidden="true" />
            </span>
          </div>
        </Link>
      </div>
    </aside>
  );

  return (
    <>
      <div className="sb-sidebar-desktop">{asideBody}</div>
      {mobileOpen ? (
        <>
          <button
            type="button"
            className="sb-sidebar-drawer-backdrop"
            aria-label="Close navigation menu"
            onClick={onCloseMobile}
          />
          <div className="sb-sidebar-drawer" role="dialog" aria-modal="true" aria-label="Navigation">
            {asideBody}
          </div>
        </>
      ) : null}
    </>
  );
}
