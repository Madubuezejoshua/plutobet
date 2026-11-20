"use client";

import { useEffect } from "react";
import { WifiOff } from "lucide-react";
import { useOnlineStatus } from "./use-pwa-install";

export function PWARuntime() {
  const isOnline = useOnlineStatus();

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => {
        registration.update().catch(() => {});
      })
      .catch(() => {
        // Service worker registration may be blocked in restricted iframes; ignore cleanly.
      });
  }, []);

  if (isOnline) return null;

  return (
    <div className="sb-offline-banner" role="status" aria-live="polite">
      <WifiOff size={14} aria-hidden="true" />
      <span>You are offline — live odds and betting require a network connection.</span>
    </div>
  );
}
