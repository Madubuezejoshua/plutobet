import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import {
  AdminRequiredError,
  PermissionDeniedError,
  requirePermission,
} from "@/modules/admin/guard";
import type { Permission } from "@/modules/admin/permissions";

/**
 * The guard every admin page repeats.
 *
 * Each page was opening with the same twenty lines: try requirePermission,
 * redirect on AdminRequiredError, render a notice on PermissionDeniedError,
 * rethrow anything else. Copied eight more times that stops being a pattern
 * and becomes eight chances to get the deny path subtly wrong — and the way
 * it goes wrong is that a page renders data to somebody who should not see it.
 *
 * Returns a discriminated union rather than throwing, so the caller cannot
 * accidentally continue past a denial: there is no `identity` to read unless
 * `ok` is true.
 */
export type Guarded =
  | { ok: true; identity: Awaited<ReturnType<typeof requirePermission>> }
  | { ok: false; denied: ReactNode };

export async function guardAdminPage(
  permission: Permission,
  title: string,
): Promise<Guarded> {
  try {
    return { ok: true, identity: await requirePermission(permission) };
  } catch (error) {
    if (error instanceof AdminRequiredError) redirect("/signin");
    if (error instanceof PermissionDeniedError) {
      return {
        ok: false,
        denied: (
          <>
            <header className="page-head">
              <h1>{title}</h1>
            </header>
            <p className="notice error">{error.message}</p>
          </>
        ),
      };
    }
    throw error;
  }
}
