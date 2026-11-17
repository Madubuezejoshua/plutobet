import { sql } from "drizzle-orm";
import { appendAuditLog } from "../audit/append";
import { walletService, WalletService } from "../wallet/wallet.service";

/**
 * Correcting a settled bet.
 *
 * Results are wrong sometimes — a provider posts the wrong score, a match is
 * awarded on appeal, a goal is disallowed an hour later. Until this existed,
 * the only way to fix a mis-settled bet was manual surgery on the ledger,
 * which is precisely what the ledger is built to prevent.
 *
 * THE PRINCIPLE
 * A resettlement never edits the original movement. It posts a COMPENSATING
 * one: a customer wrongly paid is debited back, one wrongly denied is
 * credited. The original settlement stays in the record exactly as it
 * happened, because "we paid this, then corrected it" is the true account and
 * "we never paid it" is not.
 *
 * WHY THE DEBIT DIRECTION IS THE HARD CASE
 * Crediting someone who was underpaid is easy — the money is ours to give.
 * Taking money BACK is different: they may have spent it, and the wallet
 * cannot go negative (a database CHECK enforces that). This service does not
 * pretend otherwise. It recovers what it can and records the shortfall as a
 * debt, rather than either failing the correction outright or inventing a
 * negative balance the ledger would reject anyway.
 */

export type ResettlementReason =
  | "PROVIDER_CORRECTION"
  | "MATCH_AWARDED"
  | "OPERATOR_ERROR"
  | "VOIDED_AFTER_SETTLEMENT";

export type ResettlementStatus = "WON" | "LOST" | "VOID";

export class ResettlementError extends Error {
  constructor(
    readonly code: "BET_NOT_FOUND" | "NOT_SETTLED" | "NO_CHANGE" | "NO_WALLET",
    message: string,
  ) {
    super(message);
    this.name = "ResettlementError";
  }
}

export interface ResettleResult {
  resettlementId: string;
  adjustmentMinor: bigint;
  /** Recovered from the customer when a clawback exceeded their balance. */
  recoveredMinor: bigint;
  /** What could not be recovered. Non-zero means a debt to chase. */
  shortfallMinor: bigint;
}

export class ResettlementService {
  constructor(private readonly wallet: WalletService = walletService) {}

