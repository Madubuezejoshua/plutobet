import { redirect } from "next/navigation";
import {
  AdminRequiredError,
  PermissionDeniedError,
  requirePermission,
} from "@/modules/admin/guard";
import { rbacService } from "@/modules/admin/rbac.service";
import { ROLE_LABELS } from "@/modules/admin/permissions";
import { RoleManager } from "./role-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Roles & Access" };

export default async function RolesPage() {
  let identity;
  try {
    identity = await requirePermission("admin.roles.read");
  } catch (error) {
    if (error instanceof AdminRequiredError) redirect("/api/auth/signin");
    if (error instanceof PermissionDeniedError) {
      return (
        <>
          <header className="page-head">
            <h1>Roles &amp; Access</h1>
          </header>
          <p className="notice error">{error.message}</p>
        </>
      );
    }
    throw error;
  }

  const canManage = identity.permissions.has("admin.roles.manage");

  const [administrators, grants] = await Promise.all([
    rbacService.listAdministrators(),
    rbacService.listGrants({ includeRevoked: true }),
  ]);

  return (
    <>
      <header className="page-head">
        <h1>Roles &amp; Access</h1>
        <p className="muted">Who can do what, and who decided.</p>
      </header>

      <RoleManager
        administrators={administrators}
        canManage={canManage}
        currentUserId={identity.userId}
      />

      <section className="card">
        <h2>Grant history</h2>
        <p className="muted small">
          Append-only. Revoking sets a timestamp rather than deleting the row, because &ldquo;who
          could do what, on the day it happened&rdquo; is a question that gets asked months later.
        </p>

        <div className="scroll-x">
          <table className="statement">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Account</th>
                <th scope="col">Role</th>
                <th scope="col">By</th>
                <th scope="col">Reason</th>
                <th scope="col" className="right">State</th>
              </tr>
            </thead>
            <tbody>
              {grants.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    No grants recorded.
                  </td>
                </tr>
              ) : (
                grants.map((grant) => (
                  <tr key={grant.id}>
                    <td className="muted small">
                      {grant.grantedAt.toLocaleDateString("en-NG")}
                    </td>
                    <td>{grant.email}</td>
                    <td>{ROLE_LABELS[grant.role]}</td>
                    <td className="muted small">{grant.grantedByEmail ?? "—"}</td>
                    <td className="muted small">
                      {grant.grantedReason}
                      {grant.revokedReason ? (
                        <>
                          <br />
                          <em>Revoked: {grant.revokedReason}</em>
                        </>
                      ) : null}
                    </td>
                    <td className="right">
                      {grant.revokedAt ? (
                        <span className="pill critical">Revoked</span>
                      ) : (
                        <span className="pill ok">Active</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
