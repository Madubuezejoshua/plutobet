import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { balancesForUser } from "../wallet/lookup";
import { listUpcoming } from "../odds/odds.service";
import { liveSnapshot } from "../odds/live-feed";
import { headToHead, teamForm } from "../sports/results.service";
import { naira, parseNairaToKobo } from "@/lib/money";
import {
  authoriseToolCall,
  GuardrailError,
  PREDICTION_DISCLAIMER,
  resolveDestination,
  type CallerContext,
} from "./guardrails";
import { describeEstimate, estimateMatch, impliedOdds } from "./prediction";

/**
 * Tool dispatch.
 *
 * The model never touches a service. It emits a tool NAME and arguments; this
 * authorises the call, then runs a hand-written function. There is no dynamic
 * dispatch, no eval, and no path from a model output to arbitrary code.
 *
 * THE DRAFT RULE (spec 13, 14, 17.2)
 * A financial tool returns a DRAFT — a description of what would happen, with
 * everything the customer needs to decide. It never performs the action. The
 * customer confirms through the ordinary product flow, which re-reads live
 * prices and re-runs every check, because a slip assembled from a chat two
 * minutes ago is not a slip anybody agreed to at today's odds.
 */

export interface ToolResult {
  ok: boolean;
  /** Rendered for the customer. Plain text, never markup. */
  summary: string;
  /** Structured payload the UI may render richly. */
  data?: Record<string, unknown>;
  /** Present on a draft: what confirming it would do, and where. */
  draft?: { action: string; href: string; detail: string };
  /** Present when the runtime is sending the customer somewhere. */
  navigate?: { href: string; label: string };
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  caller: CallerContext,
): Promise<ToolResult> {
  try {
    // Authorisation FIRST, always. Nothing below runs for a call that was not
    // permitted, and nothing below re-checks — this is the only gate, so it
    // cannot be forgotten in one branch.
    authoriseToolCall(name, caller);
  } catch (error) {
    if (error instanceof GuardrailError) {
      return { ok: false, summary: error.message, data: { code: error.code } };
    }
    throw error;
  }

  switch (name) {
    case "findFixtures":
      return findFixtures(String(args.query ?? ""));
    case "getOdds":
      return getOdds(String(args.eventId ?? ""));
    case "getLiveEvents":
      return getLiveEvents();
    case "getHeadToHead":
      return getHeadToHeadTool(String(args.eventId ?? ""));
    case "explainMarket":
      return explainMarket(String(args.market ?? ""));
    case "getBalance":
      return getBalance(caller.userId!);
    case "getMyBets":
      return getMyBets(caller.userId!);
    case "getMyTransactions":
      return getMyTransactions(caller.userId!, Number(args.limit ?? 10));
    case "getPromotions":
      return getPromotions();
    case "navigate":
      return navigate(String(args.destination ?? ""));
    case "prepareBet":
      return prepareBet(String(args.selectionIds ?? ""), Number(args.stakeNaira ?? 0));
    case "prepareWithdrawal":
      return prepareWithdrawal(caller.userId!, Number(args.amountNaira ?? 0));
    default:
      // Unreachable: authoriseToolCall rejects unknown names. Kept so adding a
      // tool without a handler fails loudly rather than silently doing nothing.
      return { ok: false, summary: `${name} is not implemented` };
  }
}

// ---------------------------------------------------------------- read tools

async function findFixtures(query: string): Promise<ToolResult> {
  const events = await listUpcoming({ sport: "football", limit: 40 });
  const needle = query.trim().toLowerCase();

  const matches = needle
    ? events.filter(
        (event) =>
          event.home.toLowerCase().includes(needle) ||
          event.away.toLowerCase().includes(needle) ||
          event.league.toLowerCase().includes(needle),
      )
    : events;

  if (matches.length === 0) {
    // Rule 19.1: say we cannot find it rather than inventing a fixture.
    return {
      ok: true,
      summary: needle
        ? `I could not find any upcoming fixture matching "${query}".`
        : "No fixtures are loaded right now.",
    };
  }

  const shown = matches.slice(0, 8);
  return {
    ok: true,
    summary: shown
      .map(
        (event) =>
          `${event.home} v ${event.away} — ${event.league}, ${new Date(event.startsAt).toLocaleString("en-NG", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`,
      )
      .join("\n"),
    data: { events: shown.map((e) => ({ id: e.id, home: e.home, away: e.away })) },
  };
}

