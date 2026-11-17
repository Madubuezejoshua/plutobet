"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function KycReviewActions({ kycRecordId }: { kycRecordId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "APPROVE" | "REJECT") {
    if (decision === "REJECT") {
      const note = window.prompt("Reason for rejection (shown to the player):");
      if (note === null) return;
      await send(decision, note || undefined);
      return;
    }
    await send(decision);
  }

  async function send(decision: "APPROVE" | "REJECT", note?: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/kyc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kycRecordId, decision, note }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? "That decision could not be recorded.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network problem — nothing was recorded.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          className="place"
          style={{ width: "auto", padding: "6px 14px" }}
          disabled={busy}
          onClick={() => decide("APPROVE")}
        >
          Approve
        </button>
        <button
          type="button"
          className="place"
          style={{ width: "auto", padding: "6px 14px", background: "var(--danger, #c0392b)" }}
          disabled={busy}
          onClick={() => decide("REJECT")}
        >
          Reject
        </button>
      </div>
      {error ? (
        <span className="notice error small" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
