import { eq, sql } from "drizzle-orm";
import { appendAuditLog } from "../audit/append";
import { walletService, WalletService } from "../wallet/wallet.service";
import type { AdminActor } from "../wallet/types";
import { dateOfBirthService } from "../users/date-of-birth.service";
import {
  AccountNotWithdrawableError,
  KycLimitError,
  WithdrawalRejectedError,
} from "./errors";
import type { PaymentProvider } from "./provider";
import { withdrawals } from "./schema";

export { AccountNotWithdrawableError, KycLimitError, WithdrawalRejectedError };

/**
 * Withdrawals: request, approval, payout, reconciliation.
 *
 * The money leaves the user's spendable balance at REQUEST time, not at
 * payout. Holding it up front is what stops the same balance being staked or
 * withdrawn again while a bank transfer is in flight; a rejected or failed
 * transfer refunds it. The alternative — debit on payout — leaves a window
 * where the balance is committed to two places at once.
 */

export interface KycWithdrawalLimits {
  /** Per KYC level, the most that may be withdrawn in a rolling 24 hours. */
  dailyCapMinor: Record<number, bigint>;
  minWithdrawalMinor: bigint;
}

export const DEFAULT_WITHDRAWAL_LIMITS: KycWithdrawalLimits = {
  dailyCapMinor: {
    // Unverified accounts cannot cash out at all: an account that can take
    // money out without ever proving who owns it is a laundering route, and
    // SCUML/AML expectations do not permit it.
    0: 0n,
    1: 5_000_000n, // ₦50,000
    2: 50_000_000n, // ₦500,000
    3: 500_000_000n, // ₦5,000,000
  },
  minWithdrawalMinor: 10_000n, // ₦100
};

export interface RequestWithdrawalParams {
  userId: string;
  walletId: string;
  amountMinor: bigint;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  ip: string;
  idempotencyKey: string;
}

export interface WithdrawalRecord {
  withdrawalId: string;
  status: string;
  amountMinor: bigint;
  debitTxnId: string;
}

export class WithdrawalService {
  constructor(
    private readonly wallet: WalletService = walletService,
    private readonly limits: KycWithdrawalLimits = DEFAULT_WITHDRAWAL_LIMITS,
  ) {}

  /**
   * Requests a withdrawal, holding the funds in the same transaction.
   *
   * Lock order matches the rest of the system — the wallet row is taken first
   * and held for the whole request, which is also what makes the rolling
   * daily cap safe: two concurrent requests cannot each read the same
   * pre-debit total and jointly exceed it.
   */
  async requestWithdrawal(params: RequestWithdrawalParams): Promise<WithdrawalRecord> {
    if (params.amountMinor < this.limits.minWithdrawalMinor) {
      throw new WithdrawalRejectedError(
        `minimum withdrawal is ${this.limits.minWithdrawalMinor}`,
      );
    }

    return this.wallet.withMoneyTransaction(async ({ tx, debit }) => {
      // Take the wallet lock before reading anything we will decide on.
      const [wallet] = await tx.execute<{ id: string; user_id: string }>(sql`
        SELECT id, user_id FROM wallets
        WHERE id = ${params.walletId}::uuid AND kind = 'USER'
        FOR UPDATE
      `);
      if (!wallet || wallet.user_id !== params.userId) {
        throw new WithdrawalRejectedError("wallet does not belong to this user");
      }

      const [account] = await tx.execute<{ status: string; kyc_level: number }>(sql`
        SELECT status::text AS status, kyc_level FROM users WHERE id = ${params.userId}::uuid
      `);
      if (!account) throw new WithdrawalRejectedError("unknown user");

      // A self-excluded user may still take their own money out — trapping
      // it would punish the person for using the protection. A SUSPENDED
      // account is under investigation and may not.
      if (account.status === "SUSPENDED") {
        throw new AccountNotWithdrawableError(params.userId, account.status);
      }

      /*
       * No payout to an account whose holder has never been age-verified.
       *
       * Unlike self-exclusion — where trapping the money would punish someone
       * for using the protection — this is a customer we cannot confirm should
       * have an account at all. The money is not lost; it is held until they
       * complete one screen, and the completion flow is offered at every
       * authenticated session until they do.
       */
      if (await dateOfBirthService.isMissingWithin(tx, params.userId)) {
        throw new AccountNotWithdrawableError(params.userId, "DATE_OF_BIRTH_REQUIRED");
      }

      await this.assertWithinDailyCap(tx, params.userId, account.kyc_level, params.amountMinor);

      // The debit is the hold. If anything below fails, this rolls back with
      // it and the user's balance is untouched.
      const held = await debit({
        walletId: params.walletId,
        amountMinor: params.amountMinor,
        type: "WITHDRAWAL",
        idempotencyKey: params.idempotencyKey,
        actor: { type: "USER", id: params.userId, ip: params.ip },
        metadata: { kind: "WITHDRAWAL_HOLD" },
      });

      const [row] = await tx
        .insert(withdrawals)
        .values({
          userId: params.userId,
          amountMinor: params.amountMinor,
          bankCode: params.bankCode,
          accountNumber: params.accountNumber,
          accountName: params.accountName,
          status: "REQUESTED",
          debitTxnId: held.transactionId,
        })
        .returning({ id: withdrawals.id });
      if (!row) throw new Error("withdrawal insert returned no row");

      return {
        withdrawalId: row.id,
        status: "REQUESTED",
        amountMinor: params.amountMinor,
        debitTxnId: held.transactionId,
      };
    });
  }

