/**
 * Load and reliability measurement for the read paths.
 *
 *   node scripts/review-server.mjs                 # in another terminal
 *   node scripts/bench-http.mjs
 *   node scripts/bench-http.mjs --requests=600 --concurrency=40
 *   node scripts/bench-http.mjs --only=live
 *
 * Covers what `docs/who-does-what.md` D8 lists as untested: the board, the
 * live-feed poll at scale, and Pluto concurrency. Bet placement under
 * contention already has its own tests, and is not repeated here.
 *
 * IT ONLY EVER RUNS AGAINST THIS MACHINE. The base URL and the stats connection
 * are both checked for a loopback host and the run aborts otherwise. Load
 * testing something because a flag pointed at it is how a benchmark becomes an
 * outage.
 *
 * THE RATE LIMITER IS NOT DISABLED, AND MUST NOT BE
 * -------------------------------------------------
 * Every budget in `RATE_RULES` is keyed by client address, so firing 500
 * requests from one machine measures the rate limiter rather than the
 * application — the first 120 answer and the rest are refused, which is the
 * limiter working correctly and tells you nothing about capacity.
 *
 * So each simulated customer sends its own `x-forwarded-for`, which is what the
 * limiter keys on and what a real crowd behind a proxy looks like. The control
 * still runs on every request; it simply sees many clients instead of one. That
 * is simulation, not a bypass — and the `abuse` scenario below then points a
 * SINGLE client past its budget and asserts the limiter still fires, so the
 * thing being relied on here is itself measured.
 *
 * WHAT IS REPORTED, AND WHICH NUMBER TO TRUST
 * -------------------------------------------
 * Latency percentiles are hardware- and weather-dependent: they describe this
 * laptop under whatever else it was doing. Treat them as an order of magnitude.
 *
 * The number that survives a change of machine is the DATABASE COST PER
 * REQUEST — transactions and rows read, taken from `pg_stat_database` deltas
 * across the run. A page that goes from 3 queries to 30 shows up there whatever
 * the hardware does, and that is the regression worth catching.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const num = (name, fallback) => Number(arg(name, String(fallback)));

const BASE = arg("base", "http://127.0.0.1:3100").replace(/\/$/, "");
const REQUESTS = num("requests", 400);
const CONCURRENCY = num("concurrency", 25);
const ONLY = arg("only", null);
const STATS_URL = arg("db", "postgresql://bet_app:bet_app_dev@127.0.0.1:5432/bet");

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function assertLocal(label, url) {
  const host = new URL(url).hostname;
  if (!LOOPBACK.has(host)) {
    throw new Error(
      `${label} points at "${host}", which is not this machine.\n` +
        "This script generates sustained load. It runs against a disposable local\n" +
        "database only. Refusing to start.",
    );
  }
}

// ------------------------------------------------------------------ scenarios

/**
 * `budget` is the rate rule the route is filed under, recorded so a reader can
 * see which limit each scenario is living inside rather than inferring it.
 */
const SCENARIOS = [
  { key: "board", label: "The board", method: "GET", path: "/", budget: "browse" },
  { key: "sports", label: "Market list", method: "GET", path: "/sports", budget: "browse" },
  { key: "live", label: "Live feed poll", method: "GET", path: "/api/live", budget: "browse" },
  { key: "odds", label: "Odds", method: "GET", path: "/api/odds", budget: "browse" },
  {
    key: "pluto",
    label: "Pluto (rules-based)",
    method: "POST",
    path: "/api/ai",
    budget: "ai",
    // Routes to `findFixtures`, so it exercises a database read rather than
    // the canned fallback sentence.
    body: { messages: [{ role: "user", content: "show me matches today" }] },
    // The `ai` budget is 30/min, so a simulated customer may send only so many
    // before being refused. One request each keeps the measurement about the
    // handler rather than the limiter.
    perClient: 1,
  },
  { key: "health", label: "Health", method: "GET", path: "/api/health", budget: "none" },
];

// -------------------------------------------------------------------- driving

