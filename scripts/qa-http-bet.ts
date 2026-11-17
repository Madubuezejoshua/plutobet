/**
 * Stage 8/9: sign in and place a bet over REAL HTTP.
 *
 *   npx tsx scripts/qa-http-bet.ts <email> <password> [baseUrl]
 *
 * Authenticates through the NextAuth credentials callback and carries the
 * session cookie into `POST /api/bets` — the same path the betslip uses. A
 * service-level call would skip the session check, the Zod boundary and the
 * rate limiter, which are precisely the parts a route test exists to cover.
 *
 * Also runs the placement negative cases against the REAL persisted market:
 * overdraw, zero stake, stale odds, and a duplicate submit under one
 * idempotency key.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";

const BASE = (process.argv[4] ?? "http://localhost:3000").replace(/\/$/, "");
const jar = new Map<string, string>();

function remember(res: Response) {
  // Node exposes multiple Set-Cookie headers through getSetCookie().
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const index = pair!.indexOf("=");
    if (index > 0) jar.set(pair!.slice(0, index), pair!.slice(index + 1));
  }
}

function cookieHeader(): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function http(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), cookie: cookieHeader() },
    redirect: "manual",
  });
  remember(res);
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text.slice(0, 160) };
  }
  return { status: res.status, body };
}

async function signIn(email: string, password: string): Promise<boolean> {
  const csrf = await http("/api/auth/csrf");
  const token = String(csrf.body.csrfToken ?? "");
  if (!token) return false;

  const res = await http("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken: token, email, password, json: "true" }).toString(),
  });
  // NextAuth answers 200 or a 302; the session cookie is what actually matters.
  const session = await http("/api/auth/session");
  return res.status < 400 && Boolean((session.body as { user?: unknown }).user);
}

async function cashBalance(email: string): Promise<bigint> {
  const [row] = await db.execute<{ bal: string }>(sql`
    SELECT w.cached_balance_minor::text AS bal
    FROM wallets w JOIN users u ON u.id = w.user_id
    WHERE u.email = ${email} AND w.kind = 'USER' AND w.currency = 'NGN' AND w.bucket = 'CASH'
  `);
  return BigInt(row?.bal ?? "0");
}

/** An open 1x2 selection on a fixture that has not kicked off. */
async function pickSelection() {
  const [row] = await db.execute<{
    selection_id: string;
    sel: string;
    price: string;
    home: string;
    away: string;
    league: string;
    starts_at: Date;
    provider_event_id: string;
    event_id: string;
  }>(sql`
    SELECT s.id::text AS selection_id, s.key AS sel,
           s.current_price_decimal::text AS price,
           e.home, e.away, e.league, e.starts_at,
           e.provider_event_id, e.id::text AS event_id
    FROM selections s
    JOIN markets m ON m.id = s.market_id
    JOIN events e ON e.id = m.event_id
    WHERE m.key = '1x2' AND m.status = 'OPEN' AND s.status = 'OPEN'
      AND s.current_price_decimal > 1
      AND e.status = 'PENDING'
      AND e.starts_at > now() + interval '45 minutes'
    ORDER BY e.starts_at
    LIMIT 1
  `);
  return row ?? null;
}

function report(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name.padEnd(38)} ${detail}`);
  return ok;
}

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];
  if (!email || !password) throw new Error("usage: qa-http-bet.ts <email> <password> [baseUrl]");

  const authed = await signIn(email, password);
  report("sign in via NextAuth", authed, authed ? "session established" : "NO SESSION");
  if (!authed) process.exit(1);

  const pick = await pickSelection();
  if (!pick) {
    console.log("BLOCKED: no open 1x2 selection on an un-started fixture");
    process.exit(2);
  }

  console.log(`\nEVENT   ${pick.home} v ${pick.away}`);
  console.log(`LEAGUE  ${pick.league}`);
  console.log(`KICKOFF ${new Date(pick.starts_at).toISOString()}`);
  console.log(`PICK    ${pick.sel} @ ${pick.price}`);
  console.log(`IDS     provider=${pick.provider_event_id} internal=${pick.event_id}\n`);

  const before = await cashBalance(email);
  console.log(`CASH BEFORE: ${before} kobo\n`);

  const place = (stake: string, key: string, odds = pick.price) =>
    http("/api/bets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stakeMinor: stake,
        legs: [{ selectionId: pick.selection_id, odds }],
        idempotencyKey: key,
      }),
    });

  // ---- negative cases against the real market --------------------------
  const over = await place(String(before + 1n), `qa-over:${randomUUID()}`);
  report("stake above balance refused", over.status >= 400, `HTTP ${over.status} ${String(over.body.error ?? "")}`);

  const zero = await place("0", `qa-zero:${randomUUID()}`);
  report("zero stake refused", zero.status >= 400, `HTTP ${zero.status} ${String(zero.body.error ?? "")}`);

  const stalePrice = (Number(pick.price) + 0.9).toFixed(3);
  const stale = await place("1000", `qa-stale:${randomUUID()}`, stalePrice);
  report("stale odds refused", stale.status >= 400, `HTTP ${stale.status} ${String(stale.body.error ?? "")}`);

  // ---- the real bet ----------------------------------------------------
  const slipKey = `qa-slip:${randomUUID()}`;
  const bet = await place("20000", slipKey);
  const betId = String(bet.body.betId ?? "");
  report("POST /api/bets", bet.status < 300 && Boolean(betId), `HTTP ${bet.status} ${betId || JSON.stringify(bet.body).slice(0, 140)}`);
  if (!betId) process.exit(1);

  console.log(`\nBET`);
  console.log(`  betId           : ${betId}`);
  console.log(`  stake           : ${bet.body.stakeMinor}`);
  console.log(`  locked odds     : ${bet.body.totalOddsDecimal}`);
  console.log(`  potential return: ${bet.body.potentialReturnMinor}`);

  // ---- duplicate submit, same key --------------------------------------
  const replay = await place("20000", slipKey);
  const sameBet = String(replay.body.betId ?? "") === betId;
  report("duplicate submit -> one bet", sameBet, sameBet ? "same betId returned" : "DUPLICATE CREATED");

  // ---- same key, different stake ---------------------------------------
  const conflict = await place("15000", slipKey);
  report("same key, different stake conflicts", conflict.status >= 400, `HTTP ${conflict.status} ${String(conflict.body.error ?? "")}`);

  const after = await cashBalance(email);
  console.log(`\nCASH AFTER: ${after} kobo (was ${before})`);
  report("stake left the balance at placement", after === before - 20000n, `${before} -> ${after}`);

  const [row] = await db.execute<{ status: string; locked: string; potential: string }>(sql`
    SELECT b.status::text, l.locked_odds_decimal::text AS locked,
           b.potential_return_minor::text AS potential
    FROM bets b JOIN bet_legs l ON l.bet_id = b.id
    WHERE b.id = ${betId}::uuid
  `);
  console.log(`  db status: ${row?.status}  locked leg odds: ${row?.locked}  potential: ${row?.potential}`);
  console.log(`\nBET_ID=${betId}`);
  console.log(`PROVIDER_EVENT_ID=${pick.provider_event_id}`);
  console.log(`KICKOFF=${new Date(pick.starts_at).toISOString()}`);

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("qa-http-bet failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
