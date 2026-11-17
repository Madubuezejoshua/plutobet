import type { ReactNode } from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { liveSnapshot } from "@/modules/odds/live-feed";
import { walletForUser } from "@/modules/wallet/lookup";
import { walletService } from "@/modules/wallet/wallet.service";
import { dateOfBirthService } from "@/modules/users/date-of-birth.service";
import { DateOfBirthBanner } from "./date-of-birth-banner";
import { BetslipProvider } from "./betslip-store";
import { SportsbookShellFrame } from "./shell-frame";

/**
 * The sportsbook frame.
 *
 * Session, balance, and live fixture counts are resolved on the SERVER and
 * handed down cleanly. The browser never decides a balance.
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

  const [balanceMinor, needsDateOfBirth, liveCount] = await Promise.all([
    signedIn ? headerBalanceMinor(session!.user.id) : Promise.resolve(null),
    signedIn
      ? dateOfBirthService.isMissing(session!.user.id).catch((error: unknown) => {
          console.error("[sb-shell] date-of-birth check unavailable", error);
          return false;
        })
      : Promise.resolve(false),
    liveSnapshot("football")
      .then((snap) => snap.events.filter((e) => e.status === "LIVE").length)
      .catch(() => 0),
  ]);

  return (
    <BetslipProvider>
      <SportsbookShellFrame
        signedIn={signedIn}
        balanceMinor={balanceMinor}
        liveCount={liveCount}
        sports={showSports ? SPORTS : []}
        activeSport={activeSport}
        banner={needsDateOfBirth ? <DateOfBirthBanner /> : undefined}
      >
        {children}
      </SportsbookShellFrame>
    </BetslipProvider>
  );
}

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