async function getOdds(eventId: string): Promise<ToolResult> {
  const events = await listUpcoming({ sport: "football", limit: 60 });
  const event = events.find((candidate) => candidate.id === eventId);
  if (!event) return { ok: true, summary: "I cannot find that fixture on the board right now." };

  const market = event.markets.find((m) => m.key === "1x2");
  if (!market) {
    return { ok: true, summary: `${event.home} v ${event.away}: match odds are not open.` };
  }

  return {
    ok: true,
    summary: `${event.home} v ${event.away}\n${market.selections
      .map((s) => `${s.label}: ${s.price.toFixed(2)}`)
      .join(" · ")}`,
    data: { eventId: event.id, selections: market.selections },
  };
}

async function getLiveEvents(): Promise<ToolResult> {
  const snapshot = await liveSnapshot("football", 10);
  const live = snapshot.events.filter((event) => event.status === "LIVE");

  if (live.length === 0) return { ok: true, summary: "Nothing is in play at the moment." };

  return {
    ok: true,
    summary: live
      .map(
        (event) =>
          `${event.fixture}${
            event.homeScore !== null ? ` — ${event.homeScore}-${event.awayScore}` : ""
          }`,
      )
      .join("\n"),
  };
}

/**
 * Head-to-head plus a probability estimate.
 *
 * The estimate comes from prediction.ts, NOT from the model. The disclaimer is
 * appended here as fixed text so it cannot be paraphrased away.
 */
async function getHeadToHeadTool(eventId: string): Promise<ToolResult> {
  const [event] = await db.execute<{
    home_team_id: string | null;
    away_team_id: string | null;
    home: string;
    away: string;
  }>(sql`
    SELECT home_team_id, away_team_id, home, away FROM events WHERE id = ${eventId}::uuid
  `);

  if (!event) return { ok: true, summary: "I cannot find that fixture." };
  if (!event.home_team_id || !event.away_team_id) {
    return {
      ok: true,
      summary: `I do not have enough history on ${event.home} or ${event.away} to compare them.`,
    };
  }

  const [homeForm, awayForm, meetings] = await Promise.all([
    teamForm(event.home_team_id),
    teamForm(event.away_team_id),
    headToHead(event.home_team_id, event.away_team_id, 5),
  ]);

  if (!homeForm || !awayForm) {
    return { ok: true, summary: "I do not have form data for both teams yet." };
  }

  const estimate = estimateMatch(homeForm, awayForm);
  const lines = [
    describeEstimate(estimate, event.home, event.away),
    "",
    `Implied fair prices: ${event.home} ${impliedOdds(estimate.home) ?? "-"} · Draw ${
      impliedOdds(estimate.draw) ?? "-"
    } · ${event.away} ${impliedOdds(estimate.away) ?? "-"}`,
  ];

  if (meetings.meetings.length > 0) {
    lines.push(
      "",
      `Last ${meetings.meetings.length} meetings: ${event.home} ${meetings.teamAWins}, draws ${meetings.draws}, ${event.away} ${meetings.teamBWins}`,
    );
  }

  lines.push("", PREDICTION_DISCLAIMER);

  return { ok: true, summary: lines.join("\n"), data: { estimate } };
}

const MARKET_EXPLANATIONS: Record<string, string> = {
  "1x2": "Home win, draw, or away win. One of the three must happen.",
  double_chance:
    "Two of the three outcomes. Safer than a straight pick, so the price is shorter.",
  over_under:
    "Whether total goals go over or under a line. Over 2.5 needs three or more goals; there is no half goal, so it cannot be a push.",
  btts: "Both teams to score. Needs at least one goal each, whoever wins.",
  handicap:
    "One side starts with a virtual lead or deficit. The handicap is applied to the real score to settle.",
  correct_score: "The exact final score. Long odds because there are many possibilities.",
  ht_ft: "Who leads at half time and who wins at full time. Both must be right.",
};

