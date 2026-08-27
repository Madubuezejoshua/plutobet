import { sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";

/**
 * Jackpot competitions.
 *
 * A fixed slate of fixtures, one prediction each, a pooled prize shared by
 * whoever gets the most right.
 *
 * WHY THIS IS NOT A BET
 * A bet is priced — the customer knows their return when they place it. A
 * jackpot entry is not: what it pays depends on how many other people also got
 * fourteen right, and nobody knows that until the last match finishes. Forcing
 * it through `bets`, whose design assumes a locked price and a computable
 * potential return, would mean lying in both columns.
 *
 * Money still moves through the SAME wallet and ledger. Only the pricing model
 * differs.
 */

export type Prediction = "HOME" | "DRAW" | "AWAY";

export class JackpotError extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "NOT_OPEN"
      | "CLOSED"
      | "WRONG_PREDICTION_COUNT"
      | "INVALID_PREDICTION"
      | "ALREADY_SETTLED",
    message: string,
  ) {
    super(message);
    this.name = "JackpotError";
  }
}

export interface PoolBreakdown {
  entries: number;
  grossFeesMinor: bigint;
  /** The operator's share, kept back before the pool is formed. */
  marginMinor: bigint;
  /** Entry contribution plus the guarantee. What is actually paid out. */
  poolMinor: bigint;
}

/**
 * Works out the prize pool.
 *
 * Integer arithmetic throughout, with the margin derived by SUBTRACTION rather
 * than by rounding it separately. Rounding both halves independently is how a
 * pool ends up a kobo short of the fees taken — the two figures must sum to
 * exactly what was collected, and subtracting one from the other guarantees it.
 */
export function computePool(params: {
  entries: number;
  entryFeeMinor: bigint;
  poolContributionBasisPoints: number;
  guaranteedPrizeMinor: bigint;
}): PoolBreakdown {
  const grossFeesMinor = params.entryFeeMinor * BigInt(params.entries);
  const contribution =
    (grossFeesMinor * BigInt(params.poolContributionBasisPoints)) / 10_000n;
  const marginMinor = grossFeesMinor - contribution;

  return {
    entries: params.entries,
    grossFeesMinor,
    marginMinor,
    poolMinor: contribution + params.guaranteedPrizeMinor,
  };
}

/**
 * Splits a pool between winners on equal shares.
 *
 * Returns per-winner amounts that sum EXACTLY to the pool. Integer division
 * leaves a remainder of up to (winners - 1) kobo, and the honest thing to do
 * with it is distribute it one kobo at a time rather than keep it: a house
 * that silently pockets the rounding on every jackpot is taking money nobody
 * agreed to.
 *
 * The remainder goes to the earliest entries, which is arbitrary but fixed —
 * and being deterministic matters more than being fair here, because it means
 * the same settlement always produces the same payouts.
 */
export function splitPool(poolMinor: bigint, winners: number): bigint[] {
  if (winners <= 0) return [];

  const share = poolMinor / BigInt(winners);
  const remainder = poolMinor - share * BigInt(winners);

  return Array.from({ length: winners }, (_, index) =>
    index < Number(remainder) ? share + 1n : share,
  );
}

export class JackpotService {
  constructor(private readonly wallet: WalletService = walletService) {}

