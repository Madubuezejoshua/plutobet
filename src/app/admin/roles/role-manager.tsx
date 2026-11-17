"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ADMIN_ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  permissionsOfRole,
  type AdminRole,
} from "@/modules/admin/permissions";

export interface AdministratorRow {
  userId: string;
  email: string;
  status: string;
  roles: AdminRole[];
}

/**
 * Grant and revoke admin roles.
 *
 * Every change needs a written reason and a password. The password is not sent
 * with the change — it opens a short server-side window first, so the thing
 * being checked is something the server saw, not a claim in the request body.
 */
export function RoleManager({
  administrators,
  canManage,
  currentUserId,
}: {
  administrators: AdministratorRow[];
  canManage: boolean;
  currentUserId: string;
}) {
  const router = useRouter();

  const [target, setTarget] = useState<AdministratorRow | null>(null);
  const [action, setAction] = useState<"GRANT" | "REVOKE">("GRANT");
  const [role, setRole] = useState<AdminRole>("SUPPORT_AGENT");
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function open(row: AdministratorRow, mode: "GRANT" | "REVOKE", preselect?: AdminRole) {
    setTarget(row);
    setAction(mode);
    if (preselect) setRole(preselect);
    setReason("");
    setPassword("");
    setError(null);
    setDone(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!target) return;

    setBusy(true);
    setError(null);
    try {
      // Step one: prove it is still you. This writes a short-lived record on
      // the server; nothing about it travels with the change itself.
      const reauth = await fetch("/api/admin/reauth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!reauth.ok) {
        const body = await reauth.json();
        setError(body.message ?? "That password is not correct.");
        return;
      }

      // Step two: the change.
      const response = await fetch("/api/admin/roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          targetUserId: target.userId,
          role,
          reason,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? "That change could not be made.");
        return;
      }

      setDone(
        `${action === "GRANT" ? "Granted" : "Revoked"} ${ROLE_LABELS[role]} ${
          action === "GRANT" ? "to" : "from"
        } ${target.email}.`,
      );
      setTarget(null);
      setPassword("");
      setReason("");
      router.refresh();
    } catch {
      setError("Network problem — nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {done ? <p className="notice ok">{done}</p> : null}

      <section className="card">
        <h2>Administrators</h2>
        <p className="muted small">
          Holding the <code>ADMIN</code> flag opens the door; the roles below decide what is
          behind it. An administrator with no roles can see the admin area and nothing in it.
        </p>

        <div className="scroll-x">
          <table className="statement">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Roles</th>
                {canManage ? <th scope="col" className="right">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {administrators.map((row) => (
                <tr key={row.userId}>
                  <td>
                    {row.email}
                    {row.userId === currentUserId ? (
                      <>
                        {" "}
                        <span className="pill ok">You</span>
                      </>
                    ) : null}
                    {row.status !== "ACTIVE" ? (
                      <>
                        <br />
                        <span className="pill critical">{row.status.replace(/_/g, " ")}</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {row.roles.length === 0 ? (
                      <span className="pill warning">No roles</span>
                    ) : (
                      <span style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                        {row.roles.map((held) => (
                          <span key={held} className="pill">
                            {ROLE_LABELS[held]}
                            {canManage && row.userId !== currentUserId ? (
                              <button
                                type="button"
                                aria-label={`Revoke ${ROLE_LABELS[held]}`}
                                onClick={() => open(row, "REVOKE", held)}
                                style={{
                                  marginLeft: 6,
                                  background: "none",
                                  border: 0,
                                  color: "inherit",
                                  cursor: "pointer",
                                  font: "inherit",
                                }}
                              >
                                ✕
                              </button>
                            ) : null}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  {canManage ? (
                    <td className="right">
                      {row.userId === currentUserId ? (
                        <span className="muted small">Cannot edit yourself</span>
                      ) : (
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => open(row, "GRANT")}
                        >
                          Grant role
                        </button>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canManage ? (
          <p className="muted small legal">
            You cannot change your own roles, and the last super admin cannot be revoked —
            otherwise a single mistake would leave nobody able to grant anything.
          </p>
        ) : (
          <p className="muted small legal">
            You have read-only access here. Only a super admin can change roles.
          </p>
        )}
      </section>

      {target ? (
        <section className="card form-card">
          <h2>
            {action === "GRANT" ? "Grant" : "Revoke"} role — {target.email}
          </h2>

          <form onSubmit={submit}>
            <label className="field">
              Role
              <select value={role} onChange={(e) => setRole(e.target.value as AdminRole)}>
                {(action === "REVOKE" ? target.roles : ADMIN_ROLES).map((option) => (
                  <option key={option} value={option}>
                    {ROLE_LABELS[option]}
                  </option>
                ))}
              </select>
              <span className="hint">{ROLE_DESCRIPTIONS[role]}</span>
            </label>

            <details style={{ marginBottom: 14 }}>
              <summary className="muted small" style={{ cursor: "pointer" }}>
                What this role can do ({permissionsOfRole(role).length} permissions)
              </summary>
              <p className="muted small" style={{ marginTop: 8, lineHeight: 1.8 }}>
                {permissionsOfRole(role).map((permission) => (
                  <code key={permission} style={{ marginRight: 8 }}>
                    {permission}
                  </code>
                ))}
              </p>
            </details>

            <label className="field">
              Reason
              <input
                required
                minLength={3}
                maxLength={500}
                placeholder="Why is this change being made?"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <span className="hint">Recorded in the audit log. Required.</span>
            </label>

            <label className="field">
              Confirm your password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <span className="hint">
                Granting authority is what a stolen session would reach for first.
              </span>
            </label>

            {error ? (
              <p className="notice error" role="alert">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              className="place"
              disabled={busy || reason.trim().length < 3 || !password}
            >
              {busy
                ? "Working…"
                : `${action === "GRANT" ? "Grant" : "Revoke"} ${ROLE_LABELS[role]}`}
            </button>
            <button type="button" className="link-button" onClick={() => setTarget(null)}>
              Cancel
            </button>
          </form>
        </section>
      ) : null}
    </>
  );
}
