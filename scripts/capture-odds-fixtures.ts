/**
 * Captures REAL odds-api.io responses as test fixtures.
 *
 *   npx tsx scripts/capture-odds-fixtures.ts
 *
 * The adapter's field names were originally best-effort readings of the public
 * docs. `probe-odds.ts` checks them by eye, once, by a human. This writes the
 * same responses to disk so a test can check them on every run, forever.
 *
 * Costs ~4 requests. Writes to src/modules/odds/__tests__/fixtures/.
 *
 * THE API KEY IS STRIPPED before anything is written — the fixtures are
 * committed, so a key reaching one would be a key published to GitHub.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY = process.env.ODDS_API_KEY;
if (!KEY) {
  console.error("set ODDS_API_KEY");
  process.exit(1);
}

const BASE = "https://api.odds-api.io/v3";
const OUT = join(process.cwd(), "src/modules/odds/__tests__/fixtures");

/**
 * Removes anything that could identify the account.
 *
 * Recursive because a key could appear at any depth, and a fixture is only
 * safe to commit if that is true of the whole tree rather than the top level.
 */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/apikey|api_key|token|secret/i.test(k)) {
        out[k] = "[SCRUBBED]";
        continue;
      }
      out[k] = scrub(v);
    }
    return out;
  }
  if (typeof value === "string" && value.includes(KEY!)) return "[SCRUBBED]";
  return value;
}

async function capture(name: string, path: string, params: Record<string, string> = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("apiKey", KEY!);

  const res = await fetch(url, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => null);

  const record = { capturedAt: new Date().toISOString(), path, status: res.status, body: scrub(body) };
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(record, null, 2) + "\n");
  console.log(`${name}.json  <-  ${path} (${res.status})`);
  return body;
}

/**
 * Keeps a few events of EACH status rather than the first N.
 *
 * The feed returns ~5000 events, which is 2.4 MB of fixture nobody will read
 * and git will carry forever. Taking the first N instead would be worse than
 * large: the list is ordered by kickoff, so it would contain one status and
 * quietly stop testing the mapping for the other three.
 */
function sampleByStatus(list: Record<string, unknown>[], perStatus = 5) {
  const seen = new Map<string, number>();
  const kept: Record<string, unknown>[] = [];
  for (const event of list) {
    const status = String(event?.status ?? "unknown").toLowerCase();
    const count = seen.get(status) ?? 0;
    if (count >= perStatus) continue;
    seen.set(status, count + 1);
    kept.push(event);
  }
  console.log(`  sampled ${kept.length} of ${list.length} events:`,
    [...seen.entries()].map(([s, n]) => `${s}=${n}`).join(" "));
  return kept;
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  await capture("sports", "/sports");
  await capture("bookmakers-selected", "/bookmakers/selected");

  const events = (await capture("events-football", "/events", { sport: "football" })) as unknown;
  const list = (Array.isArray(events) ? events : []).filter(
    (e): e is Record<string, unknown> => !!e && typeof e === "object",
  );

  // Rewrite the events fixture down to the sample.
  writeFileSync(
    join(OUT, "events-football.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        path: "/events?sport=football",
        status: 200,
        note: `sampled from ${list.length} events — a few of each status`,
        body: scrub(sampleByStatus(list)),
      },
      null,
      2,
    ) + "\n",
  );

  // Prefer a SETTLED event: it is the only kind that carries the regulation
  // score settlement depends on, so it is the one worth pinning.
  const settled =
    list.find((e: Record<string, unknown>) => String(e?.status).toLowerCase() === "settled") ?? list[0];

  if (settled?.id) {
    await capture("event-detail-settled", `/events/${settled.id}`);
  } else {
    console.warn("!! no settled event found — event-detail fixture not refreshed");
  }
}

main().catch((error: unknown) => {
  console.error("capture failed", error);
  process.exitCode = 1;
});
