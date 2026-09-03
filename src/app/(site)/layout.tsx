import type { ReactNode } from "react";
import { SportsbookShell } from "@/components/sportsbook/shell";

/**
 * Player-facing chrome: header, sports bar, footer, mobile bottom bar and the
 * betslip provider.
 *
 * `force-dynamic` because the shell reads the session and the wallet balance.
 * Rendering a cached header would eventually show one person another person's
 * balance, which is the sort of bug that ends a licence.
 */
export const dynamic = "force-dynamic";

export default function SiteLayout({ children }: { children: ReactNode }) {
  return <SportsbookShell>{children}</SportsbookShell>;
}