async function explainMarket(market: string): Promise<ToolResult> {
  const key = market.trim().toLowerCase().replace(/[\s-]/g, "_");
  const explanation = MARKET_EXPLANATIONS[key];

  return explanation
    ? { ok: true, summary: explanation }
    : {
        ok: true,
        summary: `I do not have an explanation for "${market}". I can explain: ${Object.keys(MARKET_EXPLANATIONS).join(", ")}.`,
      };
}

// ------------------------------------------------------------ account tools

async function getBalance(userId: string): Promise<ToolResult> {
  const balances = await balancesForUser(userId);

  const lines = [`Cash: ${naira(balances.cashMinor)} (withdrawable)`];
  if (balances.bonusMinor > 0n) {
    // Never folded into one figure. A customer told a single number and then
    // refused at cash-out has been misled at the worst moment.
    lines.push(`Bonus: ${naira(balances.bonusMinor)} (not withdrawable yet)`);
  }
  if (balances.lockedMinor > 0n) {
    lines.push(`On hold: ${naira(balances.lockedMinor)}`);
  }

  return { ok: true, summary: lines.join("\n"), data: { withdrawable: balances.cashMinor.toString() } };
}

async function getMyBets(userId: string): Promise<ToolResult> {
  const rows = await db.execute<{
    status: string;
    stake_minor: string;
    potential_return_minor: string;
    placed_at: Date;
  }>(sql`
    SELECT status::text AS status, stake_minor::text AS stake_minor,
           potential_return_minor::text AS potential_return_minor, placed_at
    FROM bets WHERE user_id = ${userId}::uuid
    ORDER BY placed_at DESC LIMIT 10
  `);

  if (rows.length === 0) return { ok: true, summary: "You have not placed any bets yet." };

  return {
    ok: true,
    summary: rows
      .map(
        (row) =>
          `${new Date(row.placed_at).toLocaleDateString("en-NG")} — ${naira(BigInt(row.stake_minor))} to return ${naira(BigInt(row.potential_return_minor))} · ${row.status}`,
      )
      .join("\n"),
  };
}

async function getMyTransactions(userId: string, limit: number): Promise<ToolResult> {
  const capped = Math.min(Math.max(Number.isFinite(limit) ? limit : 10, 1), 25);

  const rows = await db.execute<{
    type: string;
    direction: string;
    amount_minor: string;
    created_at: Date;
  }>(sql`
    SELECT lt.type::text AS type, le.direction::text AS direction,
           le.amount_minor::text AS amount_minor, le.created_at
    FROM ledger_entries le
    JOIN ledger_transactions lt ON lt.id = le.txn_id
    JOIN wallets w ON w.id = le.wallet_id
    WHERE w.user_id = ${userId}::uuid AND w.kind = 'USER'
    ORDER BY le.created_at DESC LIMIT ${capped}
  `);

  if (rows.length === 0) return { ok: true, summary: "No transactions yet." };

  return {
    ok: true,
    summary: rows
      .map(
        (row) =>
          `${new Date(row.created_at).toLocaleDateString("en-NG")} ${row.type} ${row.direction === "CREDIT" ? "+" : "-"}${naira(BigInt(row.amount_minor))}`,
      )
      .join("\n"),
  };
}

async function getPromotions(): Promise<ToolResult> {
  const rows = await db.execute<{ name: string; description: string; wagering_multiplier: number }>(
    sql`
      SELECT name, description, wagering_multiplier FROM promotions
      WHERE active = true AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
      ORDER BY created_at DESC LIMIT 5
    `,
  );

  if (rows.length === 0) return { ok: true, summary: "No promotions are running right now." };

  return {
    ok: true,
    // The wagering requirement is stated with every offer, never omitted.
    summary: rows
      .map((row) => `${row.name}: ${row.description} (wagering ${row.wagering_multiplier}x)`)
      .join("\n"),
  };
}

async function navigate(destination: string): Promise<ToolResult> {
  try {
    const resolved = resolveDestination(destination);
    return {
      ok: true,
      summary: `Opening ${resolved.label}.`,
      navigate: { href: resolved.href, label: resolved.label },
    };
  } catch (error) {
    if (error instanceof GuardrailError) return { ok: false, summary: error.message };
    throw error;
  }
}