function once({ method, url, body, forwardedFor }) {
  const target = new URL(url);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));

  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        headers: {
          // Each simulated customer is its own client to the rate limiter. See
          // the header note above for why this is simulation and not a bypass.
          "x-forwarded-for": forwardedFor,
          accept: "*/*",
          ...(payload
            ? { "content-type": "application/json", "content-length": String(payload.length) }
            : {}),
        },
      },
      (res) => {
        // Drained, not ignored: an unread response body leaves the socket open
        // and the run measures connection exhaustion instead of the route.
        res.resume();
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            ms: Number(process.hrtime.bigint() - started) / 1e6,
          }),
        );
      },
    );
    req.on("error", () => resolve({ status: 0, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Runs `total` requests, never more than `concurrency` in flight. */
async function drive(scenario, total, concurrency, clientFor) {
  const results = [];
  let issued = 0;

  const worker = async () => {
    for (;;) {
      const index = issued++;
      if (index >= total) return;
      results.push(
        await once({
          method: scenario.method,
          url: BASE + scenario.path,
          body: scenario.body,
          forwardedFor: clientFor(index),
        }),
      );
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ------------------------------------------------------------------ reporting

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  // Nearest-rank. With a few hundred samples the interpolating definitions
  // differ by less than the noise, and this one is unambiguous.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

function summarise(results, wallMs) {
  const ok = results.filter((r) => r.status >= 200 && r.status < 400);
  const latencies = ok.map((r) => r.ms).sort((a, b) => a - b);
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  return {
    requests: results.length,
    ok: ok.length,
    rateLimited: results.filter((r) => r.status === 429).length,
    failed: results.filter((r) => r.status === 0 || r.status >= 500).length,
    byStatus,
    rps: results.length / (wallMs / 1000),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.at(-1) ?? 0,
  };
}

// ------------------------------------------------------------- database cost

async function dbCounters(sql) {
  const [row] = await sql`
    SELECT xact_commit, xact_rollback, tup_returned, tup_fetched
    FROM pg_stat_database WHERE datname = current_database()
  `;
  return {
    transactions: Number(row.xact_commit) + Number(row.xact_rollback),
    rowsRead: Number(row.tup_fetched),
  };
}

// -------------------------------------------------------------------- the run

async function main() {
  assertLocal("--base", BASE);
  assertLocal("--db", STATS_URL);

  const scenarios = ONLY ? SCENARIOS.filter((s) => s.key === ONLY) : SCENARIOS;
  if (scenarios.length === 0) throw new Error(`no scenario called "${ONLY}"`);

  const sql = postgres(STATS_URL, { max: 1, prepare: false, onnotice: () => {} });
  const rows = [];

  try {
    for (const scenario of scenarios) {
      // Warm up first and discard it. The first request to a route in a fresh
      // Next.js process pays for module loading and a cold connection pool, and
      // folding that into p99 reports a number no customer ever experiences.
      await drive(scenario, Math.min(concurrencyFor(scenario), 10), 5, () => "10.0.0.1");

      /*
       * A single-customer baseline before the loaded run.
       *
       * Without it the loaded p50 is unreadable. The board measured ~480ms at
       * concurrency 25 and 27ms alone — the page is not slow, twenty-five
       * concurrent renders are queueing on one Node process. Reporting only
       * the first number would have started an optimisation of something that
       * is not the problem.
       */
      const soloResults = await drive(scenario, 30, 1, () => randomClient());
      const solo = summarise(soloResults, 1);

      const before = await dbCounters(sql);
      const startedAt = process.hrtime.bigint();

      const clientFor = scenario.perClient
        ? (index) => `10.1.${Math.floor(index / 250) % 256}.${index % 250}`
        : (index) => `10.2.${Math.floor(index / 250) % 256}.${index % 250}`;

      const results = await drive(scenario, REQUESTS, concurrencyFor(scenario), clientFor);
      const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const after = await dbCounters(sql);

      const summary = summarise(results, wallMs);
      summary.txnPerRequest = (after.transactions - before.transactions) / results.length;
      summary.rowsPerRequest = (after.rowsRead - before.rowsRead) / results.length;
      summary.soloP50 = solo.p50;
      summary.soloP95 = solo.p95;
      rows.push({ scenario, summary });

      console.info(
        `${scenario.label.padEnd(22)} ` +
          `alone ${summary.soloP50.toFixed(0).padStart(4)}ms  ` +
          `p50 ${summary.p50.toFixed(0).padStart(5)}ms  ` +
          `p95 ${summary.p95.toFixed(0).padStart(5)}ms  ` +
          `p99 ${summary.p99.toFixed(0).padStart(5)}ms  ` +
          `${summary.rps.toFixed(1).padStart(6)} rps  ` +
          `txn/req ${summary.txnPerRequest.toFixed(1).padStart(5)}  ` +
          `429 ${String(summary.rateLimited).padStart(4)}  ` +
          `fail ${summary.failed}`,
      );
    }

    // The limiter is the thing every measurement above depends on, so it is
    // measured too rather than assumed.
    const abuse = await abuseCheck();
    console.info(
      `\nOne client past its budget: ${abuse.ok} answered, ${abuse.refused} refused with 429, ` +
        `${abuse.failed} failed`,
    );

    writeReport(rows, abuse);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** A fresh client address, so no run inherits another's spent rate budget. */
function randomClient() {
  return `10.${50 + Math.floor(Math.random() * 40)}.${Math.floor(Math.random() * 256)}.${
    Math.floor(Math.random() * 254) + 1
  }`;
}

function concurrencyFor(scenario) {
  // Pluto is deliberately driven no harder than its own budget allows.
  return scenario.key === "pluto" ? Math.min(CONCURRENCY, 10) : CONCURRENCY;
}

/**
 * Fires one client past `browse` (120/min) and reports what came back.
 *
 * The client address is randomised PER RUN. A fixed one carried its spent
 * budget between runs, so a second run inside the same minute reported "0
 * answered, 200 refused" — which looks like a stricter limiter and is really
 * just the first run's leftovers. A measurement that changes meaning depending
 * on when it was last taken is not one.
 */
async function abuseCheck() {
  const client = `10.99.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`;
  const results = await drive(
    { method: "GET", path: "/api/live" },
    200,
    20,
    () => client,
  );
  return {
    ok: results.filter((r) => r.status >= 200 && r.status < 400).length,
    refused: results.filter((r) => r.status === 429).length,
    failed: results.filter((r) => r.status === 0 || r.status >= 500).length,
  };
}

function writeReport(rows, abuse) {
  const dir = path.join(ROOT, "artifacts", "load");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const lines = [
    "# HTTP load measurement",
    "",
    `Generated by \`scripts/bench-http.mjs\` on ${new Date().toISOString()}.`,
    `${REQUESTS} requests per scenario at concurrency ${CONCURRENCY}, against a review`,
    "server on a **disposable local database**. Never production.",
    "",
    "Latency is hardware- and weather-dependent — read it as an order of magnitude.",
    "**Transactions and rows per request** are the machine-independent figures: they",
    "do not move when the hardware does, so a route that starts doing ten times the",
    "database work shows up there whatever laptop it is run on.",
    "",
    "The rate limiter was **not** disabled. Each simulated customer sends its own",
    "`x-forwarded-for`, which is what the limiter keys on and what a crowd behind a",
    "proxy looks like; the control ran on every request below.",
    "",
    `Each scenario is measured twice: **alone** (one customer at a time, 30`,
    `requests) and **under load** (${REQUESTS} requests at concurrency ${CONCURRENCY}).`,
    "The gap between them is queueing on a single Node process, not page cost.",
    "",
    "| Scenario | Route | Budget | alone p50 | p50 | p95 | p99 | max | rps | txn/req | rows/req | 429 | failed |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(({ scenario, summary }) =>
      `| ${scenario.label} | \`${scenario.method} ${scenario.path}\` | \`${scenario.budget}\` | ` +
      `${summary.soloP50.toFixed(0)}ms | ` +
      `${summary.p50.toFixed(0)}ms | ${summary.p95.toFixed(0)}ms | ${summary.p99.toFixed(0)}ms | ` +
      `${summary.max.toFixed(0)}ms | ${summary.rps.toFixed(1)} | ${summary.txnPerRequest.toFixed(1)} | ` +
      `${summary.rowsPerRequest.toFixed(0)} | ${summary.rateLimited} | ${summary.failed} |`,
    ),
    "",
    "## The rate limiter, measured rather than assumed",
    "",
    `A single client sent 200 requests to \`/api/live\`, whose budget is 120 a minute.`,
    `**${abuse.ok} were answered and ${abuse.refused} were refused with 429**, with`,
    `${abuse.failed} failures. A limiter that sheds load by refusing is working; one`,
    "that sheds it by falling over is not, and this distinguishes them.",
    "",
    "## Not measured, and why",
    "",
    "- **Casino callbacks.** There is no callback route to load. The casino is a",
    "  sandbox adapter with no aggregator connected, so there is nothing here to",
    "  measure and a number would be an invention.",
    "- **Bet placement under contention.** Already covered by its own tests, which",
    "  assert correctness under concurrency rather than throughput.",
    "- **A live model.** Pluto runs the keyword router. The figure above is the",
    "  route, the guardrails and the tool dispatch — not model latency, which does",
    "  not exist yet and will dominate when it does.",
    "",
  ];

  const file = path.join(dir, "HTTP_LOAD.md");
  writeFileSync(file, lines.join("\n"), "utf8");
  console.info(`\nwrote ${path.relative(ROOT, file)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
