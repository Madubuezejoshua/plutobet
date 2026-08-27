import type { ReactNode } from "react";
import { SiteShell } from "@/components/layout/site-shell";

/**
 * Player-facing chrome: masthead, footer, and the mobile bottom bar.
 *
 * `force-dynamic` because the shell reads the session and the wallet balance.
 * Rendering a cached header would eventually show one person another person's
 * balance, which is the sort of bug that ends a licence.
 */
export const dynamic = "force-dynamic";

export default function SiteLayout({ children }: { children: ReactNode }) {
  return <SiteShell>{children}</SiteShell>;
}
