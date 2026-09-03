import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, authedRoute, money, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { withdrawalService } from "@/modules/payments/withdrawal.service";
import { walletForUser } from "@/modules/wallet/lookup";
import { bankListService } from "@/modules/payments/bank-list.service";

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
  accountName: z.string().min(2).max(120),
  idempotencyKey: z.string().min(8).max(200),
});

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

    const record = await withdrawalService.requestWithdrawal({
      userId,
      walletId,
      amountMinor: body.amountMinor,
      bankCode: body.bankCode,
      accountNumber: body.accountNumber,
      accountName: body.accountName,
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
