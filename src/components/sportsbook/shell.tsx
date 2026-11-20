import type { ReactNode } from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { getSportCounts } from "@/modules/odds/odds.service";
import { SPORTS_CATALOG } from "@/modules/odds/sports-catalog";
import { walletForUser } from "@/modules/wallet/lookup";
import { walletService } from "@/modules/wallet/wallet.service";
import { dateOfBirthService } from "@/modules/users/date-of-birth.service";
import { DateOfBirthBanner } from "./date-of-birth-banner";
import { BetslipProvider } from "./betslip-store";
import { SportsbookShellFrame, type ShellSportItem } from "./shell-frame";

/**
 * The sportsbook frame.
 *
 * Session, balance, and live/upcoming sport counts are resolved on the SERVER
 * in one grouped query and handed down cleanly. The browser never decides a
 * balance.
 */

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

  const [balanceMinor, needsDateOfBirth, sportCounts] = await Promise.all([
    signedIn ? headerBalanceMinor(session!.user.id) : Promise.resolve(null),
    signedIn
      ? dateOfBirthService.isMissing(session!.user.id).catch((error: unknown) => {
          console.error("[sb-shell] date-of-birth check unavailable", error);
          return false;
        })
      : Promise.resolve(false),
    getSportCounts().catch(() => ({} as Record<string, { upcoming: number; live: number }>)),
  ]);

  const sports: ShellSportItem[] = SPORTS_CATALOG.map((sport) => {
    const counts = sportCounts[sport.key];
    return {
      key: sport.key,
      label: sport.label,
      href: `/sports?sport=${sport.key}`,
      upcoming: counts?.upcoming ?? 0,
      live: counts?.live ?? 0,
    };
  });

  const liveCount = Object.values(sportCounts).reduce((sum, entry) => sum + entry.live, 0);

  return (
    <BetslipProvider>
      <SportsbookShellFrame
        signedIn={signedIn}
        balanceMinor={balanceMinor}
        liveCount={liveCount}
        sports={showSports ? sports : []}
        allSports={sports}
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
