import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, authedRoute, money, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { withdrawalService } from "@/modules/payments/withdrawal.service";
import { walletForUser } from "@/modules/wallet/lookup";

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
