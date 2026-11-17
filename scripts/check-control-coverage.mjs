/**
 * Control-coverage gate.
 *
 *   node scripts/check-control-coverage.mjs
 *
 * Compares `e2e/control-manifest.mjs` against the audit rows the Playwright run
 * actually produced, and fails when a control that must be exercised in a
 * browser has no row — or when a control that is NOT exercised in a browser
 * gives a reason this gate does not accept.
 *
 * WHY THIS IS NOT A PLAYWRIGHT TEST. It would have to run last, and Playwright
 * orders files alphabetically — so the gate's correctness would rest on a
 * filename. Running it after the suite makes the ordering explicit and lets CI
 * fail on coverage separately from failing on a broken control, which are
 * different problems with different fixes.
 *
 * WHAT CHANGED, AND WHY. The first version required a free-text `why` on every
 * non-browser row. That is exactly enough rigour to be defeated by a sentence,
 * and it was: five controls — self-exclusion, a cool-off, a password change, a
 * session revocation, a KYC upload — were classified as integration boundaries
 * whose reason amounted to "pressing this would break the rest of the run".
 * Every one of them is irreversible for the account that performs it and
 * perfectly testable on an account created three seconds earlier. That is a
 * shared-fixture problem wearing an integration boundary's coat, and prose let
 * it in.
 *
 * So the reason is now a CODE from a closed list, and this gate checks four
 * things a sentence cannot be trusted with:
 *
 *   1. every non-browser row carries a reason from `CONTROL_REASONS`;
 *   2. every non-browser row still carries prose, because the code says the
 *      CATEGORY and the prose says the specific;
 *   3. a reason that promises a named test actually names a `.spec.ts`;
 *   4. no reason, in any row, is an inconvenience dressed as an impossibility.
 *
 * WHAT IT STILL CANNOT DO. It cannot tell whether a recorded row is a GOOD
 * test. A row saying a control was clicked and did nothing useful would satisfy
 * it. It closes two specific holes — the control nobody wrote a test for, and
 * the control excused by a sentence — and `general.md` §6 remains the place
 * where the quality of each claim is argued.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROWSER_ONLY_REASONS,
  CONTROL_MANIFEST,
  CONTROL_REASONS,
  REASONS_REQUIRING_A_NAMED_TEST,
  controlsRequiringBrowserCoverage,
} from "../e2e/control-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT_DIR = path.join(ROOT, "artifacts", "ui-review");

/** Per-project audit files written by the browser suite. */
function auditFiles() {
  if (!existsSync(AUDIT_DIR)) return [];
  return readdirSync(AUDIT_DIR)
    .filter((f) => /^interaction-audit-.+\.md$/.test(f))
    .map((f) => ({
      project: f.replace(/^interaction-audit-|\.md$/g, ""),
      file: path.join(AUDIT_DIR, f),
    }));
}

/** The `control` cell of every recorded row, per project. */
function recordedControls(file) {
  const found = new Set();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // | page | viewport | control | action | observed | route | status |
    if (cells.length < 8) continue;
    if (cells[3]) found.add(cells[3]);
  }
  return found;
}

/*
 * Phrases that describe an INCONVENIENCE, not an impossibility.
 *
 * Every one of these is lifted from a reason this repository actually gave for
 * not pressing a button. They are refused outright now: if a control is
 * irreversible, the answer is an account created for that test, and there is a
 * reason code that says exactly that.
 */
const EXCUSES = [
  /would (?:end|break|ruin|destroy) (?:every|the rest|later|subsequent)/i,
  /shared demo account/i,
  /inconvenien/i,
  /would make the (?:rest|remaining) of the (?:run|suite)/i,
  /cannot be undone,? so it is not (?:pressed|tested|exercised)/i,
];

const problems = [];

