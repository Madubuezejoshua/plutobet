"use client";

import { useState } from "react";
import { Download, PlusSquare, Share, Smartphone, X } from "lucide-react";
import { usePWAInstall } from "./use-pwa-install";

interface PWAInstallButtonProps {
  variant?: "header" | "sidebar" | "inline";
  onAction?: () => void;
}

export function PWAInstallButton({ variant = "header", onAction }: PWAInstallButtonProps) {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  // Never show when already running as an installed standalone PWA.
  if (isInstalled) return null;
  if (!isInstallable && !isIOS) return null;

  async function handleClick() {
    if (isInstallable) {
      await install();
      onAction?.();
      return;
    }
    if (isIOS) {
      setShowIOSGuide(true);
    }
  }

  return (
    <>
      {variant === "sidebar" ? (
        <button
          type="button"
          onClick={handleClick}
          className="sb-sideitem sb-pwa-sidebtn"
          aria-label="Install PlutoBet mobile app"
        >
          <span className="sb-sideitem__left">
            <Smartphone size={16} className="sb-sideitem__icon" aria-hidden="true" />
            <span className="sb-truncate">{isIOS ? "Add to Home Screen" : "Install App"}</span>
          </span>
          <span className="sb-sideitem__badge sb-sideitem__badge--purple">APP</span>
        </button>
      ) : variant === "inline" ? (
        <button
          type="button"
          onClick={handleClick}
          className="sb-btn sb-btn--primary"
        >
          <Download size={15} aria-hidden="true" />
          <span>{isIOS ? "Install on iPhone / iPad" : "Install PlutoBet App"}</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          className="sb-iconbtn sb-pwa-headerbtn"
          aria-label="Install PlutoBet App"
          title={isIOS ? "Add PlutoBet to Home Screen" : "Install PlutoBet App"}
        >
          <Download size={15} aria-hidden="true" />
          <span className="sb-pwa-headerbtn__label">App</span>
        </button>
      )}

      {showIOSGuide ? (
        <div
          className="sb-pwa-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-ios-title"
          onClick={() => setShowIOSGuide(false)}
        >
          <div className="sb-pwa-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sb-pwa-modal__head">
              <h3 id="pwa-ios-title">Install PlutoBet on iPhone / iPad</h3>
              <button
                type="button"
                className="sb-iconbtn"
                aria-label="Close install guide"
                onClick={() => setShowIOSGuide(false)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <p className="sb-small sb-muted" style={{ margin: 0 }}>
              Install PlutoBet to your home screen for full-screen access without the browser bar:
            </p>
            <ol className="sb-pwa-steps">
              <li>
                <Share size={15} aria-hidden="true" />
                <span>
                  Tap the <strong>Share</strong> button in your Safari toolbar.
                </span>
              </li>
              <li>
                <PlusSquare size={15} aria-hidden="true" />
                <span>
                  Scroll down and tap <strong>Add to Home Screen</strong>.
                </span>
              </li>
              <li>
                <Smartphone size={15} aria-hidden="true" />
                <span>
                  Tap <strong>Add</strong> — PlutoBet will launch like a native app.
                </span>
              </li>
            </ol>
            <button
              type="button"
              className="sb-btn sb-btn--dark"
              style={{ width: "100%" }}
              onClick={() => setShowIOSGuide(false)}
            >
              Got it
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
