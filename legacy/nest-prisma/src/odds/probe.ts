/**
 * RUN THIS FIRST, before you write anything that depends on field names.
 *
 *   ODDS_API_KEY=xxx npx tsx probe.ts
 *
 * Costs ~5 requests. Dumps the real shapes so you can correct
 * `normaliseBook()` / `normaliseEvent()` in oddsApiIo.ts against reality
 * instead of against my best guess from the docs.
 */

const KEY = process.env.ODDS_API_KEY;
if (!KEY) throw new Error("set ODDS_API_KEY");

const BASE = "https://api.odds-api.io/v3";

async function hit(path: string, params: Record<string, string> = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("apiKey", KEY!);

  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  console.log(`\n${"=".repeat(70)}\n${path}  ->  ${res.status}`);
  console.log(JSON.stringify(body, null, 2).slice(0, 2500));
  return body;
}

(async () => {
  // Public, no auth, no quota cost.
  await hit("/sports");
  await hit("/bookmakers");

  // Which 2 books are on your free plan?
  await hit("/bookmakers/selected");

  const events: any = await hit("/events", { sport: "football" });

  const list = Array.isArray(events) ? events : (events?.data ?? []);
  const first = list[0];

  if (first) {
    const id = String(first.id ?? first.eventId);
    console.log(`\n>>> probing odds for event ${id}`);
    await hit("/odds", { eventId: id });
  } else {
    console.log("\n!! no events returned — check the sport slug");
  }

  console.log(`
${"=".repeat(70)}
CHECKLIST — confirm these against the output above:
  [ ] event id field:        id | eventId | ?
  [ ] kickoff field:         startTime | commenceTime | date | ?
  [ ] markets: object keyed by name, or array?
  [ ] odds price field:      odds | price | ?
  [ ] decimal or american?   (>1.01 and fractional => decimal)
  [ ] suspended selections:  omitted, or price 0/null?
  [ ] your 2 free bookmakers: __________ , __________
`);
})();
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