// ---------------------------------------------------------------- the manifest
for (const control of CONTROL_MANIFEST) {
  const where = `${control.page} — ${control.control}`;
  const nonBrowser = control.coverage !== "browser";

  if (nonBrowser && !control.reason) {
    problems.push(`${where}: excluded from browser coverage with no reason code`);
  }
  if (control.reason && !CONTROL_REASONS.includes(control.reason)) {
    problems.push(`${where}: reason "${control.reason}" is not one this gate accepts`);
  }
  if (nonBrowser && !control.why) {
    problems.push(`${where}: has a reason code but no prose saying what it means here`);
  }
  if (
    control.reason &&
    REASONS_REQUIRING_A_NAMED_TEST.includes(control.reason) &&
    !/\.spec\.ts/.test(control.why ?? "")
  ) {
    problems.push(
      `${where}: ${control.reason} promises a test that carries the coverage, and the reason names no .spec.ts file`,
    );
  }
  if (control.reason && BROWSER_ONLY_REASONS.includes(control.reason) && nonBrowser) {
    problems.push(
      `${where}: ${control.reason} says the action WAS performed on a disposable account, but the row is not browser-covered`,
    );
  }
  for (const excuse of EXCUSES) {
    if (excuse.test(control.why ?? "")) {
      problems.push(
        `${where}: the reason reads as an inconvenience ("${excuse.source}"), not an impossibility. ` +
          `An irreversible control is tested on an account created for that test`,
      );
    }
  }
}

// ------------------------------------------------------------------ the audit
const projects = auditFiles();

if (projects.length === 0) {
  console.error(
    "control-coverage: no audit files under artifacts/ui-review/.\n" +
      "Run the browser suite first:  npx playwright test\n" +
      "Refusing to report coverage from an absent run.",
  );
  process.exit(1);
}

const required = controlsRequiringBrowserCoverage();
const gaps = [];

for (const { project, file } of projects) {
  const recorded = recordedControls(file);
  for (const control of required) {
    /*
     * Match on a prefix rather than equality. A test may legitimately record
     * "Odds tile — 1, odds 2.30", which names the price it happened to click;
     * the manifest declares "Odds tile", because the price is data and the
     * control is what is being covered.
     */
    const hit = [...recorded].some(
      (r) => r === control.control || r.startsWith(`${control.control} —`),
    );
    if (!hit) gaps.push({ project, ...control });
  }
}

const byReason = {};
for (const control of CONTROL_MANIFEST) {
  if (control.coverage === "browser") continue;
  byReason[control.reason] = (byReason[control.reason] ?? 0) + 1;
}

console.info(
  `control-coverage: ${CONTROL_MANIFEST.length} declared — ` +
    `${required.length} browser, ` +
    `${CONTROL_MANIFEST.filter((c) => c.coverage === "blocked").length} blocked, ` +
    `${CONTROL_MANIFEST.filter((c) => c.coverage === "integration-boundary").length} integration-boundary, ` +
    `${CONTROL_MANIFEST.filter((c) => c.coverage === "hidden").length} hidden\n` +
    `                  projects audited: ${projects.map((p) => p.project).join(", ")}`,
);
for (const [reason, count] of Object.entries(byReason).sort()) {
  console.info(`                  ${count} × ${reason}`);
}

if (gaps.length === 0 && problems.length === 0) {
  console.info(
    "control-coverage: every declared browser control has an audit row in every project, " +
      "and every exclusion carries an accepted reason.",
  );
  process.exit(0);
}

if (problems.length > 0) {
  console.error(`\ncontrol-coverage: ${problems.length} manifest row(s) this gate will not accept:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
}

if (gaps.length > 0) {
  console.error(`\ncontrol-coverage: ${gaps.length} control(s) declared but never exercised in a browser:\n`);
  for (const g of gaps.sort((a, b) => a.project.localeCompare(b.project) || a.page.localeCompare(b.page))) {
    console.error(`  [${g.project}] ${g.page} — ${g.control}`);
  }
  console.error(
    "\nWrite the test, or change the row to a non-browser coverage kind WITH a reason code\n" +
      "from the closed list. Deleting the row is the one edit that defeats the whole file.",
  );
}

process.exit(1);
