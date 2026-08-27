import type { ReactNode } from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { walletForUser } from "@/modules/wallet/lookup";
import { walletService } from "@/modules/wallet/wallet.service";
import { nairaWhole } from "@/lib/money";
import { Masthead } from "./masthead";
import { BottomBar } from "./bottom-bar";
import { SiteFooter } from "./site-footer";

/**
 * The page frame every route renders inside.
 *
 * Session and balance are resolved HERE, on the server, and handed down as
 * plain props. The browser is never asked what a balance is — it only ever
 * receives a string that has already been decided.
 */
export async function SiteShell({ children }: { children: ReactNode }) {
  const session = await getServerSession(authOptions);
  const signedIn = Boolean(session?.user);

  return (
    <>
      <Masthead signedIn={signedIn} balance={signedIn ? await headerBalance(session!.user.id) : null} />
      <main className="shell">{children}</main>
      <SiteFooter />
      <BottomBar signedIn={signedIn} />
    </>
  );
}

/**
 * The balance shown in the header chip.
 *
 * Deliberately fault-tolerant. This is an ornament: the wallet page is the
 * authoritative view, and a transient database problem must not turn every
 * page on the site into an error. A failure logs and renders as "—" rather
 * than as a stale or invented number — the one thing it must never do is show
 * a figure that might be wrong.
 */
async function headerBalance(userId: string): Promise<string | null> {
  try {
    const walletId = await walletForUser(userId);
    if (!walletId) return null;
    return nairaWhole(await walletService.getBalance(walletId));
  } catch (error) {
    console.error("[shell] header balance unavailable", error);
    return null;
  }
}
