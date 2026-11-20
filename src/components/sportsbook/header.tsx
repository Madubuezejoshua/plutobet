"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  CircleDollarSign,
  LogIn,
  Menu,
  Moon,
  Search,
  Sparkles,
  Sun,
  Wallet,
  X,
} from "lucide-react";
import { naira } from "@/lib/money";
import { NAV_ITEMS } from "@/lib/navigation";
import { PWAInstallButton } from "@/components/pwa/pwa-install-button";

interface Props {
  signedIn: boolean;
  balanceMinor?: string | null;
  sports?: { key: string; label: string; href: string }[];
  activeSport?: string;
  isDark: boolean;
  onToggleTheme: () => void;
  onOpenMobileMenu: () => void;
}

const WITHOUT_SPORTS = ["/signin", "/register", "/forgot-password"];

const PRIMARY = [
  { href: "/sports", label: "Sports" },
  { href: "/live", label: "Live" },
  { href: "/jackpot", label: "Jackpot" },
  { href: "/promotions", label: "Promotions" },
];

const MORE = NAV_ITEMS.filter(
  (item) =>
    item.status === "LIVE" &&
    item.group !== "ACCOUNT" &&
    ![
      "home",
      "sports",
      "live",
      "jackpot",
      "promotions",
      "pluto-ai",
      "casino",
      "virtuals",
    ].includes(item.key),
);

function SportsSubnav({
  sports,
  fallbackActive,
}: {
  sports: { key: string; label: string; href: string }[];
  fallbackActive?: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeKey = pathname.startsWith("/sports")
    ? searchParams.get("sport") ?? fallbackActive ?? "football"
    : fallbackActive ?? "football";

  return (
    <div className="sb-subnav">
      <nav className="sb-subnav__inner" aria-label="Sports">
        {sports.map((sport) => (
          <Link
            key={sport.key}
            href={sport.href}
            className="sb-sporttab"
            aria-current={activeKey === sport.key ? "page" : undefined}
          >
            {sport.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function SportsbookHeader({
  signedIn,
  balanceMinor,
  sports = [],
  activeSport,
  isDark,
  onToggleTheme,
  onOpenMobileMenu,
}: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  const isActive = (href: string) =>
    pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (event: PointerEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (q === "") return;
    router.push(`/sports?q=${encodeURIComponent(q)}`);
    setSearchOpen(false);
  }

  const showSports = sports.length > 0 && !WITHOUT_SPORTS.includes(pathname);

  return (
    <>
      <header className="sb-header">
        <div className="sb-header__bar">
          <button
            type="button"
            className="sb-header__menu"
            onClick={onOpenMobileMenu}
            aria-label="Open navigation menu"
          >
            <Menu size={18} aria-hidden="true" />
          </button>

          <Link href="/" className="sb-header__brand-mobile" aria-label="PlutoBet home">
            <span className="sb-brand__word">
              Pluto<span className="sb-brand__grad">Bet</span>
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

          <div style={{ position: "relative", display: "inline-flex", alignItems: "stretch" }} ref={moreRef}>
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
              <div role="menu" className="sb-header__moremenu">
                {MORE.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    role="menuitem"
                    className="sb-header__moreitem"
                    onClick={() => setMoreOpen(false)}
                  >
                    <span>{item.label}</span>
                    {item.status === "PLANNED" ? (
                      <span className="sb-xs sb-muted">Not yet</span>
                    ) : null}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>

          <Link
            href="/pluto"
            className="sb-navlink"
            aria-current={isActive("/pluto") ? "page" : undefined}
          >
            <Sparkles size={14} aria-hidden="true" /> Pluto AI
          </Link>
        </nav>

        <span className="sb-header__spacer" />

        <div className="sb-header__actions">
          {searchOpen ? (
            <form onSubmit={submitSearch} className="sb-headersearch" role="search">
              <label className="sb-sr" htmlFor="sb-search">
                Search teams and competitions
              </label>
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
              className="sb-iconbtn"
              aria-label="Search fixtures"
              aria-expanded={false}
              onClick={() => setSearchOpen(true)}
            >
              <Search size={16} aria-hidden="true" />
            </button>
          )}

          <PWAInstallButton variant="header" />

          <button
            type="button"
            className="sb-iconbtn"
            onClick={onToggleTheme}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            title={isDark ? "Light mode" : "Dark mode"}
          >
            {isDark ? <Moon size={16} aria-hidden="true" /> : <Sun size={16} aria-hidden="true" />}
          </button>

          {signedIn ? (
            <>
              <Link href="/wallet" className="sb-walletchip" aria-label="Wallet balance">
                <Wallet size={15} aria-hidden="true" style={{ color: "var(--sb-brand-text)" }} />
                <span className="sb-num">{balanceMinor ? naira(balanceMinor) : "—"}</span>
              </Link>
              <Link
                href="/deposit"
                className="sb-btn sb-btn--primary sb-header__deposit"
                aria-label="Deposit"
              >
                <CircleDollarSign size={15} aria-hidden="true" />
                <span className="sb-header__depositlabel">Deposit</span>
              </Link>
              <Link href="/account" className="sb-accountchip" aria-label="Your account">
                <Image
                  src="/assets/crops/avatar_john.png"
                  alt=""
                  width={26}
                  height={26}
                  referrerPolicy="no-referrer"
                  className="sb-accountchip__avatar"
                />
                <span>Account</span>
              </Link>
            </>
          ) : (
            <>
              <Link href="/signin" className="sb-btn sb-btn--dark sb-header__signin">
                <LogIn size={15} aria-hidden="true" className="sb-header__authicon" /> Sign in
              </Link>
              <Link href="/register" className="sb-btn sb-btn--primary sb-header__register">
                Register
              </Link>
            </>
          )}
        </div>
      </div>
    </header>

    {showSports ? (
      <Suspense fallback={null}>
        <SportsSubnav sports={sports} fallbackActive={activeSport} />
      </Suspense>
    ) : null}
  </>
  );
}
