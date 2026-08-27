import { and, eq, sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";
import { UnattributableDepositError } from "./errors";
import type { DepositWebhookEvent } from "./provider";
import { paymentIntents, virtualAccounts } from "./schema";

export { UnattributableDepositError };

/**
 * Credits deposits, exactly once, however many times the provider tells us
 * about them.
 *
 * Payment providers retry webhooks aggressively — on timeout, on a non-2xx,
 * on their own schedule — and they are right to. The handler's job is to make
 * that safe, not to hope it does not happen.
 */

export interface CreditDepositResult {
  paymentIntentId: string;
  creditedTxnId: string | null;
  amountMinor: bigint;
  /** True when this delivery did no new work. */
  duplicate: boolean;
}

export class DepositService {
  constructor(private readonly wallet: WalletService = walletService) {}

  /**
   * Applies one webhook delivery.
   *
   * Idempotency is layered, because a single guard is one bug away from a
   * double credit:
   *
   *  1. A unique index on (provider, provider_ref) means a second delivery
   *     cannot insert a second intent — it collides and we read the original.
   *  2. The intent row is then locked FOR UPDATE, so two deliveries arriving
   *     at once serialise instead of both seeing PENDING.
   *  3. The wallet credit carries an idempotency key derived from the
   *     provider reference, so even a torn retry replays the original ledger
   *     transaction rather than writing a new one.
   *  4. payment_intents.credited_txn_id is UNIQUE, so the database refuses a
   *     second credit against the same deposit outright.
   */
  async applyDepositWebhook(
    provider: string,
    event: DepositWebhookEvent,
  ): Promise<CreditDepositResult> {
    return this.wallet.withMoneyTransaction(async ({ tx, credit }) => {
      const userId = await this.attributeToUser(tx, provider, event);

      // Insert-or-ignore, then always read back under a lock. Doing it this
      // way means the winner of a concurrent race is decided by the unique
      // index rather than by application timing.
      await tx.execute(sql`
        INSERT INTO payment_intents (user_id, provider, provider_ref, amount_minor, status, raw_payload)
        VALUES (
          ${userId}::uuid,
          ${provider},
          ${event.providerRef},
          ${event.amountMinor.toString()}::bigint,
          'PENDING',
          ${JSON.stringify(event.raw)}::jsonb
        )
        ON CONFLICT (provider, provider_ref) DO NOTHING
      `);

      const [intent] = await tx.execute<{
        id: string;
        user_id: string;
        status: string;
        amount_minor: string;
        credited_txn_id: string | null;
      }>(sql`
        SELECT id, user_id, status::text AS status, amount_minor::text AS amount_minor,
               credited_txn_id
        FROM payment_intents
        WHERE provider = ${provider} AND provider_ref = ${event.providerRef}
        FOR UPDATE
      `);
      if (!intent) throw new Error(`payment intent for ${event.providerRef} vanished`);

      // Already credited: this is delivery two through ten.
      if (intent.status === "SUCCEEDED") {
        return {
          paymentIntentId: intent.id,
          creditedTxnId: intent.credited_txn_id,
          amountMinor: BigInt(intent.amount_minor),
          duplicate: true,
        };
      }

      if (event.status === "FAILED") {
        await tx
          .update(paymentIntents)
          .set({ status: "FAILED", updatedAt: new Date() })
          .where(eq(paymentIntents.id, intent.id));
        return {
          paymentIntentId: intent.id,
          creditedTxnId: null,
          amountMinor: BigInt(intent.amount_minor),
          duplicate: false,
        };
      }

      if (event.status !== "SUCCEEDED") {
        // Still pending upstream. Nothing to do; the provider will tell us.
        return {
          paymentIntentId: intent.id,
          creditedTxnId: null,
          amountMinor: BigInt(intent.amount_minor),
          duplicate: false,
        };
      }

      // Credit the amount the PROVIDER reported on the row we already stored,
      // not a figure recomputed from this delivery — a corrected webhook that
      // changed the amount must not silently move a different sum.
      const amountMinor = BigInt(intent.amount_minor);

      const result = await credit({
        walletId: await this.walletIdFor(tx, intent.user_id),
        amountMinor,
        type: "DEPOSIT",
        // Derived from the provider reference, never from a timestamp.
        idempotencyKey: `deposit:${provider}:${event.providerRef}`,
        reference: `${provider}:${event.providerRef}`,
        actor: { type: "SYSTEM" },
        metadata: { kind: "DEPOSIT", provider, providerRef: event.providerRef },
      });

      await tx
        .update(paymentIntents)
        .set({
          status: "SUCCEEDED",
          creditedTxnId: result.transactionId,
          updatedAt: new Date(),
        })
        .where(and(eq(paymentIntents.id, intent.id), eq(paymentIntents.status, "PENDING")));

      return {
        paymentIntentId: intent.id,
        creditedTxnId: result.transactionId,
        amountMinor,
        duplicate: false,
      };
    });
  }

  /**
   * Works out whose deposit this is.
   *
   * A dedicated virtual account is the reliable path: the NUBAN is permanent
   * and ours, so a transfer into it is attributable without the sender
   * quoting anything. Falling back to a customer reference covers card
   * payments. If neither resolves we refuse rather than guess — crediting the
   * wrong wallet is worse than a stuck deposit, which support can fix.
   */
  private async attributeToUser(
    tx: Parameters<Parameters<WalletService["withMoneyTransaction"]>[0]>[0]["tx"],
    provider: string,
    event: DepositWebhookEvent,
  ): Promise<string> {
    if (event.virtualAccountRef) {
      const [row] = await tx
        .select({ userId: virtualAccounts.userId })
        .from(virtualAccounts)
        .where(
          and(
            eq(virtualAccounts.provider, provider),
            eq(virtualAccounts.providerRef, event.virtualAccountRef),
          ),
        )
        .limit(1);
      if (row) return row.userId;
    }

    if (event.customerRef) {
      const [row] = await tx.execute<{ id: string }>(sql`
        SELECT id FROM users WHERE id = ${event.customerRef}::uuid
      `);
      if (row) return row.id;
    }

    throw new UnattributableDepositError(event.providerRef);
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

export const depositService = new DepositService();
