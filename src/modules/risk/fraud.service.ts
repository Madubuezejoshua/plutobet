import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";

/**
 * Fraud and risk signals.
 *
 * THE RULE THAT SHAPES THIS ENTIRE MODULE
 * Spec 20.4: "Do not automatically confiscate balances purely because an AI
 * model said an account is suspicious."
 *
 * So nothing here acts. Every function returns a SIGNAL for a human to judge,
 * and the reason is not squeamishness — it is that each of these heuristics has
 * a completely innocent explanation that is more common than the guilty one:
 *
 *   Shared IP        a family, a shared flat, a phone on carrier NAT — which in
 *                    Nigeria can put a whole city behind one address.
 *   Rapid staking    somebody enjoying a Saturday.
 *   Big win          somebody got lucky. That is the product working.
 *   Fast withdrawal  somebody who needed their money.
 *
 * An automated freeze on any of these punishes ordinary customers far more
 * often than it catches anyone, and a wrongly frozen balance is a complaint to
 * the regulator rather than a support ticket.
 */

export type SignalSeverity = "LOW" | "MEDIUM" | "HIGH";

export interface RiskSignal {
  kind: string;
  severity: SignalSeverity;
  detail: string;
  userIds: string[];
  /** Stated so a reviewer sees the innocent explanation before the guilty one. */
  innocentExplanation: string;
}

/**
 * Accounts sharing a device fingerprint or address.
 *
 * Deliberately MEDIUM at most. In Nigeria, carrier-grade NAT routinely puts
 * thousands of unrelated people behind one address, so treating a shared IP as
 * strong evidence would flag half a city.
 */
export async function sharedAddressSignals(limit = 20): Promise<RiskSignal[]> {
  const rows = await db.execute<{ ip: string; user_ids: string[]; n: number }>(sql`
    SELECT a.ip::text AS ip,
           array_agg(DISTINCT a.actor_id::text) AS user_ids,
           count(DISTINCT a.actor_id)::int AS n
    FROM audit_log a
    WHERE a.actor_type = 'USER' AND a.ip IS NOT NULL
      AND a.created_at > now() - INTERVAL '30 days'
    GROUP BY a.ip
    HAVING count(DISTINCT a.actor_id) >= 4
    ORDER BY count(DISTINCT a.actor_id) DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => ({
    kind: "SHARED_ADDRESS",
    // Never HIGH on its own. It is corroborating evidence, not a finding.
    severity: Number(row.n) >= 10 ? "MEDIUM" : "LOW",
    detail: `${row.n} accounts share the address ${row.ip}`,
    userIds: row.user_ids,
    innocentExplanation:
      "Carrier NAT, a shared flat, a family, or a public network. Common and usually innocent.",
  }));
}

/**
 * Accounts that deposit and withdraw with little betting in between.
 *
 * The clearest laundering shape there is: money in, money out, minimal
 * turnover. Still not proof — somebody who deposited, changed their mind and
 * withdrew looks identical, and that is a customer behaving reasonably.
 */
export async function passThroughSignals(limit = 20): Promise<RiskSignal[]> {
  const rows = await db.execute<{
    user_id: string;
    deposited: string;
    withdrawn: string;
    staked: string;
  }>(sql`
    SELECT w.user_id::text AS user_id,
           COALESCE(SUM(e.amount_minor) FILTER (
             WHERE t.type = 'DEPOSIT' AND e.direction = 'CREDIT'), 0)::text AS deposited,
           COALESCE(SUM(e.amount_minor) FILTER (
             WHERE t.type = 'WITHDRAWAL' AND e.direction = 'DEBIT'), 0)::text AS withdrawn,
           COALESCE(SUM(e.amount_minor) FILTER (
             WHERE t.type = 'STAKE' AND e.direction = 'DEBIT'), 0)::text AS staked
    FROM ledger_entries e
    JOIN ledger_transactions t ON t.id = e.txn_id
    JOIN wallets w ON w.id = e.wallet_id
    WHERE w.kind = 'USER' AND e.created_at > now() - INTERVAL '30 days'
    GROUP BY w.user_id
    HAVING COALESCE(SUM(e.amount_minor) FILTER (
             WHERE t.type = 'DEPOSIT' AND e.direction = 'CREDIT'), 0) > 50000000
       AND COALESCE(SUM(e.amount_minor) FILTER (
             WHERE t.type = 'STAKE' AND e.direction = 'DEBIT'), 0) <
           COALESCE(SUM(e.amount_minor) FILTER (
             WHERE t.type = 'DEPOSIT' AND e.direction = 'CREDIT'), 0) / 5
    ORDER BY 2 DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => {
    const deposited = BigInt(row.deposited);
    const staked = BigInt(row.staked);
    const turnoverRatio = deposited === 0n ? 0 : Number((staked * 100n) / deposited);

    return {
      kind: "PASS_THROUGH",
      // The one signal that can reach HIGH alone: large sums with almost no
      // betting is the shape AML rules exist for.
      severity: turnoverRatio < 5 ? "HIGH" : "MEDIUM",
      detail: `Deposited ${formatKobo(deposited)}, staked only ${turnoverRatio}% of it`,
      userIds: [row.user_id],
      innocentExplanation:
        "A customer who deposited, changed their mind, and withdrew. Check whether the payout " +
        "account matches their verified name.",
    };
  });
}

/**
 * Multiple accounts verified to the same identity.
 *
 * The one genuinely strong signal here. A BVN is not shareable in the way an
 * address is, so the same verified identity on two accounts is either
 * multi-accounting or a data error — and both need a human.
 *
 * The KYC service already refuses this at verification time; this catches
 * anything that predates the check or arrived by another route.
 */
export async function duplicateIdentitySignals(limit = 20): Promise<RiskSignal[]> {
  const rows = await db.execute<{ user_ids: string[]; n: number }>(sql`
    SELECT array_agg(DISTINCT user_id::text) AS user_ids, count(DISTINCT user_id)::int AS n
    FROM kyc_records
    WHERE bvn_hash IS NOT NULL
    GROUP BY bvn_hash
    HAVING count(DISTINCT user_id) > 1
    LIMIT ${limit}
  `);

  return rows.map((row) => ({
    kind: "DUPLICATE_IDENTITY",
    severity: "HIGH",
    detail: `${row.n} accounts verified to the same identity`,
    userIds: row.user_ids,
    innocentExplanation:
      "A data error, or an account recreated after a lost login. Rare, but check before acting.",
  }));
}

/**
 * Every signal, most serious first.
 *
 * Each failure is caught separately: one unavailable query must not hide the
 * others, because the risk queue being empty for the wrong reason is worse than
 * it being short.
 */
export async function allSignals(): Promise<RiskSignal[]> {
  const groups = await Promise.all([
    sharedAddressSignals().catch((error: unknown) => {
      console.error("[risk] shared-address signals unavailable", error);
      return [] as RiskSignal[];
    }),
    passThroughSignals().catch((error: unknown) => {
      console.error("[risk] pass-through signals unavailable", error);
      return [] as RiskSignal[];
    }),
    duplicateIdentitySignals().catch((error: unknown) => {
      console.error("[risk] duplicate-identity signals unavailable", error);
      return [] as RiskSignal[];
    }),
  ]);

  const order: Record<SignalSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return groups.flat().sort((a, b) => order[a.severity] - order[b.severity]);
}

function formatKobo(minor: bigint): string {
  const whole = (minor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `₦${whole}`;
}