// ---------------------------------------------------------- financial drafts

/**
 * Builds a bet slip for review. Places nothing.
 *
 * Prices are read live and shown, but the customer confirms on the betslip
 * itself, where they are read again. A slip assembled from a conversation two
 * minutes ago is not a slip anybody agreed to at today's odds.
 */
async function prepareBet(selectionIdList: string, stakeNaira: number): Promise<ToolResult> {
  const selectionIds = selectionIdList
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (selectionIds.length === 0) {
    return { ok: false, summary: "I need at least one selection to build a slip." };
  }

  const stakeMinor = parseNairaToKobo(String(stakeNaira));
  if (stakeMinor === null || stakeMinor <= 0n) {
    return { ok: false, summary: "That stake is not a valid amount." };
  }

  const rows = await db.execute<{
    id: string;
    label: string;
    price: string;
    home: string;
    away: string;
    open: boolean;
  }>(sql`
    SELECT s.id, s.label, s.current_price_decimal::text AS price, e.home, e.away,
           (s.status = 'OPEN' AND m.status = 'OPEN' AND e.starts_at > now()) AS open
    FROM selections s
    JOIN markets m ON m.id = s.market_id
    JOIN events e ON e.id = m.event_id
    WHERE s.id IN (${sql.join(selectionIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `);

  if (rows.length !== selectionIds.length) {
    return { ok: false, summary: "I could not find all of those selections." };
  }

  const unavailable = rows.filter((row) => !row.open);
  if (unavailable.length > 0) {
    return {
      ok: false,
      summary: `${unavailable.map((r) => `${r.home} v ${r.away}`).join(", ")} is no longer available to bet on.`,
    };
  }

  const combined = rows.reduce((total, row) => total * Number(row.price), 1);
  const potentialReturn = (stakeMinor * BigInt(Math.round(combined * 1000))) / 1000n;

  return {
    ok: true,
    summary: [
      "Here is the slip. Nothing has been placed.",
      ...rows.map((row) => `${row.home} v ${row.away} — ${row.label} @ ${Number(row.price).toFixed(2)}`),
      `Stake ${naira(stakeMinor)} · combined ${combined.toFixed(2)} · returns ${naira(potentialReturn)}`,
    ].join("\n"),
    draft: {
      action: "PLACE_BET",
      href: "/sports",
      detail: "Open your betslip to confirm. Prices are checked again when you place.",
    },
  };
}

/**
 * Prepares a withdrawal for review. Moves nothing.
 *
 * Shows the balance, the amount and the verification level, because those are
 * what decides whether it will actually go through — telling somebody a
 * withdrawal is ready and then refusing it at the form is worse than saying so
 * here.
 */
async function prepareWithdrawal(userId: string, amountNaira: number): Promise<ToolResult> {
  const amountMinor = parseNairaToKobo(String(amountNaira));
  if (amountMinor === null || amountMinor <= 0n) {
    return { ok: false, summary: "That is not a valid amount." };
  }

  const balances = await balancesForUser(userId);
  const [account] = await db.execute<{ kyc_level: number }>(sql`
    SELECT kyc_level FROM users WHERE id = ${userId}::uuid
  `);
  const tier = Number(account?.kyc_level ?? 0);

  if (tier === 0) {
    return {
      ok: false,
      summary:
        "You need to verify your identity before withdrawing. I can take you to the verification page.",
      navigate: { href: "/kyc", label: "Verify identity" },
    };
  }

  if (amountMinor > balances.withdrawableMinor) {
    return {
      ok: false,
      summary: `You have ${naira(balances.withdrawableMinor)} withdrawable. Bonus credit cannot be withdrawn until its wagering is met.`,
    };
  }

  return {
    ok: true,
    summary: [
      `Withdrawal of ${naira(amountMinor)} is ready to confirm. Nothing has been sent.`,
      `Withdrawable balance: ${naira(balances.withdrawableMinor)}`,
    ].join("\n"),
    draft: {
      action: "WITHDRAW",
      href: "/withdraw",
      detail: "Confirm on the withdrawal page, where you enter your bank details.",
    },
  };
}
