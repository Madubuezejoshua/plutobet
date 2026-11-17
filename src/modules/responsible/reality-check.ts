import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";

/**
 * Reality checks.
 *
 * Spec 20.5 lists these alongside limits and self-exclusion, and they are the
 * cheapest genuinely effective intervention in responsible gambling: an
 * interruption that tells somebody how long they have been playing and what
 * they are actually up or down.
 *
 * WHY THE NET FIGURE, NOT THE WINS
 * A session that has staked ₦40,000 and won ₦30,000 feels like winning. It is a
 * ₦10,000 loss. Showing turnover or wins alone is the kind of number that keeps
 * somebody playing; showing the net is the number that tells them the truth.
 *
 * WHY THIS IS NOT A NAG
 * It fires on an interval the customer can see and reports facts without advice.
 * A reality check that lectures gets dismissed unread, which makes it worse than
 * none — and a customer who has learnt to click through a warning has learnt to
 * click through every warning.
 */

export const DEFAULT_INTERVAL_MINUTES = 60;

export interface SessionActivity {
  /** How long since the first bet in this run of play. */
  minutesActive: number;
  betsPlaced: number;
  stakedMinor: bigint;
  returnedMinor: bigint;
  /** Returns minus stakes. Negative means down. */
  netMinor: bigint;
}

/**
 * What the customer has done since a given moment.
 *
 * Computed from the LEDGER rather than from a session counter, so it survives
 * a page reload, a second tab, and switching between phone and laptop —
 * anywhere a counter would quietly reset and understate the session.
 */
export async function activitySince(userId: string, since: Date): Promise<SessionActivity> {
  const [row] = await db.execute<{
    bets: number;
    staked: string;
    returned: string;
    first_at: Date | null;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE t.type = 'STAKE' AND e.direction = 'DEBIT')::int AS bets,
      COALESCE(SUM(e.amount_minor) FILTER (
        WHERE t.type = 'STAKE' AND e.direction = 'DEBIT'), 0)::text AS staked,
      COALESCE(SUM(e.amount_minor) FILTER (
        WHERE t.type IN ('PAYOUT', 'REFUND') AND e.direction = 'CREDIT'), 0)::text AS returned,
      min(e.created_at) AS first_at
    FROM ledger_entries e
    JOIN ledger_transactions t ON t.id = e.txn_id
    JOIN wallets w ON w.id = e.wallet_id
    WHERE w.user_id = ${userId}::uuid AND w.kind = 'USER'
      AND e.created_at >= ${since.toISOString()}::timestamptz
  `);

  const stakedMinor = BigInt(row?.staked ?? "0");
  const returnedMinor = BigInt(row?.returned ?? "0");
  const firstAt = row?.first_at ? new Date(row.first_at) : null;

  return {
    minutesActive: firstAt ? Math.round((Date.now() - firstAt.getTime()) / 60_000) : 0,
    betsPlaced: Number(row?.bets ?? 0),
    stakedMinor,
    returnedMinor,
    netMinor: returnedMinor - stakedMinor,
  };
}

export interface RealityCheck {
  due: boolean;
  activity: SessionActivity;
  message: string;
}

/**
 * Whether to interrupt, and what to say.
 *
 * Never fires on a customer who has not staked anything: interrupting somebody
 * for browsing is the fastest way to teach them to dismiss the message without
 * reading it, and then it is worth nothing on the day it matters.
 */
export async function realityCheckFor(
  userId: string,
  sessionStartedAt: Date,
  intervalMinutes = DEFAULT_INTERVAL_MINUTES,
): Promise<RealityCheck> {
  const activity = await activitySince(userId, sessionStartedAt);

  const due = activity.betsPlaced > 0 && activity.minutesActive >= intervalMinutes;

  return { due, activity, message: describe(activity) };
}

/**
 * The wording.
 *
 * Facts, in the customer's own money, with no advice and no judgement. The net
 * figure leads because it is the one people misjudge — and it is stated as a
 * loss when it is a loss, rather than softened into "down".
 */
function describe(activity: SessionActivity): string {
  const hours = Math.floor(activity.minutesActive / 60);
  const minutes = activity.minutesActive % 60;
  const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  const net = activity.netMinor;
  const netText =
    net === 0n
      ? "You are level."
      : net > 0n
        ? `You are up ${naira(net)}.`
        : `You are down ${naira(-net)}.`;

  return [
    `You have been playing for ${duration} and placed ${activity.betsPlaced} ${
      activity.betsPlaced === 1 ? "bet" : "bets"
    }.`,
    `Staked ${naira(activity.stakedMinor)}, returned ${naira(activity.returnedMinor)}.`,
    netText,
  ].join(" ");
}

function naira(minor: bigint): string {
  const whole = (minor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `₦${whole}.${(minor % 100n).toString().padStart(2, "0")}`;
}