  /**
   * Buys an entry.
   *
   * The fee debit and the entry row commit together: an entry without a
   * payment is a free ticket, and a payment without an entry is theft. The
   * unique index on `fee_txn_id` makes one payment buy exactly one entry even
   * under a retried request.
   */
  async enter(params: {
    jackpotId: string;
    userId: string;
    walletId: string;
    predictions: Prediction[];
    idempotencyKey: string;
    ip: string;
  }): Promise<{ entryId: string; feeMinor: bigint }> {
    return this.wallet.withMoneyTransaction(async ({ tx, debit }) => {
      const [jackpot] = await tx.execute<{
        id: string;
        status: string;
        entry_fee_minor: string;
        selection_count: number;
        closes_at: Date;
      }>(sql`
        SELECT id, status::text AS status, entry_fee_minor::text AS entry_fee_minor,
               selection_count, closes_at
        FROM jackpots WHERE id = ${params.jackpotId}::uuid
      `);

      if (!jackpot) throw new JackpotError("NOT_FOUND", "no such competition");
      if (jackpot.status !== "OPEN") {
        throw new JackpotError("NOT_OPEN", "this competition is not accepting entries");
      }
      if (new Date(jackpot.closes_at).getTime() <= Date.now()) {
        throw new JackpotError("CLOSED", "entries for this competition have closed");
      }
      if (params.predictions.length !== Number(jackpot.selection_count)) {
        throw new JackpotError(
          "WRONG_PREDICTION_COUNT",
          `this competition needs exactly ${jackpot.selection_count} predictions`,
        );
      }
      for (const prediction of params.predictions) {
        if (prediction !== "HOME" && prediction !== "DRAW" && prediction !== "AWAY") {
          throw new JackpotError("INVALID_PREDICTION", `${prediction} is not a valid prediction`);
        }
      }

      const feeMinor = BigInt(jackpot.entry_fee_minor);
      const paid = await debit({
        walletId: params.walletId,
        amountMinor: feeMinor,
        type: "STAKE",
        idempotencyKey: params.idempotencyKey,
        actor: { type: "USER", id: params.userId, ip: params.ip },
        metadata: { kind: "JACKPOT_ENTRY", jackpotId: params.jackpotId },
      });

      const [entry] = await tx.execute<{ id: string }>(sql`
        INSERT INTO jackpot_entries (jackpot_id, user_id, predictions, fee_txn_id)
        VALUES (
          ${params.jackpotId}::uuid, ${params.userId}::uuid,
          ${JSON.stringify(params.predictions)}::jsonb, ${paid.transactionId}::uuid
        )
        RETURNING id
      `);
      if (!entry) throw new Error("jackpot entry insert returned no row");

      return { entryId: entry.id, feeMinor };
    });
  }

  /**
   * Settles a competition once every fixture has an outcome.
   *
   * Scores every entry, finds the best, and pays whoever reached both the top
   * score and the advertised minimum. A competition where nobody clears the
   * minimum pays nothing and says so — rolling the pool forward would be a
   * different product with different terms, and inventing it here would change
   * what entrants were told.
   */
  async settle(jackpotId: string): Promise<{
    winners: number;
    topHits: number;
    poolMinor: bigint;
    paidMinor: bigint;
  }> {
    return this.wallet.withMoneyTransaction(async ({ tx, credit }) => {
      const [jackpot] = await tx.execute<{
        id: string;
        status: string;
        entry_fee_minor: string;
        guaranteed_prize_minor: string;
        pool_contribution_basis_points: number;
        minimum_winning_hits: number;
      }>(sql`
        SELECT id, status::text AS status, entry_fee_minor::text AS entry_fee_minor,
               guaranteed_prize_minor::text AS guaranteed_prize_minor,
               pool_contribution_basis_points, minimum_winning_hits
        FROM jackpots WHERE id = ${jackpotId}::uuid FOR UPDATE
      `);
      if (!jackpot) throw new JackpotError("NOT_FOUND", "no such competition");
      if (jackpot.status === "SETTLED") {
        throw new JackpotError("ALREADY_SETTLED", "this competition has already settled");
      }

      const outcomes = await tx.execute<{ position: number; outcome: string | null }>(sql`
        SELECT position, outcome FROM jackpot_fixtures
        WHERE jackpot_id = ${jackpotId}::uuid ORDER BY position
      `);
      if (outcomes.some((row) => row.outcome === null)) {
        throw new JackpotError("NOT_OPEN", "not every fixture has finished yet");
      }
      const results = outcomes.map((row) => row.outcome as Prediction);

      const entries = await tx.execute<{
        id: string;
        user_id: string;
        predictions: Prediction[];
        created_at: Date;
      }>(sql`
        SELECT id, user_id, predictions, created_at
        FROM jackpot_entries WHERE jackpot_id = ${jackpotId}::uuid
        ORDER BY created_at ASC
      `);

      const scored = entries.map((entry) => ({
        id: entry.id,
        userId: entry.user_id,
        hits: entry.predictions.reduce(
          (total, prediction, index) => total + (prediction === results[index] ? 1 : 0),
          0,
        ),
      }));

      for (const entry of scored) {
        await tx.execute(sql`
          UPDATE jackpot_entries SET hits = ${entry.hits} WHERE id = ${entry.id}::uuid
        `);
      }

      const pool = computePool({
        entries: entries.length,
        entryFeeMinor: BigInt(jackpot.entry_fee_minor),
        poolContributionBasisPoints: Number(jackpot.pool_contribution_basis_points),
        guaranteedPrizeMinor: BigInt(jackpot.guaranteed_prize_minor),
      });

      const topHits = scored.reduce((best, entry) => Math.max(best, entry.hits), 0);
      const winners =
        topHits >= Number(jackpot.minimum_winning_hits)
          ? scored.filter((entry) => entry.hits === topHits)
          : [];

      const shares = splitPool(pool.poolMinor, winners.length);
      let paidMinor = 0n;

      for (const [index, winner] of winners.entries()) {
        const prize = shares[index]!;
        if (prize <= 0n) continue;

        const walletId = await this.cashWalletFor(tx, winner.userId);
        const paid = await credit({
          walletId,
          amountMinor: prize,
          type: "PAYOUT",
          // Keyed on the entry, so a retried settlement replays rather than
          // paying a winner twice.
          idempotencyKey: `jackpot:prize:${winner.id}`,
          actor: { type: "SYSTEM" },
          metadata: { kind: "JACKPOT_PRIZE", jackpotId, entryId: winner.id },
        });

        await tx.execute(sql`
          UPDATE jackpot_entries
          SET prize_minor = ${prize}, prize_txn_id = ${paid.transactionId}::uuid
          WHERE id = ${winner.id}::uuid
        `);
        paidMinor += prize;
      }

      await tx.execute(sql`
        UPDATE jackpots SET status = 'SETTLED', settled_at = now()
        WHERE id = ${jackpotId}::uuid
      `);

      return { winners: winners.length, topHits, poolMinor: pool.poolMinor, paidMinor };
    });
  }

