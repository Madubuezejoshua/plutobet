import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, authedRoute, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { bankListService } from "@/modules/payments/bank-list.service";
import { paymentProviderForReads } from "@/modules/payments/factory";
import { AccountResolutionError } from "@/modules/payments/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resolves a bank account to the name the PROVIDER holds for it.
 *
 * WHY THIS ROUTE EXISTS. The withdrawal form used to ask the customer to type
 * the account name, and the withdrawal route accepted whatever arrived. The
 * number and the code decide where money lands, so a wrong name did not
 * misdirect it — but it removed the only chance to notice that the customer had
 * entered somebody else's account, and it put an unverified string on the
 * payout record. A live probe posting `"ATTACKER SUPPLIED NAME"` was answered
 * 201.
 *
 * WHAT IS DELIBERATE ABOUT THE SHAPE OF IT
 *
 *  - **Authenticated.** Anonymous access would make this a free name-lookup
 *    service for any Nigerian account number, which is a privacy leak whoever
 *    is paying for the API calls.
 *  - **Rate limited by user**, on its own budget. See `RATE_RULES.resolveAccount`
 *    for why it is not the withdrawal budget.
 *  - **Validated here, not only in the browser.** The form is a suggestion; the
 *    request is what arrives.
 *  - **The bank code is checked against the provider's own list first**, so a
 *    made-up code is refused locally rather than spending a provider call.
 *  - **It returns the name and nothing else.** No provider payload, no
 *    credential, no internal identifier.
 *
 * THE SECRET KEY NEVER REACHES THE BROWSER. It is read from the environment
 * inside the adapter, on the server, and the response carries only a string a
 * customer is meant to read.
 */
const requestSchema = z.object({
  // Nigerian NUBAN account numbers are exactly 10 digits.
  accountNumber: z.string().regex(/^\d{10}$/, "account number must be 10 digits"),
  bankCode: z.string().regex(/^\d{3,6}$/, "invalid bank code"),
});

export const POST = authedRoute(
  "resolve-account",
  RATE_RULES.resolveAccount,
  async ({ request }: AuthedRouteContext) => {
    const body = requestSchema.parse(await request.json());

    /*
     * Refuse a bank code the provider does not publish, before spending a call
     * on it. `isPayableBankCode` passes when the list cannot be established —
     * the same deliberate choice the withdrawal route documents — so a provider
     * outage does not turn into "you cannot check your account either".
     */
    if (!(await bankListService.isPayableBankCode(body.bankCode))) {
      throw new ApiError(
        422,
        "UNKNOWN_BANK",
        "we do not recognise that bank. Choose one from the list.",
      );
    }

    try {
      const resolved = await paymentProviderForReads().resolveBankAccount({
        bankCode: body.bankCode,
        accountNumber: body.accountNumber,
      });
      return NextResponse.json({
        accountName: resolved.accountName,
        accountNumber: resolved.accountNumber,
        bankCode: resolved.bankCode,
        /*
         * Told plainly, so the interface can say so. A sandbox answer verifies
         * nothing, and a customer looking at "SANDBOX — NOT REAL" should not
         * have to infer that from the text.
         */
        sandbox: resolved.sandbox,
      });
    } catch (error) {
      if (error instanceof AccountResolutionError) {
        /*
         * Three reasons, three answers, because they need different actions.
         * 422 is the customer's typo. 503 is ours — theirs to retry, not to
         * correct. Collapsing them would either blame a customer for an outage
         * or invite them to retype a number that will never resolve.
         */
        const status = error.reason === "NOT_FOUND" ? 422 : 503;
        throw new ApiError(status, `ACCOUNT_${error.reason}`, error.message);
      }
      throw error;
    }
  },
);
