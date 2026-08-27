"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const DOCUMENT_KINDS = [
  { value: "ID_FRONT", label: "Government ID — front" },
  { value: "ID_BACK", label: "Government ID — back" },
  { value: "SELFIE", label: "Selfie holding the ID" },
  { value: "PROOF_OF_ADDRESS", label: "Proof of address" },
] as const;

export function KycForm(props: {
  tier: number;
  hasIdentity: boolean;
  pendingDocument: boolean;
  rejectionNote: string | null;
}) {
  const router = useRouter();

  const [idType, setIdType] = useState<"bvn" | "nin">("bvn");
  const [idNumber, setIdNumber] = useState("");
  const [idBusy, setIdBusy] = useState(false);
  const [idError, setIdError] = useState<string | null>(null);
  const [idDone, setIdDone] = useState(false);

  const [kind, setKind] = useState<(typeof DOCUMENT_KINDS)[number]["value"]>("ID_FRONT");
  const [file, setFile] = useState<File | null>(null);
  const [docBusy, setDocBusy] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [docDone, setDocDone] = useState(false);

  async function submitIdentity(event: React.FormEvent) {
    event.preventDefault();
    setIdBusy(true);
    setIdError(null);
    try {
      const response = await fetch("/api/kyc/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [idType]: idNumber }),
      });
      const body = await response.json();
      if (!response.ok) {
        setIdError(body.message ?? "That could not be verified.");
        return;
      }
      setIdDone(true);
      router.refresh();
    } catch {
      setIdError("Network problem — nothing was submitted.");
    } finally {
      setIdBusy(false);
    }
  }

  async function submitDocument(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setDocBusy(true);
    setDocError(null);
    try {
      const form = new FormData();
      form.set("kind", kind);
      form.set("file", file);
      const response = await fetch("/api/kyc/documents", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) {
        setDocError(body.message ?? "That document could not be uploaded.");
        return;
      }
      setDocDone(true);
      setFile(null);
      router.refresh();
    } catch {
      setDocError("Network problem — nothing was uploaded.");
    } finally {
      setDocBusy(false);
    }
  }

  return (
    <>
      <section className="card form-card">
        <h2>Step 1 · Basic verification</h2>
        <p className="muted small">
          Confirms who you are and unlocks withdrawals up to ₦50,000 a day. We hash your BVN or
          NIN before it ever reaches storage — the raw number is never kept.
        </p>

        {props.hasIdentity || idDone ? (
          <p className="notice ok">Basic verification is on file for this account.</p>
        ) : (
          <form onSubmit={submitIdentity}>
            <label className="field">
              ID type
              <select value={idType} onChange={(e) => setIdType(e.target.value as "bvn" | "nin")}>
                <option value="bvn">BVN</option>
                <option value="nin">NIN</option>
              </select>
            </label>

            <label className="field">
              {idType.toUpperCase()}
              <input
                inputMode="numeric"
                required
                maxLength={11}
                pattern="\d{11}"
                value={idNumber}
                onChange={(e) => setIdNumber(e.target.value.replace(/\D/g, ""))}
              />
              <span className="hint">11 digits.</span>
            </label>

            {idError ? (
              <p className="notice error" role="alert">
                {idError}
              </p>
            ) : null}

            <button type="submit" className="place" disabled={idBusy || idNumber.length !== 11}>
              {idBusy ? "Verifying…" : "Verify"}
            </button>
          </form>
        )}
      </section>

      <section className="card form-card">
        <h2>Step 2 · Document review</h2>
        <p className="muted small">
          Raises your daily withdrawal limit to ₦500,000. Upload a clear photo — an admin reviews
          it manually, since no automated document checker is connected yet.
        </p>

        {props.pendingDocument || docDone ? (
          <p className="notice ok">
            Your document is with a reviewer. This page will update once it has been checked.
          </p>
        ) : (
          <>
            {props.rejectionNote ? (
              <p className="notice error">
                Your last submission was rejected: {props.rejectionNote}. You can try again below.
              </p>
            ) : null}
            <form onSubmit={submitDocument}>
              <label className="field">
                Document type
                <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                  {DOCUMENT_KINDS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                File
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  required
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                <span className="hint">JPEG, PNG, WebP, or PDF. Up to 10MB.</span>
              </label>

              {docError ? (
                <p className="notice error" role="alert">
                  {docError}
                </p>
              ) : null}

              <button type="submit" className="place" disabled={docBusy || !file}>
                {docBusy ? "Uploading…" : "Upload"}
              </button>
            </form>
          </>
        )}
      </section>
    </>
  );
}
