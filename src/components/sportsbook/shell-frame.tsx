"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { SportsbookSidebar } from "./sidebar";
import { SportsbookHeader } from "./header";
import { SportsbookFooter } from "./footer";
import { MobileBar } from "./mobile-bar";
import { PWARuntime } from "@/components/pwa/pwa-runtime";

export interface ShellSportItem {
  key: string;
  label: string;
  href: string;
  upcoming?: number;
  live?: number;
}

interface ShellFrameProps {
  signedIn: boolean;
  balanceMinor: string | null;
  liveCount: number;
  sports: ShellSportItem[];
  allSports?: ShellSportItem[];
  activeSport: string;
  banner?: ReactNode;
  children: ReactNode;
}

const THEME_STORAGE_KEY = "plutobet.theme";
const THEME_EVENT = "plutobet-theme-change";

function subscribeTheme(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(THEME_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(THEME_EVENT, callback);
  };
}

function getThemeSnapshot(): boolean {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) !== "light";
  } catch {
    return true;
  }
}

function getThemeServerSnapshot(): boolean {
  return true;
}

export function SportsbookShellFrame({
  signedIn,
  balanceMinor,
  liveCount,
  sports,
  allSports,
  activeSport,
  banner,
  children,
}: ShellFrameProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isDark = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getThemeServerSnapshot,
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  function toggleTheme() {
    const next = !isDark;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next ? "dark" : "light");
    } catch {
      // Ignore storage errors in restricted contexts
    }
    window.dispatchEvent(new Event(THEME_EVENT));
  }

  return (
    <div className="sb sb-app">
      <SportsbookSidebar
        signedIn={signedIn}
        liveCount={liveCount}
        sports={allSports ?? sports}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="sb-content">
        <SportsbookHeader
          signedIn={signedIn}
          balanceMinor={balanceMinor}
          sports={sports}
          activeSport={activeSport}
          isDark={isDark}
          onToggleTheme={toggleTheme}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
        />
        {banner}
        <div className="sb-main">{children}</div>
        <SportsbookFooter />
        <MobileBar signedIn={signedIn} balanceMinor={balanceMinor} />
        <PWARuntime />
      </div>
    </div>
  );
}
