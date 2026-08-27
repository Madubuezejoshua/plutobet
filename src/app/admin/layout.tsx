import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminRequiredError, requireAdminIdentity } from "@/modules/admin/guard";
import { visibleNav } from "@/modules/admin/navigation";
import { ROLE_LABELS } from "@/modules/admin/permissions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin" };

/**
 * Admin chrome.
 *
 * Gates the whole subtree once, and renders a sidebar containing only what
 * this particular administrator may reach. Every page below still calls
 * `requirePermission` for itself — the filtered sidebar is a courtesy, and a
 * hidden link that is reachable by typing the URL would be the classic
 * mistake here.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  let identity;
  try {
    identity = await requireAdminIdentity();
  } catch (error) {
    if (error instanceof AdminRequiredError) redirect("/api/auth/signin");
    throw error;
  }

  const sections = visibleNav(identity.permissions);

  return (
    <>
      <header className="masthead">
        <div className="shell masthead-inner">
          <Link href="/admin" className="brand">
            <span className="brand-mark" aria-hidden="true">
              ◆
            </span>
            Pluto<em>Admin</em>
          </Link>

          <div className="admin-whoami">
            <span className="muted small">{identity.email}</span>
            <span className="admin-roles">
              {identity.roles.length === 0 ? (
                <span className="pill critical">No roles</span>
              ) : (
                identity.roles.map((role) => (
                  <span key={role} className="pill">
                    {ROLE_LABELS[role]}
                  </span>
                ))
              )}
            </span>
          </div>

          <div className="masthead-actions">
            <Link href="/" className="btn ghost sm">
              Exit to site
            </Link>
          </div>
        </div>
      </header>

      <div className="shell admin-shell">
        <nav className="admin-sidebar" aria-label="Admin sections">
          {sections.length === 0 ? (
            <p className="muted small">
              No sections are available to your roles. Ask a super admin for access.
            </p>
          ) : (
            sections.map((section) => (
              <div className="admin-nav-group" key={section.label}>
                <h3>{section.label}</h3>
                {section.items.map((item) => (
                  <Link key={item.key} href={item.href} className="admin-nav-link">
                    {item.label}
                    {item.built ? null : <span className="soon">P{item.phase}</span>}
                  </Link>
                ))}
              </div>
            ))
          )}
        </nav>

        <main className="admin-main">{children}</main>
      </div>
    </>
  );
}
