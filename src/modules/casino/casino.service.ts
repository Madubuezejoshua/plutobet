import { createHash, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { responsibleService, ResponsibleService } from "../responsible/responsible.service";
import { walletService, WalletService } from "../wallet/wallet.service";
import type { WalletTransaction } from "../wallet/types";
import { CasinoError } from "./errors";
import { casinoSessions, gameRounds } from "./schema";

export { CasinoError };

/**
 * Casino aggregator integration.
 *
 * No game logic and no RNG: outcomes come from a certified aggregator
 * (Spribe, Pragmatic, SoftSwiss), because self-built RNG does not pass
 * GLI-33. This module authenticates their callbacks, moves money through the
 * wallet service like every other money path, and keeps the evidence.
 *
 * THE RISK HERE IS REPLAY. Aggregators retry callbacks on any timeout, and a
 * naive handler credits a win twice. Every operation below is idempotent on a
 * key derived from the round reference AND the operation, because one round
 * legitimately produces several money movements — keying on the round alone
 * would make a win dedupe against its own stake.
 */

export interface RoundOperationResult {
  roundId: string;
  balanceMinor: bigint;
  /** True when this callback repeated work already done. */
  duplicate: boolean;
}

/** Tokens are compared by digest; the raw value is never stored. */
function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class CasinoService {
  constructor(
    private readonly wallet: WalletService = walletService,
    private readonly responsible: ResponsibleService = responsibleService,
  ) {}

  /**
   * Issues a launch token for the aggregator.
   *
   * The RG gate is here as well as on each stake: refusing at launch means a
   * self-excluded player never reaches the game at all, rather than loading
   * it and being rejected on their first spin.
   */
  async createSession(params: {
    userId: string;
    provider: string;
    game?: string;
    ttlSeconds?: number;
  }): Promise<{ token: string; expiresAt: Date }> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      await this.assertMayPlay(tx, params.userId);

      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + (params.ttlSeconds ?? 300) * 1000);

      await tx.insert(casinoSessions).values({
        userId: params.userId,
        provider: params.provider,
        tokenHash: tokenDigest(token),
        game: params.game ?? null,
        expiresAt,
      });

      // The raw token is returned once and never persisted.
      return { token, expiresAt };
    });
  }

  /** Balance callback. Read-only, but still authenticates the token. */
  async getBalance(provider: string, token: string): Promise<bigint> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const userId = await this.resolveSession(tx, provider, token);
      return this.balanceOf(tx, userId);
    });
  }

  /**
   * Stake debit for one round.
   *
   * Idempotent on the round reference: a retried callback returns the balance
   * from the original debit rather than taking the stake again.
   */
  async debitRound(params: {
    provider: string;
    token: string;
    roundRef: string;
    game: string;
    amountMinor: bigint;
    raw?: Record<string, unknown>;
  }): Promise<RoundOperationResult> {
    return this.wallet.withMoneyTransaction(async ({ tx, debit }) => {
      const userId = await this.resolveSession(tx, params.provider, params.token);
      await this.assertMayPlay(tx, userId);
      // Casino turnover counts against the same wager and loss ceilings as
      // sports betting. A limit that only covered one product would not be a
      // limit on the player's spending.
      await this.responsible.assertStakeWithinLimits(tx, userId, params.amountMinor);

      const existing = await this.lockRound(tx, params.provider, params.roundRef);
      if (existing?.debit_txn_id) {
        return {
          roundId: existing.id,
          balanceMinor: await this.balanceOf(tx, userId),
          duplicate: true,
        };
      }

      const walletId = await this.walletIdFor(tx, userId);
      const result = await debit({
        walletId,
        amountMinor: params.amountMinor,
        type: "STAKE",
        // Round reference AND operation: see the class note.
        idempotencyKey: `casino:debit:${params.provider}:${params.roundRef}`,
        actor: { type: "SYSTEM" },
        metadata: { kind: "CASINO_STAKE", provider: params.provider, roundRef: params.roundRef },
      });

      if (existing) {
        await tx
          .update(gameRounds)
          .set({
            stakeMinor: params.amountMinor,
            debitTxnId: result.transactionId,
            updatedAt: new Date(),
          })
          .where(eq(gameRounds.id, existing.id));
        return { roundId: existing.id, balanceMinor: result.balanceAfterMinor, duplicate: false };
      }

      const [round] = await tx
        .insert(gameRounds)
        .values({
          userId,
          provider: params.provider,
          providerRoundRef: params.roundRef,
          game: params.game,
          stakeMinor: params.amountMinor,
          debitTxnId: result.transactionId,
          rawPayload: params.raw ?? {},
        })
        .returning({ id: gameRounds.id });
      if (!round) throw new Error("game round insert returned no row");

      return { roundId: round.id, balanceMinor: result.balanceAfterMinor, duplicate: false };
    });
  }

  /**
   * Win credit for one round, closing it.
   *
   * A zero-payout credit is legitimate — it is how an aggregator reports a
   * losing round — and must still close the round without a ledger entry,
   * since the ledger rejects zero-amount movements.
   */
  async creditRound(params: {
    provider: string;
    token: string;
    roundRef: string;
    amountMinor: bigint;
    raw?: Record<string, unknown>;
  }): Promise<RoundOperationResult> {
    return this.wallet.withMoneyTransaction(async ({ tx, credit }) => {
      const userId = await this.resolveSession(tx, params.provider, params.token);
      const round = await this.lockRound(tx, params.provider, params.roundRef);
      if (!round) {
        throw new CasinoError("ROUND_NOT_FOUND", `unknown round ${params.roundRef}`);
      }
      if (round.credit_txn_id || round.status !== "OPEN") {
        return {
          roundId: round.id,
          balanceMinor: await this.balanceOf(tx, userId),
          duplicate: true,
        };
      }

      let creditTxnId: string | null = null;
      let balanceMinor: bigint;

      if (params.amountMinor > 0n) {
        const result = await credit({
          walletId: await this.walletIdFor(tx, userId),
          amountMinor: params.amountMinor,
          type: "PAYOUT",
          idempotencyKey: `casino:credit:${params.provider}:${params.roundRef}`,
          actor: { type: "SYSTEM" },
          metadata: {
            kind: "CASINO_PAYOUT",
            provider: params.provider,
            roundRef: params.roundRef,
          },
        });
        creditTxnId = result.transactionId;
        balanceMinor = result.balanceAfterMinor;
      } else {
        balanceMinor = await this.balanceOf(tx, userId);
      }

      await tx
        .update(gameRounds)
        .set({
          payoutMinor: params.amountMinor,
          creditTxnId,
          status: "SETTLED",
          updatedAt: new Date(),
        })
        .where(eq(gameRounds.id, round.id));

      return { roundId: round.id, balanceMinor, duplicate: false };
    });
  }

  /**
   * Cancels a round and returns the stake.
   *
   * Aggregators roll back on their own errors. A round that already paid out
   * is NOT rolled back here — reversing a settled win is an accounting
   * correction that belongs to admin adjustment with its own audit, not to an
   * automated callback.
   */
  async rollbackRound(params: {
    provider: string;
    token: string;
    roundRef: string;
  }): Promise<RoundOperationResult> {
    return this.wallet.withMoneyTransaction(async ({ tx, credit }) => {
      const userId = await this.resolveSession(tx, params.provider, params.token);
      const round = await this.lockRound(tx, params.provider, params.roundRef);
      if (!round) throw new CasinoError("ROUND_NOT_FOUND", `unknown round ${params.roundRef}`);

      if (round.status === "ROLLED_BACK") {
        return {
          roundId: round.id,
          balanceMinor: await this.balanceOf(tx, userId),
          duplicate: true,
        };
      }
      if (round.status === "SETTLED") {
        throw new CasinoError("ROUND_CLOSED", `round ${params.roundRef} has already settled`);
      }

      const stakeMinor = BigInt(round.stake_minor);
      let balanceMinor: bigint;
      let rollbackTxnId: string | null = null;

      if (stakeMinor > 0n) {
        const result = await credit({
          walletId: await this.walletIdFor(tx, userId),
          amountMinor: stakeMinor,
          type: "REFUND",
          idempotencyKey: `casino:rollback:${params.provider}:${params.roundRef}`,
          actor: { type: "SYSTEM" },
          metadata: {
            kind: "CASINO_ROLLBACK",
            provider: params.provider,
            roundRef: params.roundRef,
          },
        });
        rollbackTxnId = result.transactionId;
        balanceMinor = result.balanceAfterMinor;
      } else {
        balanceMinor = await this.balanceOf(tx, userId);
      }

      await tx
        .update(gameRounds)
        .set({ status: "ROLLED_BACK", rollbackTxnId, updatedAt: new Date() })
        .where(eq(gameRounds.id, round.id));

      return { roundId: round.id, balanceMinor, duplicate: false };
    });
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private async assertMayPlay(tx: WalletTransaction, userId: string): Promise<void> {
    const [account] = await tx.execute<{ status: string }>(sql`
      SELECT status::text AS status FROM users WHERE id = ${userId}::uuid
    `);
    if (!account) throw new CasinoError("NOT_PERMITTED", "unknown user");
    if (account.status !== "ACTIVE") {
      throw new CasinoError("NOT_PERMITTED", `account is ${account.status}`);
    }
    // Identity-level exclusion and cooling-off apply to casino exactly as
    // they do to sports betting.
    await this.responsible.assertNotExcluded(tx, userId);
  }

  private async resolveSession(
    tx: WalletTransaction,
    provider: string,
    token: string,
  ): Promise<string> {
    const [row] = await tx.execute<{ user_id: string }>(sql`
      SELECT user_id FROM casino_sessions
      WHERE provider = ${provider}
        AND token_hash = ${tokenDigest(token)}
        AND expires_at > now()
    `);
    if (!row) throw new CasinoError("INVALID_SESSION", "session is unknown or expired");
    return row.user_id;
  }

  /**
   * Locks the round row so concurrent callbacks for the same round serialise.
   * Returns null when the round has not been seen yet.
   */
  private async lockRound(tx: WalletTransaction, provider: string, roundRef: string) {
    const [row] = await tx.execute<{
      id: string;
      status: string;
      stake_minor: string;
      debit_txn_id: string | null;
      credit_txn_id: string | null;
    }>(sql`
      SELECT id, status::text AS status, stake_minor::text AS stake_minor,
             debit_txn_id, credit_txn_id
      FROM game_rounds
      WHERE provider = ${provider} AND provider_round_ref = ${roundRef}
      FOR UPDATE
    `);
    return row ?? null;
  }

  private async balanceOf(tx: WalletTransaction, userId: string): Promise<bigint> {
    const [row] = await tx.execute<{ cached_balance_minor: string }>(sql`
      SELECT cached_balance_minor::text AS cached_balance_minor
      FROM wallets
      WHERE user_id = ${userId}::uuid AND kind = 'USER' AND currency = 'NGN'
        AND bucket = 'CASH'
    `);
    if (!row) throw new Error(`no NGN wallet for user ${userId}`);
    return BigInt(row.cached_balance_minor);
  }

  private async walletIdFor(tx: WalletTransaction, userId: string): Promise<string> {
    const [row] = await tx.execute<{ id: string }>(sql`
      SELECT id FROM wallets
      WHERE user_id = ${userId}::uuid AND kind = 'USER' AND currency = 'NGN'
        AND bucket = 'CASH'
    `);
    if (!row) throw new Error(`no NGN wallet for user ${userId}`);
    return row.id;
  }
}

export const casinoService = new CasinoService();
