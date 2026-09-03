import { asc, eq, inArray, sql } from "drizzle-orm";
import { markets, selections } from "../odds/schema";
import { responsibleService, ResponsibleService } from "../responsible/responsible.service";
import { users } from "../users/schema";
import { dbDirect, type DirectDatabase } from "../wallet/db-direct";
import { walletService, WalletService, type DirectTransaction } from "../wallet/wallet.service";
import { dateOfBirthService } from "../users/date-of-birth.service";
import {
  AccountNotEligibleError,
  DuplicateSelectionError,
  EmptySlipError,
  EventStartedError,
  ExposureLimitError,
  OddsDriftError,
  SelectionUnavailableError,
  StakeLimitError,
  UserExposureLimitError,
} from "./errors";
import { formatScaledOdds, parseOddsToScaled, priceBet } from "./pricing";
import { betLegs, bets } from "./schema";

/**
 * How to treat a price that moved between the slip being rendered and
 * submitted.
 *
 *  REJECT          — any change refuses the bet and re-prompts. Default.
 *  ACCEPT_IF_BETTER — a move in the user's favour is accepted silently;
 *                     a move against them still refuses.
 *
 * REJECT is the default because the cleanest certification story is "the
 * price on the bet equals the price displayed". ACCEPT_IF_BETTER never harms
 * the user, but it means the stored price differs from the submitted one,
 * which is one more thing to explain to a lab. Live betting is
 * rejection-heavy under REJECT — flip this per-product, not per-request.
 */
export type OddsDriftPolicy = "REJECT" | "ACCEPT_IF_BETTER" | "ACCEPT_ANY";

/*
 * The policy may now be supplied PER CALL, overriding the product default.
 *
 * The note above argues for per-product rather than per-request, and its
 * reasoning still holds for anything the CLIENT could choose. This override is
 * different: it is read from the customer's stored preference on the server,
 * never from the request body. A client that could name its own policy could
 * send ACCEPT_ANY and have a drifted price accepted on the customer's behalf —
 * which harms them, and which they never agreed to.
 *
 * Auditability survives because the preference is a stored fact with a
 * timestamp: "why did this bet take a moved price" is answerable from the
 * account's settings at the time.
 */

export interface PlacementConfig {
  driftPolicy: OddsDriftPolicy;
  minStakeMinor: bigint;
  maxStakeMinor: bigint;
  /** Applied when a market has no exposure row yet. */
  defaultMarketCeilingMinor: bigint;
  /**
   * Most total liability one account may hold across all its open bets.
   *
   * INVARIANT 11 requires exposure to be checked per-user AND per-market. A
   * market ceiling alone bounds what the book can lose on one event; it does
   * nothing about one account accumulating enormous liability spread thinly
   * across many markets, which is exactly the shape of both a whale and an
   * arbitrage bot.
   */
  maxUserExposureMinor: bigint;
}

export const DEFAULT_PLACEMENT_CONFIG: PlacementConfig = {
  driftPolicy: "REJECT",
  minStakeMinor: 10_000n, // ₦100.00
  maxStakeMinor: 50_000_000n, // ₦500,000.00
  defaultMarketCeilingMinor: 500_000_000n, // ₦5,000,000.00
  maxUserExposureMinor: 200_000_000n, // ₦2,000,000.00 open liability per account
};

export interface SlipLeg {
  selectionId: string;
  /** The price the user was shown, as displayed: "2.100". */
  odds: string;
}

export interface PlaceBetRequest {
  userId: string;
  walletId: string;
  stakeMinor: bigint;
  legs: SlipLeg[];
  /** Required: §3.13 puts the actor's IP on every money-path audit row. */
  ip: string;
  /**
   * Stable per-slip key from the client. Reused as the wallet idempotency
   * key so a retried submit replays the original debit instead of placing a
   * second bet.
   */
  idempotencyKey: string;
  /**
   * The customer's stored odds-change preference, resolved SERVER-SIDE.
   *
   * Never taken from the request body — see the note on OddsDriftPolicy.
   * Omitted falls back to the product default, which is REJECT.
   */
  driftPolicy?: OddsDriftPolicy;
}

export interface PlacedBet {
  betId: string;
  stakeTxnId: string;
  stakeMinor: bigint;
  totalOddsDecimal: string;
  potentialReturnMinor: bigint;
  balanceAfterMinor: bigint;
}

