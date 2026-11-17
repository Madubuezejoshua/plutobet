import { NextResponse } from "next/server";
import { ApiError, authedRoute, money, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { walletForUser } from "@/modules/wallet/lookup";
import { walletService } from "@/modules/wallet/wallet.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Balance and recent statement for the signed-in user. */
export const GET = authedRoute(
  "wallet",
  RATE_RULES.wallet,
  async ({ userId }: AuthedRouteContext) => {
    const walletId = await walletForUser(userId);
    if (!walletId) throw new ApiError(409, "NO_WALLET", "this account has no NGN wallet");

    const [balanceMinor, statement] = await Promise.all([
      walletService.getBalance(walletId),
      walletService.getStatement(walletId, { limit: 25 }),
    ]);

    return NextResponse.json({
      walletId,
      balanceMinor: money(balanceMinor),
      entries: statement.entries.map((entry) => ({
        id: entry.id,
        direction: entry.direction,
        amountMinor: money(entry.amountMinor),
        balanceAfterMinor: money(entry.balanceAfterMinor),
        type: entry.type,
        reference: entry.reference,
        createdAt: entry.createdAt.toISOString(),
      })),
    });
  },
);