  /**
   * Rolling 24-hour cap by KYC level.
   *
   * Counts everything that has not been refunded — a pending or paid
   * withdrawal both represent money on its way out. Only rejected and failed
   * requests, whose money came back, are excluded.
   */
  private async assertWithinDailyCap(
    tx: Parameters<Parameters<WalletService["withMoneyTransaction"]>[0]>[0]["tx"],
    userId: string,
    kycLevel: number,
    amountMinor: bigint,
  ): Promise<void> {
    const cap = this.limits.dailyCapMinor[kycLevel] ?? 0n;
    if (cap === 0n) throw new KycLimitError(kycLevel, cap, amountMinor);

    const [row] = await tx.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(amount_minor), 0)::text AS total
      FROM withdrawals
      WHERE user_id = ${userId}::uuid
        AND created_at > now() - interval '24 hours'
        AND status NOT IN ('REJECTED', 'FAILED')
    `);
    const alreadyOut = BigInt(row?.total ?? "0");
    if (alreadyOut + amountMinor > cap) {
      throw new KycLimitError(kycLevel, cap, alreadyOut + amountMinor);
    }
  }

  /**
   * Admin approval. §3.14: re-authentication, a mandatory reason, and its own
   * audit row separate from any ledger entry.
   */
  async approve(withdrawalId: string, admin: AdminActor): Promise<void> {
    if (!admin.reason?.trim()) {
      throw new WithdrawalRejectedError("an approval reason is required");
    }
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      const before = await this.lockWithdrawal(tx, withdrawalId, "REQUESTED");

      await tx
        .update(withdrawals)
        .set({
          status: "APPROVED",
          approvedBy: admin.id,
          approvalReason: admin.reason,
          updatedAt: new Date(),
        })
        .where(eq(withdrawals.id, withdrawalId));

      await appendAuditLog(tx, {
        actorType: "ADMIN",
        actorId: admin.id,
        action: "WITHDRAWAL_APPROVED",
        entity: "withdrawals",
        entityId: withdrawalId,
        reason: admin.reason,
        before: { status: before.status },
        after: { status: "APPROVED" },
        ip: admin.ip,
      });
    });
  }

  /** Rejects a request and returns the held funds. */
  async reject(withdrawalId: string, admin: AdminActor): Promise<void> {
    if (!admin.reason?.trim()) {
      throw new WithdrawalRejectedError("a rejection reason is required");
    }
    await this.wallet.withMoneyTransaction(async ({ tx, credit }) => {
      const before = await this.lockWithdrawal(tx, withdrawalId, "REQUESTED", "APPROVED");

      const refund = await credit({
        walletId: await this.walletIdFor(tx, before.user_id),
        amountMinor: BigInt(before.amount_minor),
        type: "REFUND",
        // Derived from the withdrawal, so a retry replays rather than
        // refunding twice.
        idempotencyKey: `withdrawal:refund:${withdrawalId}`,
        actor: { type: "SYSTEM" },
        metadata: { kind: "WITHDRAWAL_REFUND", withdrawalId, reason: "REJECTED" },
      });

      await tx
        .update(withdrawals)
        .set({
          status: "REJECTED",
          approvedBy: admin.id,
          approvalReason: admin.reason,
          refundTxnId: refund.transactionId,
          updatedAt: new Date(),
        })
        .where(eq(withdrawals.id, withdrawalId));

      await appendAuditLog(tx, {
        actorType: "ADMIN",
        actorId: admin.id,
        action: "WITHDRAWAL_REJECTED",
        entity: "withdrawals",
        entityId: withdrawalId,
        reason: admin.reason,
        before: { status: before.status },
        after: { status: "REJECTED", refundTxnId: refund.transactionId },
        ip: admin.ip,
      });
    });
  }

  /**
   * Submits an approved withdrawal to the bank rail.
   *
   * The provider reference is OUR withdrawal id, so a retried submission maps
   * to the same transfer on their side instead of paying twice — the same
   * reason the ledger keys idempotency off stable identifiers.
   */
  async submitToProvider(withdrawalId: string, provider: PaymentProvider): Promise<void> {
    const row = await this.wallet.withMoneyTransaction(async ({ tx }) => {
      const locked = await this.lockWithdrawal(tx, withdrawalId, "APPROVED");
      await tx
        .update(withdrawals)
        .set({ status: "PROCESSING", provider: provider.name, updatedAt: new Date() })
        .where(eq(withdrawals.id, withdrawalId));
      return locked;
    });

    // The provider call sits OUTSIDE the database transaction on purpose:
    // holding a row lock across a third-party HTTP request would stall every
    // other withdrawal behind a slow bank. The status is already PROCESSING,
    // so a crash here is recoverable by reconciliation rather than ambiguous.
    const result = await provider.initiateTransfer({
      amountMinor: BigInt(row.amount_minor),
      bankCode: row.bank_code,
      accountNumber: row.account_number,
      accountName: row.account_name,
      reference: withdrawalId,
      reason: "Withdrawal",
    });

    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx
        .update(withdrawals)
        .set({ providerRef: result.providerRef, updatedAt: new Date() })
        .where(eq(withdrawals.id, withdrawalId));
    });
  }

  /**
   * Applies a provider transfer callback.
   *
   * PAID is terminal and the trigger refuses a second transition into it, so
   * a replayed callback cannot pay a withdrawal out twice (§7). A FAILED
   * transfer returns the held funds.
   */
  async reconcile(
    withdrawalId: string,
    outcome: { status: "PAID" | "FAILED"; failureReason?: string },
  ): Promise<{ duplicate: boolean }> {
    return this.wallet.withMoneyTransaction(async ({ tx, credit }) => {
      const [row] = await tx.execute<{
        id: string;
        user_id: string;
        status: string;
        amount_minor: string;
      }>(sql`
        SELECT id, user_id, status::text AS status, amount_minor::text AS amount_minor
        FROM withdrawals WHERE id = ${withdrawalId}::uuid FOR UPDATE
      `);
      if (!row) throw new WithdrawalRejectedError(`unknown withdrawal ${withdrawalId}`);

      // Already terminal: a replayed callback.
      if (row.status === "PAID" || row.status === "FAILED" || row.status === "REJECTED") {
        return { duplicate: true };
      }
      if (row.status !== "PROCESSING") {
        throw new WithdrawalRejectedError(
          `withdrawal ${withdrawalId} is ${row.status}, not PROCESSING`,
        );
      }

      if (outcome.status === "PAID") {
        // The money already left at REQUEST time; paying out just confirms it.
        await tx
          .update(withdrawals)
          .set({ status: "PAID", updatedAt: new Date() })
          .where(eq(withdrawals.id, withdrawalId));
        return { duplicate: false };
      }

      const refund = await credit({
        walletId: await this.walletIdFor(tx, row.user_id),
        amountMinor: BigInt(row.amount_minor),
        type: "REFUND",
        idempotencyKey: `withdrawal:refund:${withdrawalId}`,
        actor: { type: "SYSTEM" },
        metadata: { kind: "WITHDRAWAL_REFUND", withdrawalId, reason: "FAILED" },
      });

      await tx
        .update(withdrawals)
        .set({
          status: "FAILED",
          failureReason: outcome.failureReason ?? "transfer failed",
          refundTxnId: refund.transactionId,
          updatedAt: new Date(),
        })
        .where(eq(withdrawals.id, withdrawalId));

      return { duplicate: false };
    });
  }

  private async lockWithdrawal(
    tx: Parameters<Parameters<WalletService["withMoneyTransaction"]>[0]>[0]["tx"],
    withdrawalId: string,
    ...allowed: string[]
  ) {
    const [row] = await tx.execute<{
      id: string;
      user_id: string;
      status: string;
      amount_minor: string;
      bank_code: string;
      account_number: string;
      account_name: string;
    }>(sql`
      SELECT id, user_id, status::text AS status, amount_minor::text AS amount_minor,
             bank_code, account_number, account_name
      FROM withdrawals WHERE id = ${withdrawalId}::uuid FOR UPDATE
    `);
    if (!row) throw new WithdrawalRejectedError(`unknown withdrawal ${withdrawalId}`);
    if (!allowed.includes(row.status)) {
      throw new WithdrawalRejectedError(
        `withdrawal ${withdrawalId} is ${row.status}; expected ${allowed.join(" or ")}`,
      );
    }
    return row;
  }

  private async walletIdFor(
    tx: Parameters<Parameters<WalletService["withMoneyTransaction"]>[0]>[0]["tx"],
    userId: string,
  ): Promise<string> {
    const [row] = await tx.execute<{ id: string }>(sql`
      SELECT id FROM wallets
      WHERE user_id = ${userId}::uuid AND kind = 'USER' AND currency = 'NGN'
        AND bucket = 'CASH'
    `);
    if (!row) throw new Error(`no NGN wallet for user ${userId}`);
    return row.id;
  }
}

export const withdrawalService = new WithdrawalService();
