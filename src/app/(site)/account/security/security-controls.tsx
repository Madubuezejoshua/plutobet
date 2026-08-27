"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface DeviceRow {
  id: string;
  device: string;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  current: boolean;
}

/**
 * Password change and device management.
 *
 * The two live together because they are the same job: making sure only the
 * account holder can get in. Changing a password signs every other device out,
 * so the list below is the evidence that it worked.
 */
export function SecurityControls({ devices }: { devices: DeviceRow[] }) {
  const router = useRouter();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [deviceBusy, setDeviceBusy] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < 10;

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const response = await fetch("/api/account/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? "That password could not be changed.");
        return;
      }
      setDone("Password changed. Every other device has been signed out.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      router.refresh();
    } catch {
      setError("Network problem — nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(body: { sessionId: string } | { all: true }, key: string) {
    setDeviceBusy(key);
    setDeviceError(null);
    try {
      const response = await fetch("/api/account/sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) {
        setDeviceError(result.message ?? "That device could not be signed out.");
        return;
      }
      router.refresh();
    } catch {
      setDeviceError("Network problem — nothing was changed.");
    } finally {
      setDeviceBusy(null);
    }
  }

  const active = devices.filter((device) => device.revokedAt === null);
  const otherActive = active.filter((device) => !device.current);

  return (
    <>
      <section className="card form-card">
        <h2>Change password</h2>
        <form onSubmit={changePassword}>
          <label className="field">
            Current password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </label>

          <label className="field">
            New password
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <span className="hint">At least 10 characters. Length beats complexity.</span>
          </label>

          <label className="field">
            Confirm new password
            <input
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </label>

          {tooShort ? <p className="notice error">Use at least 10 characters.</p> : null}
          {mismatch ? <p className="notice error">Those passwords do not match.</p> : null}

          <button
            type="submit"
            className="place"
            disabled={busy || mismatch || tooShort || !currentPassword || !newPassword}
          >
            {busy ? "Changing…" : "Change password"}
          </button>
        </form>

        {done ? <p className="notice ok">{done}</p> : null}
        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}

        <p className="muted small legal">
          Changing your password signs out every other device. The one you are using now stays
          signed in.
        </p>
      </section>

      <section className="card">
        <h2>Signed-in devices</h2>
        <p className="muted small">
          If you do not recognise one of these, sign it out and change your password.
        </p>

        {deviceError ? (
          <p className="notice error" role="alert">
            {deviceError}
          </p>
        ) : null}

        <div className="scroll-x">
          <table className="statement">
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">Last active</th>
                <th scope="col" className="right">Action</th>
              </tr>
            </thead>
            <tbody>
              {devices.length === 0 ? (
                <tr>
                  <td colSpan={3} className="muted">
                    No device sessions recorded yet. Sign out and back in to start tracking.
                  </td>
                </tr>
              ) : (
                devices.map((device) => (
                  <tr key={device.id}>
                    <td>
                      {device.device}
                      {device.current ? <span className="pill ok"> This device</span> : null}
                      {device.ip ? (
                        <>
                          <br />
                          <span className="muted small">{device.ip}</span>
                        </>
                      ) : null}
                    </td>
                    <td className="muted small">
                      {new Date(device.lastSeenAt).toLocaleString("en-NG")}
                      {device.revokedAt ? (
                        <>
                          <br />
                          <span className="pill critical">
                            {device.revokedReason ?? "Signed out"}
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td className="right">
                      {device.revokedAt || device.current ? (
                        <span className="muted small">—</span>
                      ) : (
                        <button
                          type="button"
                          className="btn sm danger"
                          disabled={deviceBusy === device.id}
                          onClick={() => revoke({ sessionId: device.id }, device.id)}
                        >
                          {deviceBusy === device.id ? "…" : "Sign out"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {otherActive.length > 0 ? (
          <p style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn danger"
              disabled={deviceBusy === "all"}
              onClick={() => revoke({ all: true }, "all")}
            >
              {deviceBusy === "all"
                ? "Signing out…"
                : `Sign out all other devices (${otherActive.length})`}
            </button>
          </p>
        ) : null}
      </section>
    </>
  );
}
