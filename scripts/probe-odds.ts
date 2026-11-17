/**
 * RUN THIS BEFORE TRUSTING THE ODDS ADAPTER.
 *
 *   ODDS_API_KEY=xxx npx tsx scripts/probe-odds.ts
 *
 * Every field name in src/modules/odds/odds-api-io.ts is currently a
 * best-effort reading of the public docs — nothing has ever been checked
 * against a live response. Phase 4 makes that riskier than it was in Phase 2:
 * settlement parses `periods.ft` to decide who gets paid, so if the real feed
 * nests scores differently, bets settle against a score that is not there and
 * every one of them raises UnsettleableError (or worse, settles wrong).
 *
 * Costs roughly 5-6 requests against the daily budget. Prints raw shapes and
 * then runs them through the real mappers so you can see exactly what the
 * adapter would produce.
 */
import "dotenv/config";
import { mapMarketKey, mapSelectionKey } from "@/modules/odds/canonical";

const KEY = process.env.ODDS_API_KEY;
if (!KEY) {
  console.error("set ODDS_API_KEY (see .env.example)");
  process.exit(1);
}

const BASE = "https://api.odds-api.io/v3";

async function hit(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("apiKey", KEY!);

  const res = await fetch(url, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => null);
  console.log(`\n${"=".repeat(72)}\n${path}  ->  ${res.status}`);
  console.log(JSON.stringify(body, null, 2).slice(0, 2200));
  return body;
}

/*
 * Reading a third party's JSON without pretending to know its shape.
 *
 * `unknown` rather than `any`: the payload genuinely IS unknown — that is the
 * entire point of a probe — but `any` disables checking everywhere the value
 * travels, so a typo in a property name becomes a silent `undefined` in the
 * output rather than a compile error. These two helpers narrow once, at the
 * boundary, and everything downstream stays checked.
 */
function asArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const data = prop(raw, "data");
  if (Array.isArray(data)) return data;
  const events = prop(raw, "events");
  if (Array.isArray(events)) return events;
  return [];
}

function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

async function main() {
  // Public endpoints — confirm connectivity and which books the plan includes.
  await hit("/sports");
  const books = await hit("/bookmakers/selected");

  const events = await hit("/events", { sport: "football" });
  const first = asArray(events)[0];
  if (!first) {
    console.log("\n!! no events returned — check the sport slug before going further");
    return;
  }

  const eventId = text(prop(first, "id") ?? prop(first, "eventId"));
  const odds = await hit("/odds", { eventId });

  // Run the live payload through the real mappers. Anything printed as
  // "DROPPED" is a market or selection the adapter would silently discard.
  console.log(`\n${"=".repeat(72)}\nMAPPER DRY RUN (what the adapter would keep)`);
  const entry = asArray(odds)[0] ?? odds;
  for (const book of asArray(prop(entry, "bookmakers") ?? prop(entry, "books"))) {
    console.log(`\nbookmaker: ${text(prop(book, "name") ?? prop(book, "bookmaker"))}`);
    const markets = prop(book, "markets");
    const marketEntries: [string, unknown][] =
      typeof markets === "object" && markets !== null
        ? Object.entries(markets as Record<string, unknown>)
        : [];
    for (const [rawKey, payload] of marketEntries) {
      const market = mapMarketKey(rawKey);
      if (!market) {
        console.log(`  DROPPED market "${rawKey}" — no canonical mapping`);
        continue;
      }
      const rows = asArray(prop(payload, "selections") ?? payload);
      for (const s of rows) {
        const label = text(prop(s, "name") ?? prop(s, "label"));
        const rawLine = prop(s, "line");
        const line = rawLine === undefined ? undefined : Number(rawLine);
        const key = mapSelectionKey(market, label, line);
        console.log(
          key
            ? `  ${market.padEnd(14)} "${label}" -> ${key}  @ ${text(prop(s, "odds") ?? prop(s, "price"))}`
            : `  DROPPED selection "${label}" in ${market} — no canonical mapping`,
        );
      }
    }
  }

  // The endpoint settlement depends on. This is the important one now.
  const detail = await hit(`/events/${eventId}`);
  const e: unknown = prop(detail, "data") ?? detail;
  console.log(`\n${"=".repeat(72)}\nSETTLEMENT SHAPE CHECK`);
  const scores = prop(e, "scores");
  const periods = prop(scores, "periods");
  console.log(`status:          ${text(prop(e, "status"))}`);
  console.log(`scores:          ${JSON.stringify(scores)}`);
  console.log(`scores.periods:  ${JSON.stringify(periods)}`);
  console.log(
    prop(periods, "ft")
      ? "  OK — periods.ft is present, settlement can read a regulation score"
      : "  !! periods.ft NOT FOUND. resolveLeg() reads periods.ft for every\n" +
        "     match-result market. Correct the mapping in odds-api-io.ts\n" +
        "     getResults() before settling anything with real money.",
  );

  console.log(`
${"=".repeat(72)}
CHECKLIST — confirm each against the output above, then fix odds-api-io.ts:
  [ ] event id field:          id | eventId | ?
  [ ] kickoff field:           startTime | commenceTime | date | ?
  [ ] markets: object keyed by name, or an array?
  [ ] odds price field:        odds | price | ?
  [ ] decimal or american?     (>1.01 and fractional => decimal)
  [ ] suspended selections:    omitted, or price 0/null?
  [ ] period scores live at:   scores.periods | periods | ?
  [ ] regulation key spelled:  ft | FT | fulltime | ?
  [ ] your bookmakers:         ${JSON.stringify(books)?.slice(0, 120)}
`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
