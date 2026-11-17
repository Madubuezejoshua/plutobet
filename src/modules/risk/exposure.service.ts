import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";

/**
 * Exposure monitoring and fraud signals (§7).
 *
 * Everything here is a READ. It uses the pooled client deliberately: these
 * queries feed dashboards and alerts, never a money decision. The binding
 * exposure check still happens inside the placement transaction against the
 * locked row — a monitoring query is a lagging view by nature, and treating
 * one as authorisation is how a book quietly writes past its own ceiling.
 *
 * Signals are SIGNALS. Every fraud heuristic below produces false positives
 * (shared phones, family accounts, one office network), so nothing here
 * suspends anyone automatically. It surfaces cases for a human.
 */

export interface MarketExposure {
  marketId: string;
  eventId: string;
  fixture: string;
  marketKey: string;
  totalLiabilityMinor: bigint;
  ceilingMinor: bigint;
  /** 0–100. */
  utilisationPercent: number;
}

export interface ExposureAlert extends MarketExposure {
  severity: "WARNING" | "CRITICAL";
}

export interface FraudSignal {
  kind: "SHARED_IP" | "RAPID_STAKING" | "REPEAT_DEVICE";
  severity: "LOW" | "MEDIUM" | "HIGH";
  detail: string;
  userIds: string[];
}

export class ExposureService {
  /**
   * Markets ranked by how much of their ceiling is committed.
   *
   * Ordered by utilisation rather than absolute liability: a small market at
   * 95% is closer to refusing real bets than a large one at 20%, and the
   * former is the one a trader needs to see.
   */
  async topExposedMarkets(limit = 20): Promise<MarketExposure[]> {
    const rows = await db.execute<{
      market_id: string;
      event_id: string;
      home: string;
      away: string;
      market_key: string;
      total_liability_minor: string;
      ceiling_minor: string;
      utilisation: string;
    }>(sql`
      SELECT
        e.market_id,
        m.event_id,
        ev.home,
        ev.away,
        m.key AS market_key,
        e.total_liability_minor::text,
        e.ceiling_minor::text,
        ROUND((e.total_liability_minor::numeric / NULLIF(e.ceiling_minor, 0)) * 100, 2)::text
          AS utilisation
      FROM exposure e
      JOIN markets m ON m.id = e.market_id
      JOIN events ev ON ev.id = m.event_id
      WHERE e.total_liability_minor > 0
      ORDER BY (e.total_liability_minor::numeric / NULLIF(e.ceiling_minor, 0)) DESC NULLS LAST
      LIMIT ${limit}
    `);

    return rows.map((row) => ({
      marketId: row.market_id,
      eventId: row.event_id,
      fixture: `${row.home} v ${row.away}`,
      marketKey: row.market_key,
      totalLiabilityMinor: BigInt(row.total_liability_minor),
      ceilingMinor: BigInt(row.ceiling_minor),
      utilisationPercent: Number(row.utilisation ?? 0),
    }));
  }

  /**
   * Markets that need attention now.
   *
   * WARNING at 80% is early enough to raise a ceiling or trim a price before
   * customers start seeing refusals; CRITICAL at 95% means refusals are
   * imminent. Both thresholds are judgement, not arithmetic — the point is
   * that someone hears about it before the customer does.
   */
  async alerts(): Promise<ExposureAlert[]> {
    const markets = await this.topExposedMarkets(100);
    return markets
      .filter((market) => market.utilisationPercent >= 80)
      .map((market) => ({
        ...market,
        severity: market.utilisationPercent >= 95 ? "CRITICAL" : "WARNING",
      }));
  }

  /** Total live liability across every open market. */
  async totalOpenLiabilityMinor(): Promise<bigint> {
    const [row] = await db.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(e.total_liability_minor), 0)::text AS total
      FROM exposure e
      JOIN markets m ON m.id = e.market_id
      WHERE m.status = 'OPEN'
    `);
    return BigInt(row?.total ?? "0");
  }

  /**
   * Accounts sharing a source IP.
   *
   * The audit trail already records the actor's IP on every money movement
   * (§3.13), so this needs no new tracking. A shared address is weak on its
   * own — Nigerian mobile networks put many legitimate users behind one
   * CGNAT address — so it is scored by how many accounts, and it never acts
   * on its own.
   */
  async sharedIpSignals(params?: { sinceDays?: number; minAccounts?: number }): Promise<FraudSignal[]> {
    const sinceDays = params?.sinceDays ?? 7;
    const minAccounts = params?.minAccounts ?? 3;

    const rows = await db.execute<{ ip: string; user_ids: string[]; accounts: number }>(sql`
      SELECT a.ip::text AS ip,
             array_agg(DISTINCT a.actor_id::text) AS user_ids,
             count(DISTINCT a.actor_id)::int AS accounts
      FROM audit_log a
      WHERE a.actor_type = 'USER'
        AND a.ip IS NOT NULL
        AND a.created_at > now() - (${sinceDays}::text || ' days')::interval
      GROUP BY a.ip
      HAVING count(DISTINCT a.actor_id) >= ${minAccounts}
      ORDER BY count(DISTINCT a.actor_id) DESC
      LIMIT 50
    `);

    return rows.map((row) => ({
      kind: "SHARED_IP" as const,
      // Carrier NAT makes a handful of accounts unremarkable; a dozen on one
      // address is worth a look.
      severity: row.accounts >= 10 ? "HIGH" : row.accounts >= 5 ? "MEDIUM" : "LOW",
      detail: `${row.accounts} accounts placed money movements from ${row.ip} in ${sinceDays} days`,
      userIds: row.user_ids,
    }));
  }

  /**
   * Accounts staking unusually fast.
   *
   * A burst of stakes in a short window is the shape of both scripted
   * arbitrage and a player in difficulty — which is why it is reported rather
   * than blocked: the two need opposite responses, and only a human can tell
   * them apart.
   */
  async rapidStakingSignals(params?: { windowMinutes?: number; minBets?: number }): Promise<FraudSignal[]> {
    const windowMinutes = params?.windowMinutes ?? 5;
    const minBets = params?.minBets ?? 20;

    const rows = await db.execute<{ user_id: string; bets: number }>(sql`
      SELECT user_id::text AS user_id, count(*)::int AS bets
      FROM bets
      WHERE placed_at > now() - (${windowMinutes}::text || ' minutes')::interval
      GROUP BY user_id
      HAVING count(*) >= ${minBets}
      ORDER BY count(*) DESC
      LIMIT 50
    `);

    return rows.map((row) => ({
      kind: "RAPID_STAKING" as const,
      severity: row.bets >= minBets * 3 ? "HIGH" : "MEDIUM",
      detail: `${row.bets} bets placed in ${windowMinutes} minutes`,
      userIds: [row.user_id],
    }));
  }

  async allSignals(): Promise<FraudSignal[]> {
    const [sharedIp, rapid] = await Promise.all([
      this.sharedIpSignals(),
      this.rapidStakingSignals(),
    ]);
    return [...sharedIp, ...rapid];
  }
}

export const exposureService = new ExposureService();
