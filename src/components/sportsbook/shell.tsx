import type { ReactNode } from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { walletForUser } from "@/modules/wallet/lookup";
import { walletService } from "@/modules/wallet/wallet.service";
import { dateOfBirthService } from "@/modules/users/date-of-birth.service";
import { DateOfBirthBanner } from "./date-of-birth-banner";
import { BetslipProvider } from "./betslip-store";
import { SportsbookHeader } from "./header";
import { MobileBar } from "./mobile-bar";
import { SportsbookFooter } from "./footer";

/**
 * The sportsbook frame.
 *
 * Session and balance are resolved on the SERVER and handed down as strings.
 * The browser is never asked what a balance is — it receives a figure that has
 * already been decided, which is the same rule the previous shell followed and
 * the reason it is repeated here rather than "improved".
 *
 * The betslip provider wraps everything so a selection survives navigating
 * between the board, a league page and an event page.
 */

const SPORTS = [
  { key: "football", label: "Football", href: "/sports?sport=football" },
  { key: "basketball", label: "Basketball", href: "/sports?sport=basketball" },
  { key: "tennis", label: "Tennis", href: "/sports?sport=tennis" },
  { key: "table-tennis", label: "Table Tennis", href: "/sports?sport=table-tennis" },
  { key: "esports", label: "Esports", href: "/sports?sport=esports" },
];

export async function SportsbookShell({
  children,
  activeSport = "football",
  showSports = true,
}: {
  children: ReactNode;
  activeSport?: string;
  showSports?: boolean;
}) {
  const session = await getServerSession(authOptions);
  const signedIn = Boolean(session?.user);
  const balanceMinor = signedIn ? await headerBalanceMinor(session!.user.id) : null;

  /*
   * "Ask at the next authenticated session" is implemented here because this is
   * the one component every signed-in page renders through.
   *
   * It is a banner rather than a forced redirect. A redirect from every page
   * would also bounce someone reading the responsible-gambling controls or the
   * terms, which are exactly the pages a customer being asked for personal data
   * may want to read first. The banner is unmissable and the ENFORCEMENT is
   * elsewhere: placement and withdrawal refuse inside their own transactions,
   * so nothing depends on the customer having seen this.
   *
   * A failed lookup shows nothing rather than blocking the site — the gates
   * still hold, and a database blip must not lock everyone out of browsing.
   */
  const needsDateOfBirth = signedIn
    ? await dateOfBirthService
        .isMissing(session!.user.id)
        .catch((error: unknown) => {
          console.error("[sb-shell] date-of-birth check unavailable", error);
          return false;
        })
    : false;

  return (
    <BetslipProvider>
      <div className="sb">
        <SportsbookHeader
          signedIn={signedIn}
          balanceMinor={balanceMinor}
          sports={showSports ? SPORTS : []}
          activeSport={activeSport}
        />
        {needsDateOfBirth ? <DateOfBirthBanner /> : null}
        {children}
        <SportsbookFooter />
        <MobileBar signedIn={signedIn} balanceMinor={balanceMinor} />
      </div>
    </BetslipProvider>
  );
}

/**
 * The balance for the header, in minor units.
 *
 * Deliberately fault-tolerant: this is an ornament, the wallet page is the
 * authoritative view, and a transient database problem must not turn every
 * page into an error. A failure renders as "—" rather than as a stale or
 * invented figure — the one thing it must never do is show a number that might
 * be wrong.
 */
async function headerBalanceMinor(userId: string): Promise<string | null> {
  try {
    const walletId = await walletForUser(userId);
    if (!walletId) return null;
    return (await walletService.getBalance(walletId)).toString();
  } catch (error) {
    console.error("[sb-shell] header balance unavailable", error);
    return null;
  }
}
