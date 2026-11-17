import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, authedRoute, money, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { withdrawalService } from "@/modules/payments/withdrawal.service";
import { walletForUser } from "@/modules/wallet/lookup";
import { bankListService } from "@/modules/payments/bank-list.service";
import { paymentProviderForReads } from "@/modules/payments/factory";
import { AccountResolutionError } from "@/modules/payments/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  amountMinor: z
    .string()
    .regex(/^\d+$/, "amount must be a whole number of kobo")
    .transform((value) => BigInt(value)),
  // Nigerian NUBAN account numbers are exactly 10 digits.
  accountNumber: z.string().regex(/^\d{10}$/, "account number must be 10 digits"),
  bankCode: z.string().regex(/^\d{3,6}$/, "invalid bank code"),
  /*
   * THE NAME THE CUSTOMER WAS SHOWN, AND CONFIRMED — NOT THE NAME OF RECORD.
   *
   * It is required so the customer must have gone through resolution and
   * agreed to what came back, and it is NEVER what gets stored. The route
   * re-resolves against the provider below and writes the PROVIDER'S answer.
   * This field exists only to be compared, so that a stale screen — one where
   * the number changed after the name was fetched — is refused rather than
   * silently paid to whoever the new number belongs to.
   */
  confirmedAccountName: z.string().min(2).max(120),
  idempotencyKey: z.string().min(8).max(200),
});

/**
 * Two names refer to the same account holder.
 *
 * Deliberately EXACT after collapsing case and whitespace, and nothing more.
 * No fuzzy matching, no initials, no transliteration, no edit distance. Those
 * are the rules of a KYC name-matching policy, that policy has not been
 * written, and inventing one here would mean a developer deciding how close
 * two names must be before somebody's money moves. Where the provider's answer
 * differs at all from what the customer confirmed, the withdrawal is refused
 * and the customer re-confirms — which is a worse experience than a clever
 * matcher and a far better one than a wrong payout.
 */
function sameAccountHolder(a: string, b: string): boolean {
  const normalise = (value: string) => value.trim().replace(/\s+/g, " ").toUpperCase();
  return normalise(a) === normalise(b);
}

/**
 * Requests a withdrawal.
 *
 * The funds are debited synchronously here — the hold happens at request
 * time, not at payout, so the same balance cannot be staked while a transfer
 * is in flight. Approval and the bank transfer follow asynchronously.
 */
export const POST = authedRoute(
  "withdrawal",
  RATE_RULES.withdrawal,
  async ({ request, userId, ip }: AuthedRouteContext) => {
    const body = requestSchema.parse(await request.json());

    const walletId = await walletForUser(userId);
    if (!walletId) throw new ApiError(409, "NO_WALLET", "this account has no NGN wallet");

    /*
     * Check the bank code against the provider's own list before taking a hold.
     *
     * The form offers a select, but a form is a suggestion — the request is what
     * arrives, and a caller posting directly can put anything in this field. A
     * code that is merely well-formed reaches the provider and either fails
     * there, after the customer's balance has already been held, or worse
     * succeeds against a different institution.
     *
     * It passes when the list cannot be established, deliberately: refusing
     * every withdrawal because a bank list could not be fetched would turn a
     * provider outage into an inability to take money out. The transfer
     * re-validates, and this exists to catch a typo early with a clear message.
     */
    if (!(await bankListService.isPayableBankCode(body.bankCode))) {
      throw new ApiError(
        422,
        "UNKNOWN_BANK",
        "we do not recognise that bank. Choose one from the list.",
      );
    }

    /*
     * RE-RESOLVE, AND USE THE PROVIDER'S ANSWER.
     *
     * This route used to accept `accountName` from the request body and pass it
     * straight through to the transfer. A live probe posted
     * `"ATTACKER SUPPLIED NAME"` and was answered 201, and that name would have
     * gone onto the payout record. The account number and bank code decide
     * where money lands, so nothing was misdirected by it — but the name is the
     * one signal that would tell a customer they had typed a stranger's account,
     * and it was worth exactly nothing while the browser chose it.
     *
     * Resolution happens BEFORE the hold, so a customer whose account cannot be
     * verified never has their balance touched.
     */
    let resolved;
    try {
      resolved = await paymentProviderForReads().resolveBankAccount({
        bankCode: body.bankCode,
        accountNumber: body.accountNumber,
      });
    } catch (error) {
      if (error instanceof AccountResolutionError) {
        throw new ApiError(
          error.reason === "NOT_FOUND" ? 422 : 503,
          `ACCOUNT_${error.reason}`,
          error.message,
        );
      }
      throw error;
    }

    /*
     * The screen the customer agreed to must still be the account they are
     * paying. If the two disagree, the form moved underneath them — a changed
     * digit after the name was fetched — and paying out on a name they never
     * saw is the failure this whole exchange exists to prevent.
     */
    if (!sameAccountHolder(resolved.accountName, body.confirmedAccountName)) {
      throw new ApiError(
        409,
        "ACCOUNT_NAME_CHANGED",
        "the account details changed after you confirmed them. Check the account and confirm again.",
      );
    }

    const record = await withdrawalService.requestWithdrawal({
      userId,
      walletId,
      amountMinor: body.amountMinor,
      bankCode: body.bankCode,
      accountNumber: body.accountNumber,
      // The PROVIDER's name, never the browser's.
      accountName: resolved.accountName,
      ip,
      idempotencyKey: body.idempotencyKey,
    });

    return NextResponse.json(
      {
        withdrawalId: record.withdrawalId,
        status: record.status,
        amountMinor: money(record.amountMinor),
      },
      { status: 201 },
    );
  },
);