  /**
   * Re-settles one bet to a corrected outcome.
   *
   * `newPayoutMinor` is the total the bet SHOULD have paid, not the delta —
   * the delta is derived here so the caller cannot get the sign wrong, which
   * is the mistake that turns a correction into a second wrong payment.
   */
  async resettle(params: {
    betId: string;
    newStatus: ResettlementStatus;
    newPayoutMinor: bigint;
    reason: ResettlementReason;
    note: string;
    authorisedBy: string;
    ip: string;
  }): Promise<ResettleResult> {
    if (params.newPayoutMinor < 0n) {
      throw new RangeError("a payout cannot be negative");
    }
    const note = params.note.trim();
    if (note.length < 3 || note.length > 500) {
      throw new RangeError("a note of 3-500 characters is required");
    }

    return this.wallet.withMoneyTransaction(async ({ tx, credit, debit }) => {
      const [bet] = await tx.execute<{
        id: string;
        user_id: string;
        status: string;
        stake_minor: string;
        wallet_id: string | null;
        previous_payout: string;
        cached_balance_minor: string | null;
      }>(sql`
        SELECT b.id, b.user_id, b.status::text AS status, b.stake_minor::text AS stake_minor,
               w.id AS wallet_id,
               w.cached_balance_minor::text AS cached_balance_minor,
               COALESCE((
                 SELECT SUM(le.amount_minor)
                 FROM ledger_entries le
                 JOIN ledger_transactions lt ON lt.id = le.txn_id
                 WHERE le.wallet_id = w.id
                   AND le.direction = 'CREDIT'
                   AND lt.metadata ->> 'betId' = b.id::text
                   AND lt.metadata ->> 'kind' = 'BET_SETTLEMENT'
               ), 0)::text AS previous_payout
        FROM bets b
        LEFT JOIN wallets w
          ON w.user_id = b.user_id AND w.kind = 'USER'
         AND w.currency = 'NGN' AND w.bucket = 'CASH'
        WHERE b.id = ${params.betId}::uuid
        FOR UPDATE OF b
      `);

      if (!bet) throw new ResettlementError("BET_NOT_FOUND", `unknown bet ${params.betId}`);
      if (!bet.wallet_id) {
        throw new ResettlementError("NO_WALLET", `no cash wallet for user ${bet.user_id}`);
      }
      if (bet.status === "PENDING") {
        // Nothing has been settled, so there is nothing to correct. Settling
        // it normally is the right action, and doing that here would bypass
        // every check the settlement path makes.
        throw new ResettlementError(
          "NOT_SETTLED",
          "this bet has not settled yet; settle it rather than resettling it",
        );
      }

      const previousPayout = BigInt(bet.previous_payout);
      const adjustment = params.newPayoutMinor - previousPayout;

      if (adjustment === 0n && bet.status === params.newStatus) {
        throw new ResettlementError("NO_CHANGE", "that is what the bet already settled to");
      }

      let adjustmentTxnId: string | null = null;
      let recovered = 0n;
      let shortfall = 0n;

      if (adjustment > 0n) {
        // Underpaid. Straightforward: the money is ours to give.
        const result = await credit({
          walletId: bet.wallet_id,
          amountMinor: adjustment,
          type: "ADJUSTMENT",
          // Derived from the bet and the new payout, so a retried correction
          // replays rather than paying the difference twice.
          idempotencyKey: `resettle:${params.betId}:${params.newPayoutMinor}`,
          actor: { type: "SYSTEM" },
          metadata: {
            kind: "BET_RESETTLEMENT",
            betId: params.betId,
            reason: params.reason,
          },
        });
        adjustmentTxnId = result.transactionId;
        recovered = adjustment;
      } else if (adjustment < 0n) {
        /*
         * Overpaid, and now clawing back.
         *
         * The wallet cannot go negative — a CHECK constraint enforces it — and
         * the customer may well have spent the money. Recovering only what is
         * there and recording the rest as a shortfall is the honest outcome:
         * the alternatives are failing the correction (leaving the books
         * wrong) or inventing a negative balance (which the database would
         * reject anyway).
         */
        const owed = -adjustment;
        const available = BigInt(bet.cached_balance_minor ?? "0");
        recovered = owed < available ? owed : available;
        shortfall = owed - recovered;

        if (recovered > 0n) {
          const result = await debit({
            walletId: bet.wallet_id,
            amountMinor: recovered,
            type: "ADJUSTMENT",
            idempotencyKey: `resettle:${params.betId}:${params.newPayoutMinor}`,
            actor: { type: "SYSTEM" },
            metadata: {
              kind: "BET_RESETTLEMENT",
              betId: params.betId,
              reason: params.reason,
              shortfallMinor: shortfall.toString(),
            },
          });
          adjustmentTxnId = result.transactionId;
        }
      }

      const [row] = await tx.execute<{ id: string }>(sql`
        INSERT INTO bet_resettlements (
          bet_id, previous_status, new_status,
          previous_payout_minor, new_payout_minor,
          adjustment_minor, adjustment_txn_id, reason, note, authorised_by
        )
        VALUES (
          ${params.betId}::uuid, ${bet.status}::bet_status, ${params.newStatus}::bet_status,
          ${previousPayout}, ${params.newPayoutMinor},
          ${adjustment}, ${adjustmentTxnId}::uuid,
          ${params.reason}::resettlement_reason, ${note}, ${params.authorisedBy}::uuid
        )
        RETURNING id
      `);
      if (!row) throw new Error("resettlement insert returned no row");

      await tx.execute(sql`
        UPDATE bets
        SET status = ${params.newStatus}::bet_status,
            settled_at = now(),
            resettlement_count = resettlement_count + 1
        WHERE id = ${params.betId}::uuid
      `);

      // Audited in the SAME transaction as the money movement. An audit row
      // written afterwards can be lost by a crash in between, leaving a
      // correction nobody recorded.
      await appendAuditLog(tx, {
        actorType: "ADMIN",
        actorId: params.authorisedBy,
        action: "BET_RESETTLED",
        entity: "bets",
        entityId: params.betId,
        reason: note,
        before: { status: bet.status, payoutMinor: previousPayout.toString() },
        after: {
          status: params.newStatus,
          payoutMinor: params.newPayoutMinor.toString(),
          adjustmentMinor: adjustment.toString(),
          shortfallMinor: shortfall.toString(),
        },
        ip: params.ip,
      });

      return {
        resettlementId: row.id,
        adjustmentMinor: adjustment,
        recoveredMinor: recovered,
        shortfallMinor: shortfall,
      };
    });
  }

  /** Every correction applied to one bet, oldest first. */
  async history(betId: string): Promise<
    {
      id: string;
      previousStatus: string;
      newStatus: string;
      adjustmentMinor: bigint;
      reason: string;
      note: string;
      createdAt: Date;
    }[]
  > {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const rows = await tx.execute<{
        id: string;
        previous_status: string;
        new_status: string;
        adjustment_minor: string;
        reason: string;
        note: string;
        created_at: Date;
      }>(sql`
        SELECT id, previous_status::text AS previous_status, new_status::text AS new_status,
               adjustment_minor::text AS adjustment_minor, reason::text AS reason,
               note, created_at
        FROM bet_resettlements
        WHERE bet_id = ${betId}::uuid
        ORDER BY created_at ASC
      `);

      return rows.map((row) => ({
        id: row.id,
        previousStatus: row.previous_status,
        newStatus: row.new_status,
        adjustmentMinor: BigInt(row.adjustment_minor),
        reason: row.reason,
        note: row.note,
        createdAt: new Date(row.created_at),
      }));
    });
  }
}

export const resettlementService = new ResettlementService();