type LockedSelection = {
  selection_id: string;
  selection_status: string;
  current_price_decimal: string;
  market_id: string;
  market_status: string;
  event_id: string;
  event_status: string;
  starts_at: Date;
  already_started: boolean;
};

export class PlacementService {
  constructor(
    private readonly database: DirectDatabase = dbDirect,
    private readonly wallet: WalletService = walletService,
    private readonly config: PlacementConfig = DEFAULT_PLACEMENT_CONFIG,
    private readonly responsible: ResponsibleService = responsibleService,
  ) {}

  /**
   * Places a single or accumulator atomically.
   *
   * Everything below happens in ONE unpooled transaction, in a fixed lock
   * order, so a failure at any point leaves no stake debited and no exposure
   * moved:
   *
   *   1. selection + market rows FOR SHARE (ascending id)
   *   2. re-read status under that lock
   *   3. exposure rows, ascending market_id (atomic conditional UPDATE)
   *   4. wallet row FOR UPDATE (inside the wallet service)
   *
   * The order is fixed globally, which is what prevents deadlock between two
   * accumulators touching the same markets in different slip orders — the
   * same argument as transfer() locking wallets by ascending id.
   *
   * The pooled client is never used here: pgBouncer in transaction mode
   * silently breaks the FOR UPDATE the stake debit depends on.
   */
  async placeBet(request: PlaceBetRequest): Promise<PlacedBet> {
    if (request.legs.length === 0) throw new EmptySlipError();

    const seen = new Set<string>();
    for (const leg of request.legs) {
      if (seen.has(leg.selectionId)) throw new DuplicateSelectionError(leg.selectionId);
      seen.add(leg.selectionId);
    }

    if (
      request.stakeMinor < this.config.minStakeMinor ||
      request.stakeMinor > this.config.maxStakeMinor
    ) {
      throw new StakeLimitError(
        request.stakeMinor,
        this.config.minStakeMinor,
        this.config.maxStakeMinor,
      );
    }

    return this.database.transaction(
      async (tx) => {
        await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
        await tx.execute(sql.raw("SET LOCAL lock_timeout = '30s'"));

        await this.assertAccountEligible(tx, request.userId);
        // Wager and loss ceilings the player set for themselves. Checked
        // before the market work so a limited player is refused cheaply.
        await this.responsible.assertStakeWithinLimits(tx, request.userId, request.stakeMinor);
        const locked = await this.lockAndLoadSelections(tx, [...seen]);
        const legOddsScaled = this.resolvePrices(
          request.legs,
          locked,
          request.driftPolicy ?? this.config.driftPolicy,
        );

        const pricing = priceBet(legOddsScaled, request.stakeMinor);

        // Exposure before money: a market that cannot absorb the liability is
        // a cheaper rejection than a wallet lock, and taking exposure rows in
        // a fixed order keeps the global lock sequence deterministic.
        const marketIds = [...new Set(locked.map((row) => row.market_id))].sort();
        for (const marketId of marketIds) {
          await this.claimExposure(tx, marketId, pricing.liabilityMinor);
        }

        // INVARIANT 8: the stake debit and the bet rows share this
        // transaction. debitWithin keeps the ledger write inside the wallet
        // module (INVARIANT 6) while letting it enlist here.
        const debit = await this.wallet.debitWithin(tx, {
          walletId: request.walletId,
          amountMinor: request.stakeMinor,
          type: "STAKE",
          idempotencyKey: request.idempotencyKey,
          actor: { type: "USER", id: request.userId, ip: request.ip },
          metadata: { kind: "BET_STAKE", legs: request.legs.length },
        });

        // INVARIANT 11, the per-user half. Checked HERE, after the debit,
        // rather than alongside the market ceiling above — and that placement
        // is deliberate.
        //
        // The debit holds this user's wallet row lock, so two of their bets
        // arriving at once are serialised by the time we get here. Checking
        // before the debit would let both read the same pre-existing exposure
        // and jointly breach the cap — the classic read-then-write race, and
        // the reason the market ceiling uses an atomic conditional UPDATE
        // instead of a read.
        //
        // Moving the wallet lock earlier would fix it too, but would invert
        // the global exposure-then-wallet order and deadlock against
        // settlement.
        await this.assertUserExposureWithinCap(tx, request.userId, pricing.liabilityMinor);

        // A resubmitted slip — a double-tapped button, a retried request —
        // replays the wallet debit rather than charging again, and
        // `idempotent` says so. The bet that debit already funded must then
        // be RETURNED, not inserted again: bets_stake_txn_unique would refuse
        // the second insert and the caller would see a server error for a bet
        // that had in fact been placed, and might well try a third time.
        //
        // The constraint stays as the backstop. This is the graceful path in
        // front of it.
        if (debit.idempotent) {
          const existing = await this.findBetByStakeTxn(tx, debit.transactionId);
          if (existing) {
            /*
             * GIVE BACK THE EXPOSURE THIS ATTEMPT CLAIMED.
             *
             * The replay is detected here, but exposure was claimed further up
             * — it has to be, because the global lock order is exposure before
             * wallet and inverting it would deadlock against settlement. So a
             * duplicate submit reserved the liability a SECOND time against
             * every market on the slip, while creating no second bet to ever
             * release it.
             *
             * Settlement releases one bet's worth, so the difference stayed on
             * the market permanently and ate into a ceiling that exists to cap
             * risk. Enough double-taps and a market stops accepting legitimate
             * bets for a liability nobody is carrying.
             *
             * Found on the real recovered bet: its market held exactly
             * `potential_return - stake` after settlement, and it had exactly
             * one duplicate submit behind it.
             *
             * Released here rather than by checking earlier because an early
             * check cannot be race-proof: two identical submits can both pass
             * it, and only the wallet lock serialises them. Undoing precisely
             * what this attempt added is correct in both cases.
             */
            for (const marketId of marketIds) {
              await this.releaseExposure(tx, marketId, pricing.liabilityMinor);
            }
            return existing;
          }
        }

        const [bet] = await tx
          .insert(bets)
          .values({
            userId: request.userId,
            stakeTxnId: debit.transactionId,
            stakeMinor: request.stakeMinor,
            totalOddsDecimal: pricing.totalOddsDecimal,
            potentialReturnMinor: pricing.potentialReturnMinor,
            status: "PENDING",
          })
          .returning({ id: bets.id });
        if (!bet) throw new Error("bet insert returned no row");

        await tx.insert(betLegs).values(
          request.legs.map((leg, index) => ({
            betId: bet.id,
            selectionId: leg.selectionId,
            lockedOddsDecimal: formatScaledOdds(legOddsScaled[index]!),
          })),
        );

        return {
          betId: bet.id,
          stakeTxnId: debit.transactionId,
          stakeMinor: request.stakeMinor,
          totalOddsDecimal: pricing.totalOddsDecimal,
          potentialReturnMinor: pricing.potentialReturnMinor,
          balanceAfterMinor: debit.balanceAfterMinor,
        };
      },
      { isolationLevel: "read committed", accessMode: "read write" },
    );
  }

