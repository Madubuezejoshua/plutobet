"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function subscribeOnline(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function getOnlineSnapshot() {
  return typeof navigator !== "undefined" ? navigator.onLine : true;
}

function getOnlineServerSnapshot() {
  return true;
}

export function useOnlineStatus() {
  return useSyncExternalStore(
    subscribeOnline,
    getOnlineSnapshot,
    getOnlineServerSnapshot,
  );
}

function subscribeDisplayMode(callback: () => void) {
  try {
    const media = window.matchMedia("(display-mode: standalone)");
    media.addEventListener("change", callback);
    return () => media.removeEventListener("change", callback);
  } catch {
    return () => {};
  }
}

function getStandaloneSnapshot() {
  try {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

function subscribeNever() {
  return () => {};
}

function getIOSSnapshot() {
  return /iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase());
}

function getFalseSnapshot() {
  return false;
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installedEvent, setInstalledEvent] = useState(false);

  const isStandalone = useSyncExternalStore(
    subscribeDisplayMode,
    getStandaloneSnapshot,
    getFalseSnapshot,
  );
  const isIOS = useSyncExternalStore(
    subscribeNever,
    getIOSSnapshot,
    getFalseSnapshot,
  );

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setInstalledEvent(true);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") {
      setInstalledEvent(true);
      setDeferredPrompt(null);
      return true;
    }
    return false;
  };

  return {
    isInstallable: Boolean(deferredPrompt),
    isInstalled: isStandalone || installedEvent,
    isIOS,
    install,
  };
}
