"use client";

import { useState } from "react";
import { Check, Copy, Share2 } from "lucide-react";

/**
 * Copy and share the referral link.
 *
 * The page previously printed the link as text and left the customer to select
 * it by hand on a phone — a control that exists only as instructions. These are
 * two real buttons.
 *
 * The link is built from `window.location.origin` rather than a configured base
 * URL, so it is correct on whatever host the customer is actually using and
 * cannot leak a staging domain into a share sheet.
 *
 * `navigator.share` is offered only where it exists (most Android browsers,
 * iOS Safari). Where it does not, the button is not rendered at all rather than
 * rendered dead.
 */
export function ShareCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const [canShare] = useState(
    () => typeof navigator !== "undefined" && typeof navigator.share === "function",
  );

  const path = `/register?ref=${code}`;
  const url = typeof window === "undefined" ? path : `${window.location.origin}${path}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (an insecure origin, a locked-down
      // browser). Selecting the field is then the fallback, so make it easy.
      const field = document.getElementById("referral-link");
      if (field instanceof HTMLInputElement) field.select();
    }
  }

  async function share() {
    try {
      await navigator.share({
        title: "Join me on PlutoBet",
        text: "Sign up with my link.",
        url,
      });
    } catch {
      // Includes the customer dismissing the share sheet, which is not an error.
    }
  }

  return (
    <>
      <label className="sb-sr" htmlFor="referral-link">Your referral link</label>
      <input
        id="referral-link"
        className="sb-input"
        value={url}
        readOnly
        onFocus={(e) => e.currentTarget.select()}
      />

      <div style={{ display: "flex", gap: "var(--sb-2)", marginTop: "var(--sb-2)" }}>
        <button type="button" className="sb-btn sb-btn--primary" onClick={copy} style={{ flex: 1 }}>
          {copied ? (
            <>
              <Check size={15} aria-hidden="true" /> Copied
            </>
          ) : (
            <>
              <Copy size={15} aria-hidden="true" /> Copy link
            </>
          )}
        </button>
        {canShare ? (
          <button type="button" className="sb-btn sb-btn--ghost" onClick={share} style={{ flex: 1 }}>
            <Share2 size={15} aria-hidden="true" /> Share
          </button>
        ) : null}
      </div>

      <p className="sb-xs sb-muted" style={{ marginTop: "var(--sb-2)" }}>
        Anyone who signs up through this link is linked to you.
      </p>
      <p className="sb-sr" role="status">{copied ? "Referral link copied" : ""}</p>
    </>
  );
}