  /**
   * Total liability across the account's open bets, plus this one.
   *
   * Liability is the bet's own immutable (potential return - stake), the same
   * figure claimed against the market at placement and released at
   * settlement — so the two views of exposure can never disagree.
   *
   * Only PENDING bets count: a settled or cashed-out bet has already paid or
   * lost and holds nothing.
   */
  private async assertUserExposureWithinCap(
    tx: DirectTransaction,
    userId: string,
    incomingLiabilityMinor: bigint,
  ): Promise<void> {
    const [row] = await tx.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(potential_return_minor - stake_minor), 0)::text AS total
      FROM bets
      WHERE user_id = ${userId}::uuid AND status = 'PENDING'
    `);

    const open = BigInt(row?.total ?? "0");
    if (open + incomingLiabilityMinor > this.config.maxUserExposureMinor) {
      throw new UserExposureLimitError(
        userId,
        open + incomingLiabilityMinor,
        this.config.maxUserExposureMinor,
      );
    }
  }

  /**
   * The bet a given stake debit already funded, if any.
   *
   * Returns the ORIGINAL placement facts — stake, locked odds, payout — not a
   * recomputed quote, so a replay reports exactly what was accepted the first
   * time even if prices have moved since.
   */
  private async findBetByStakeTxn(
    tx: DirectTransaction,
    stakeTxnId: string,
  ): Promise<PlacedBet | null> {
    const [row] = await tx.execute<{
      id: string;
      stake_minor: string;
      total_odds_decimal: string;
      potential_return_minor: string;
      cached_balance_minor: string;
    }>(sql`
      SELECT b.id,
             b.stake_minor::text            AS stake_minor,
             b.total_odds_decimal::text     AS total_odds_decimal,
             b.potential_return_minor::text AS potential_return_minor,
             w.cached_balance_minor::text   AS cached_balance_minor
      FROM bets b
      JOIN wallets w
        ON w.user_id = b.user_id AND w.kind = 'USER' AND w.currency = 'NGN'
        AND w.bucket = 'CASH'
      WHERE b.stake_txn_id = ${stakeTxnId}::uuid
    `);
    if (!row) return null;

    return {
      betId: row.id,
      stakeTxnId,
      stakeMinor: BigInt(row.stake_minor),
      totalOddsDecimal: row.total_odds_decimal,
      potentialReturnMinor: BigInt(row.potential_return_minor),
      balanceAfterMinor: BigInt(row.cached_balance_minor),
    };
  }

  /**
   * §7: a self-excluded user must never place a bet.
   *
   * The account-status check alone is NOT sufficient and used to be all this
   * did. Self-exclusion is registered against a verified identity so that it
   * survives re-registration; someone who excludes themselves and signs up
   * again with a new email gets a fresh ACTIVE account, and only the
   * identity-level check in ResponsibleService catches them.
   */
  private async assertAccountEligible(tx: DirectTransaction, userId: string): Promise<void> {
    const [account] = await tx
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!account) throw new AccountNotEligibleError(userId, "UNKNOWN");
    if (account.status !== "ACTIVE") {
      throw new AccountNotEligibleError(userId, account.status);
    }

    /*
     * An account with no date of birth on file has never passed the age gate.
     *
     * The database trigger only fires when the column is NOT NULL, so these
     * accounts — created before the date was collected — sit outside the age
     * control entirely. They are not underage; they are unverified, which is the
     * same thing to a regulator asking how you know. No new bet until they
     * answer. The completion flow is one screen and the check disappears once
     * the column can be made NOT NULL.
     *
     * In the same transaction as the rest of placement, so a date supplied
     * concurrently either lands before this read or after the whole bet.
     */
    if (await dateOfBirthService.isMissingWithin(tx, userId)) {
      throw new AccountNotEligibleError(userId, "DATE_OF_BIRTH_REQUIRED");
    }

    // Identity-level exclusion and cooling-off. Runs in the placement
    // transaction, so an exclusion committed concurrently is either seen here
    // or lands after this bet — never half-applied.
    await this.responsible.assertNotExcluded(tx, userId);
  }

  /**
   * Locks the selections and their markets, then reads status under the lock.
   *
   * FOR SHARE, not a plain read: under READ COMMITTED a concurrent
   * suspension could otherwise commit between our status read and our commit,
   * and we would accept a bet on a market that is suspended by the time the
   * stake lands. The share lock makes the suspending UPDATE wait; reading
   * status afterwards means that if the suspension got in first we observe it
   * and abort.
   *
   * Rows are locked selections-then-markets, matching the order the odds sync
   * worker suspends them in. Any future admin suspension must use the same
   * order or it can deadlock against placement.
   *
   * `already_started` is computed from the database's now(), never a JS
   * Date — a serverless instance with a skewed clock would otherwise accept
   * bets after kickoff.
   */
  private async lockAndLoadSelections(
    tx: DirectTransaction,
    selectionIds: string[],
  ): Promise<LockedSelection[]> {
    const ordered = [...selectionIds].sort();

    await tx
      .select({ id: selections.id })
      .from(selections)
      .where(inArray(selections.id, ordered))
      .orderBy(asc(selections.id))
      .for("share");

    const marketIdRows = await tx
      .selectDistinct({ marketId: selections.marketId })
      .from(selections)
      .where(inArray(selections.id, ordered));

    await tx
      .select({ id: markets.id })
      .from(markets)
      .where(
        inArray(
          markets.id,
          marketIdRows.map((row) => row.marketId),
        ),
      )
      .orderBy(asc(markets.id))
      .for("share");

    const rows = await tx.execute<LockedSelection>(sql`
      SELECT
        s.id                     AS selection_id,
        s.status::text           AS selection_status,
        s.current_price_decimal  AS current_price_decimal,
        m.id                     AS market_id,
        m.status::text           AS market_status,
        e.id                     AS event_id,
        e.status::text           AS event_status,
        e.starts_at              AS starts_at,
        (e.starts_at <= now())   AS already_started
      FROM selections s
      JOIN markets m ON m.id = s.market_id
      JOIN events  e ON e.id = m.event_id
      WHERE s.id IN (${sql.join(ordered.map((id) => sql`${id}::uuid`), sql`, `)})
    `);

    for (const id of ordered) {
      const row = rows.find((candidate) => candidate.selection_id === id);
      if (!row) throw new SelectionUnavailableError(id, "MISSING");
      if (row.selection_status !== "OPEN") {
        throw new SelectionUnavailableError(id, "SELECTION_CLOSED");
      }
      if (row.market_status !== "OPEN") {
        throw new SelectionUnavailableError(id, "MARKET_CLOSED");
      }
      if (row.event_status !== "PENDING" && row.event_status !== "LIVE") {
        throw new SelectionUnavailableError(id, "EVENT_CLOSED");
      }
      // Pre-match only for now. In-play placement needs its own suspension
      // handling and belongs with the live product, not here.
      if (row.already_started) throw new EventStartedError(row.event_id);
    }

    return rows;
  }

  /**
   * Compares the submitted price against the locked live price and returns
   * the odds the bet will actually carry.
   */
  private resolvePrices(
    legs: SlipLeg[],
    locked: LockedSelection[],
    policy: OddsDriftPolicy,
  ): bigint[] {
    return legs.map((leg) => {
      const row = locked.find((candidate) => candidate.selection_id === leg.selectionId)!;
      const submitted = parseOddsToScaled(leg.odds);
      const current = parseOddsToScaled(row.current_price_decimal);

      if (submitted === current) return submitted;

      if (policy === "ACCEPT_ANY") {
        // The customer chose to accept whatever the price is on arrival. Their
        // bet carries the LIVE price, not the stale one they submitted.
        return current;
      }

      if (policy === "ACCEPT_IF_BETTER" && current > submitted) {
        // Strictly better for the user. Honour the improved price rather than
        // the stale one, so the bet reflects the live book.
        return current;
      }

      throw new OddsDriftError(
        leg.selectionId,
        formatScaledOdds(submitted),
        formatScaledOdds(current),
      );
    });
  }

  /**
   * Adds this bet's liability to a market, or refuses.
   *
   * One conditional statement, like the odds budget guard: a read-then-write
   * pair would let two concurrent bets each observe the same pre-increment
   * total and jointly breach the ceiling. Zero rows returned means the
   * ceiling refused it.
   *
   * The full liability is attributed to EVERY market on an accumulator. That
   * overstates risk, since an acca only pays when all legs win — but
   * overstating is the safe direction. Modelling leg correlation is a risk
   * engine's job (Phase 7), and faking it here would be worse than being
   * conservative.
   */
  private async claimExposure(
    tx: DirectTransaction,
    marketId: string,
    liabilityMinor: bigint,
  ): Promise<void> {
    const claimed = await tx.execute<{ total_liability_minor: string }>(sql`
      INSERT INTO exposure (market_id, total_liability_minor, ceiling_minor, updated_at)
      VALUES (
        ${marketId}::uuid,
        ${liabilityMinor.toString()}::bigint,
        ${this.config.defaultMarketCeilingMinor.toString()}::bigint,
        now()
      )
      ON CONFLICT (market_id) DO UPDATE
        SET total_liability_minor = exposure.total_liability_minor + ${liabilityMinor.toString()}::bigint,
            updated_at = now()
        WHERE exposure.total_liability_minor + ${liabilityMinor.toString()}::bigint
              <= exposure.ceiling_minor
      RETURNING total_liability_minor
    `);

    if (claimed.length === 0) throw new ExposureLimitError(marketId, liabilityMinor);
  }

  /**
   * Returns liability a placement attempt claimed but did not use.
   *
   * The mirror of `claimExposure`, for the idempotent-replay path only. There
   * is no conditional here: giving liability back can never breach a ceiling,
   * and `GREATEST(0, ...)` keeps a double-release from driving the row
   * negative, which the CHECK constraint would refuse anyway.
   */
  private async releaseExposure(
    tx: DirectTransaction,
    marketId: string,
    liabilityMinor: bigint,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE exposure
      SET total_liability_minor = GREATEST(
            0,
            total_liability_minor - ${liabilityMinor.toString()}::bigint
          ),
          updated_at = now()
      WHERE market_id = ${marketId}::uuid
    `);
  }
}

export const placementService = new PlacementService();
