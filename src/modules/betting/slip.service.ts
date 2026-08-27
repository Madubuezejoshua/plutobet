import { sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";
import {
  placementService,
  PlacementService,
  type OddsDriftPolicy,
  type PlacedBet,
  type SlipLeg,
} from "./placement.service";
import {
  expandSystem,
  systemTotalStake,
  SystemBetError,
} from "./system-bet";

/**
 * Placing a slip: single, accumulator, or system.
 *
 * A system expands into one ordinary accumulator per combination, so this
 * module is mostly bookkeeping around the existing placement service — which
 * is the point. Nothing below reimplements pricing, exposure, idempotency or
 * the ledger; those stay in the one place that is already proven.
 *
 * WHY EACH COMBINATION IS PLACED SEPARATELY RATHER THAN IN ONE TRANSACTION
 * Each combination is a real bet with its own stake debit and its own exposure
 * claim, and exposure is checked per market. A 6-combination system might have
 * four combinations accepted and two refused because a market filled up in
 * between — and that is the CORRECT outcome, not a failure. Forcing all six
 * into one transaction would mean a full market on one leg rejects a slip that
 * was mostly placeable.
 *
 * The customer is told exactly what was accepted and charged only for that.
 */

export class SlipError extends Error {
  constructor(
    readonly code: "NOTHING_PLACED" | "INVALID_SLIP",
    message: string,
    readonly failures: string[] = [],
  ) {
    super(message);
    this.name = "SlipError";
  }
}

export type SlipKind = "SINGLE" | "MULTIPLE" | "SYSTEM";

export interface PlaceSlipRequest {
  userId: string;
  walletId: string;
  ip: string;
  legs: SlipLeg[];
  /** Stake PER COMBINATION, not the total. */
  unitStakeMinor: bigint;
  /** Combination size for a system. Omit for a single or accumulator. */
  systemSize?: number;
  /** Indices into `legs` that must appear in every combination. */
  bankerIndices?: number[];
  /** Stable per-slip key; each combination derives its own from it. */
  idempotencyKey: string;
  driftPolicy?: OddsDriftPolicy;
}

export interface PlacedSlip {
  slipId: string;
  kind: SlipKind;
  combinationCount: number;
  /** What the customer was actually charged: unit x accepted combinations. */
  totalStakeMinor: bigint;
  placed: PlacedBet[];
  /** Combinations refused, with the reason. Empty when everything landed. */
  rejected: { combinationIndex: number; reason: string }[];
}

export class SlipService {
  constructor(
    private readonly wallet: WalletService = walletService,
    private readonly placement: PlacementService = placementService,
  ) {}

  async placeSlip(request: PlaceSlipRequest): Promise<PlacedSlip> {
    const legs = request.legs;
    if (legs.length === 0) throw new SlipError("INVALID_SLIP", "add a selection first");

    const bankerIndices = [...new Set(request.bankerIndices ?? [])];
    for (const index of bankerIndices) {
      if (!Number.isInteger(index) || index < 0 || index >= legs.length) {
        throw new SlipError("INVALID_SLIP", "a banker refers to a selection that is not on the slip");
      }
    }

    const { kind, combinations } = this.expand(legs.length, request.systemSize, bankerIndices);

    // Recorded BEFORE placing, so a slip that fails partway is still traceable
    // to the customer's intent rather than only to whatever landed.
    const slipId = await this.recordSlip({
      userId: request.userId,
      kind,
      systemSize: kind === "SYSTEM" ? request.systemSize! : null,
      selectionCount: legs.length,
      bankerCount: bankerIndices.length,
      unitStakeMinor: request.unitStakeMinor,
      combinationCount: combinations.length,
    });

    const placed: PlacedBet[] = [];
    const rejected: { combinationIndex: number; reason: string }[] = [];

    for (const [combinationIndex, indices] of combinations.entries()) {
      const combinationLegs = indices.map((index) => legs[index]!);

      try {
        const bet = await this.placement.placeBet({
          userId: request.userId,
          walletId: request.walletId,
          ip: request.ip,
          stakeMinor: request.unitStakeMinor,
          legs: combinationLegs,
          /*
           * Derived from the slip key AND the combination index.
           *
           * Keying on the slip alone would make the second combination look
           * like a replay of the first and silently place one bet instead of
           * six. This is the same reasoning the casino module uses for
           * "round reference plus operation".
           */
          idempotencyKey: `${request.idempotencyKey}:${combinationIndex}`,
          driftPolicy: request.driftPolicy,
        });

        await this.attachToSlip(bet.betId, slipId, combinationIndex);
        placed.push(bet);
      } catch (error) {
        // A refused combination is a normal outcome, not a failure of the
        // slip: markets fill, prices move, exposure caps bite. Record it and
        // carry on so the customer keeps the combinations that were placeable.
        rejected.push({
          combinationIndex,
          reason: error instanceof Error ? error.message : "could not be placed",
        });
      }
    }

    if (placed.length === 0) {
      throw new SlipError(
        "NOTHING_PLACED",
        "none of the combinations on this slip could be placed",
        rejected.map((entry) => entry.reason),
      );
    }

    return {
      slipId,
      kind,
      combinationCount: combinations.length,
      // What was CHARGED, not what was quoted. A partially placed system costs
      // only what landed.
      totalStakeMinor: systemTotalStake(request.unitStakeMinor, placed.length),
      placed,
      rejected,
    };
  }

  /**
   * Works out the slip kind and the combinations to place.
   *
   * A single and an accumulator are the same shape as a system with exactly
   * one combination, which keeps the loop above uniform.
   */
  private expand(
    legCount: number,
    systemSize: number | undefined,
    bankerIndices: number[],
  ): { kind: SlipKind; combinations: number[][] } {
    const allLegs = Array.from({ length: legCount }, (_, index) => index);

    if (systemSize === undefined) {
      if (bankerIndices.length > 0) {
        // A banker only means something when there are combinations to vary.
        throw new SlipError("INVALID_SLIP", "bankers apply to system bets only");
      }
      return {
        kind: legCount === 1 ? "SINGLE" : "MULTIPLE",
        combinations: [allLegs],
      };
    }

    // A "system" covering every selection is just an accumulator; treat it as
    // one so the customer is not charged as though it were something else.
    if (systemSize === legCount && bankerIndices.length === 0) {
      return { kind: "MULTIPLE", combinations: [allLegs] };
    }

    try {
      return {
        kind: "SYSTEM",
        combinations: expandSystem({
          selectionCount: legCount,
          systemSize,
          bankerIndices,
        }),
      };
    } catch (error) {
      if (error instanceof SystemBetError) {
        throw new SlipError("INVALID_SLIP", error.message);
      }
      throw error;
    }
  }

  private async recordSlip(params: {
    userId: string;
    kind: SlipKind;
    systemSize: number | null;
    selectionCount: number;
    bankerCount: number;
    unitStakeMinor: bigint;
    combinationCount: number;
  }): Promise<string> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [row] = await tx.execute<{ id: string }>(sql`
        INSERT INTO bet_slips (
          user_id, kind, system_size, selection_count, banker_count,
          unit_stake_minor, combination_count, total_stake_minor
        )
        VALUES (
          ${params.userId}::uuid, ${params.kind}::bet_slip_kind, ${params.systemSize},
          ${params.selectionCount}, ${params.bankerCount},
          ${params.unitStakeMinor}, ${params.combinationCount},
          ${systemTotalStake(params.unitStakeMinor, params.combinationCount)}
        )
        RETURNING id
      `);
      if (!row) throw new Error("bet slip insert returned no row");
      return row.id;
    });
  }

  private async attachToSlip(
    betId: string,
    slipId: string,
    combinationIndex: number,
  ): Promise<void> {
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        UPDATE bets
        SET slip_id = ${slipId}::uuid, combination_index = ${combinationIndex}
        WHERE id = ${betId}::uuid AND slip_id IS NULL
      `);
    });
  }

  /**
   * The customer-facing status of a whole slip.
   *
   * A single combination is always plainly WON or LOST. A system is not: some
   * combinations can win while others lose, and calling that either would
   * misrepresent it — hence PARTIALLY_WON and PARTIALLY_LOST, which exist for
   * the slip view rather than for any individual bet.
   */
  async slipStatus(slipId: string): Promise<{
    status: "PENDING" | "WON" | "LOST" | "PARTIALLY_WON" | "PARTIALLY_LOST" | "VOID";
    won: number;
    lost: number;
    pending: number;
    returnedMinor: bigint;
  }> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const rows = await tx.execute<{ status: string; n: number; returned: string }>(sql`
        SELECT status::text AS status, count(*)::int AS n,
               COALESCE(SUM(CASE WHEN status = 'WON' THEN potential_return_minor ELSE 0 END), 0)::text
                 AS returned
        FROM bets WHERE slip_id = ${slipId}::uuid
        GROUP BY status
      `);

      const count = (status: string) =>
        Number(rows.find((row) => row.status === status)?.n ?? 0);

      const won = count("WON");
      const lost = count("LOST");
      const pending = count("PENDING");
      const voided = count("VOID");
      const returnedMinor = rows.reduce((sum, row) => sum + BigInt(row.returned), 0n);

      const status =
        pending > 0
          ? "PENDING"
          : won > 0 && lost > 0
            ? "PARTIALLY_WON"
            : won > 0
              ? "WON"
              : lost > 0
                ? "LOST"
                : voided > 0
                  ? "VOID"
                  : "PENDING";

      return { status, won, lost, pending, returnedMinor };
    });
  }
}

export const slipService = new SlipService();
