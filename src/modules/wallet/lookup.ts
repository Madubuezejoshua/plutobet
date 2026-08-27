import { and, eq } from "drizzle-orm";
/*
 * WHY THIS FILE IS EXEMPT FROM THE dbDirect RULE
 *
 * The project rule is "money paths must use dbDirect", because PgBouncer's
 * transaction pooling breaks a FOR UPDATE lock held across statements. This
 * file is the deliberate exception, and the exception is narrow:
 *
 *   Every function here performs a SINGLE read of a wallet's identity. None
 *   of them takes a lock, spans statements, or writes anything. There is no
 *   cross-statement lock for pooling to break.
 *
 * A stale read cannot cause a double-spend: the wallet service re-reads and
 * LOCKS the row on the unpooled connection before moving anything, so the
 * worst outcome of a stale id here is a "wallet not found" the caller already
 * handles. Routing these through the unpooled pool would instead consume a
 * scarce direct connection on every page render — the header balance alone
 * would exhaust it.
 *
 * If anything in this file ever needs to hold a lock or write, it belongs in
 * wallet.service.ts and this exemption must NOT be widened to cover it.
 */
// eslint-disable-next-line no-restricted-imports -- see the note above
import { db } from "@/db/pooled";
import { wallets, type WalletBucket } from "./schema";

/**
 * The user's spendable cash wallet.
 *
 * Defaults to CASH on purpose. Every existing caller — the balance chip, bet
 * placement, withdrawals, the statement — means "the money this person can
 * actually spend", and bonus credit is not that. Keeping the default here
 * meant balance segregation changed no existing behaviour.
 */
export async function walletForUser(userId: string): Promise<string | null> {
  return walletForUserBucket(userId, "CASH");
}

export async function walletForUserBucket(
  userId: string,
  bucket: WalletBucket,
): Promise<string | null> {
  const [row] = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(
      and(
        eq(wallets.userId, userId),
        eq(wallets.kind, "USER"),
        eq(wallets.currency, "NGN"),
        eq(wallets.bucket, bucket),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

export interface WalletBucketRow {
  id: string;
  bucket: WalletBucket;
  balanceMinor: bigint;
}

/**
 * Every bucket for one account, in one query.
 *
 * Returns rows rather than a shaped object so a caller that only wants cash
 * does not pay for the rest, and so adding a bucket does not change this
 * signature.
 */
export async function walletsForUser(userId: string): Promise<WalletBucketRow[]> {
  const rows = await db
    .select({
      id: wallets.id,
      bucket: wallets.bucket,
      balance: wallets.cachedBalanceMinor,
    })
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.kind, "USER"), eq(wallets.currency, "NGN")));

  return rows
    .filter((row): row is typeof row & { bucket: WalletBucket } => row.bucket !== null)
    .map((row) => ({
      id: row.id,
      bucket: row.bucket,
      balanceMinor: row.balance ?? 0n,
    }));
}

export interface AccountBalances {
  cashMinor: bigint;
  bonusMinor: bigint;
  lockedMinor: bigint;
  /** Cash plus bonus. What the account is worth; NOT what it can withdraw. */
  totalMinor: bigint;
  /** Cash only. The figure a withdrawal is checked against. */
  withdrawableMinor: bigint;
}

/**
 * The balances a customer should be shown.
 *
 * `withdrawable` is deliberately a separate field from `total` rather than
 * something the UI derives. A player who sees one number and discovers at
 * cash-out that a third of it was bonus credit has been misled at exactly the
 * wrong moment, and every screen that shows a balance should be reading the
 * distinction from here rather than reinventing it.
 */
export async function balancesForUser(userId: string): Promise<AccountBalances> {
  const rows = await walletsForUser(userId);
  const of = (bucket: WalletBucket) =>
    rows.find((row) => row.bucket === bucket)?.balanceMinor ?? 0n;

  const cashMinor = of("CASH");
  const bonusMinor = of("BONUS");
  const lockedMinor = of("LOCKED");

  return {
    cashMinor,
    bonusMinor,
    lockedMinor,
    totalMinor: cashMinor + bonusMinor,
    withdrawableMinor: cashMinor,
  };
}