  /** Competitions currently accepting entries. */
  async open(): Promise<
    {
      id: string;
      name: string;
      entryFeeMinor: bigint;
      selectionCount: number;
      closesAt: Date;
      entries: number;
      poolMinor: bigint;
    }[]
  > {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const rows = await tx.execute<{
        id: string;
        name: string;
        entry_fee_minor: string;
        guaranteed_prize_minor: string;
        pool_contribution_basis_points: number;
        selection_count: number;
        closes_at: Date;
        entries: number;
      }>(sql`
        SELECT j.id, j.name, j.entry_fee_minor::text AS entry_fee_minor,
               j.guaranteed_prize_minor::text AS guaranteed_prize_minor,
               j.pool_contribution_basis_points, j.selection_count, j.closes_at,
               count(e.id)::int AS entries
        FROM jackpots j
        LEFT JOIN jackpot_entries e ON e.jackpot_id = j.id
        WHERE j.status = 'OPEN' AND j.closes_at > now()
        GROUP BY j.id
        ORDER BY j.closes_at ASC
      `);

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        entryFeeMinor: BigInt(row.entry_fee_minor),
        selectionCount: Number(row.selection_count),
        closesAt: new Date(row.closes_at),
        entries: Number(row.entries),
        poolMinor: computePool({
          entries: Number(row.entries),
          entryFeeMinor: BigInt(row.entry_fee_minor),
          poolContributionBasisPoints: Number(row.pool_contribution_basis_points),
          guaranteedPrizeMinor: BigInt(row.guaranteed_prize_minor),
        }).poolMinor,
      }));
    });
  }

  private async cashWalletFor(
    tx: Parameters<Parameters<WalletService["withMoneyTransaction"]>[0]>[0]["tx"],
    userId: string,
  ): Promise<string> {
    const [row] = await tx.execute<{ id: string }>(sql`
      SELECT id FROM wallets
      WHERE user_id = ${userId}::uuid AND kind = 'USER'
        AND currency = 'NGN' AND bucket = 'CASH'
    `);
    if (!row) throw new Error(`no cash wallet for user ${userId}`);
    return row.id;
  }
}

export const jackpotService = new JackpotService();
