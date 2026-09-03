import { NextResponse } from "next/server";
import { authedRoute } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { bankListService } from "@/modules/payments/bank-list.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Banks a withdrawal can be paid to.
 *
 * AUTHENTICATED, though the list itself is not secret. It is only useful to
 * someone about to withdraw, it costs a provider call to produce, and leaving it
 * open would put an unauthenticated path in front of a third-party API we pay
 * for. The `wallet` budget rather than `browse`: this is a money-flow page, not
 * something anyone scrolls.
 *
 * NEVER A HARD-CODED LIST. The codes come from the payment provider, which is
 * the same party that will accept or refuse the transfer. A list written into
 * source is wrong from the day it is typed — Nigerian banks merge and
 * microfinance banks come and go — and a stale code sends real money to a
 * different institution rather than failing.
 *
 * The response says how good the answer is rather than pretending. `stale` means
 * the provider could not be reached and this came from cache; `unavailable`
 * means there is no list at all, and the form falls back to a typed code with an
 * explanation rather than showing an empty select.
 */
export const GET = authedRoute("wallet", RATE_RULES.wallet, async () => {
  const result = await bankListService.list();

  return NextResponse.json(
    {
      banks: result.banks,
      stale: result.stale,
      unavailable: result.unavailable,
    },
    {
      headers: {
        /*
         * Private and short. The list is per-deployment rather than per-user,
         * but it arrives on an authenticated route, and a shared cache holding
         * a response from an authenticated endpoint is a habit worth not
         * forming. The service's own cache is what actually spares the
         * provider.
         */
        "cache-control": "private, max-age=300",
      },
    },
  );
});
