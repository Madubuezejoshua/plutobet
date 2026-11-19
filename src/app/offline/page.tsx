"use client";

import Link from "next/link";
import { RefreshCw, WifiOff } from "lucide-react";

export default function OfflinePage() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        background: "#090D1A",
        color: "#F3F5FA",
      }}
    >
      <section
        style={{
          width: "100%",
          maxWidth: "420px",
          borderRadius: "16px",
          border: "1px solid rgba(148, 163, 184, 0.2)",
          background: "#11172A",
          padding: "28px 24px",
          textAlign: "center",
          display: "grid",
          gap: "14px",
        }}
      >
        <div
          style={{
            width: "52px",
            height: "52px",
            margin: "0 auto",
            borderRadius: "14px",
            background: "rgba(124, 92, 255, 0.14)",
            color: "#A78BFA",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <WifiOff size={24} aria-hidden="true" />
        </div>
        <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 700 }}>You are offline</h1>
        <p style={{ margin: 0, fontSize: "14px", lineHeight: 1.55, color: "#94A3B8" }}>
          PlutoBet requires a live connection to show current odds, settle tickets, and check your
          wallet balance. Reconnect to mobile data or Wi-Fi and try again.
        </p>
        <div style={{ display: "flex", gap: "10px", justifyContent: "center", marginTop: "6px" }}>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              padding: "10px 18px",
              borderRadius: "10px",
              border: "none",
              background: "#6366F1",
              color: "#FFFFFF",
              fontWeight: 600,
              fontSize: "14px",
              cursor: "pointer",
            }}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Try again
          </button>
          <Link
            href="/"
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "10px 16px",
              borderRadius: "10px",
              border: "1px solid rgba(148, 163, 184, 0.25)",
              color: "#E2E8F0",
              textDecoration: "none",
              fontWeight: 600,
              fontSize: "14px",
            }}
          >
            Home
          </Link>
        </div>
      </section>
    </main>
  );
}
