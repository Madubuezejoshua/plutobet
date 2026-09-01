/**
 * Turns a Vitest JSON report into an explicit statement about coverage drift.
 *
 *   node scripts/ci-test-report.mjs test-results.json
 *
 * WHY THIS EXISTS
 * ---------------
 * "All tests passed" is compatible with a suite that has quietly stopped
 * testing things. A skipped test and a deleted test are the same amount of
 * protection, but only one of them is visible in the summary line, and a `todo`
 * is a note-to-self that reads as a pass forever.
 *
 * So this prints the totals, names every skipped and todo test, and FAILS the
 * build on a todo that is not listed in `.ci-allowed-todos.txt` with a reason.
 * The list is the mechanism: adding a todo becomes a deliberate, reviewable act
 * rather than something that slips through in a large diff.
 *
 * Skips are reported but do not fail: the one skipped test here is the opt-in
 * live provider contract, which MUST NOT run without credentials, and running
 * it in CI would spend a real API quota against a third party.
 *
 * Exit codes: 0 acceptable, 1 unapproved todo or a failed test, 2 the reporter
 * itself failed (a missing report is a failure, not a pass).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_TODOS = path.join(ROOT, ".ci-allowed-todos.txt");

function approvedTodos() {
  if (!existsSync(ALLOWED_TODOS)) return new Map();
  const entries = new Map();
  for (const line of readFileSync(ALLOWED_TODOS, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // "full test name :: reason"
    const separator = trimmed.indexOf("::");
    if (separator === -1) continue;
    entries.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 2).trim());
  }
  return entries;
}

function main() {
  const reportPath = process.argv[2] ?? "test-results.json";
  if (!existsSync(reportPath)) {
    console.error(`ci-test-report: ${reportPath} not found — the suite did not produce a report.`);
    console.error("Treating a missing report as a failure: an absent result is not a pass.");
    return 2;
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const assertions = (report.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? []).map((test) => ({
      name: test.fullName || test.title,
      status: test.status,
      file: file.name,
    })),
  );

  const passed = assertions.filter((t) => t.status === "passed");
  const failed = assertions.filter((t) => t.status === "failed");
  const skipped = assertions.filter((t) => t.status === "skipped" || t.status === "pending");
  const todo = assertions.filter((t) => t.status === "todo");

  console.log("");
  console.log("TEST TOTALS");
  console.log(`  files    ${(report.testResults ?? []).length}`);
  console.log(`  passed   ${passed.length}`);
  console.log(`  failed   ${failed.length}`);
  console.log(`  skipped  ${skipped.length}   (reported, NOT counted as passing)`);
  console.log(`  todo     ${todo.length}`);
  console.log("");

  if (skipped.length > 0) {
    console.log("SKIPPED — each one is protection the suite is not currently providing:");
    for (const test of skipped) console.log(`  - ${test.name}`);
    console.log("");
  }

  if (failed.length > 0) {
    console.error("FAILED:");
    for (const test of failed) console.error(`  - ${test.name}`);
    return 1;
  }

  if (todo.length > 0) {
    const approved = approvedTodos();
    const unapproved = todo.filter((test) => !approved.has(test.name));
    console.log("TODO:");
    for (const test of todo) {
      const reason = approved.get(test.name);
      console.log(`  - ${test.name}${reason ? `  [approved: ${reason}]` : "  [UNAPPROVED]"}`);
    }
    console.log("");
    if (unapproved.length > 0) {
      console.error(
        `ci-test-report: ${unapproved.length} todo test(s) with no approved reason.`,
      );
      console.error(
        "Add each to .ci-allowed-todos.txt as `full test name :: why it is a todo`,",
      );
      console.error("or write the test. A todo reads as a pass and protects nothing.");
      return 1;
    }
  }

  console.log("ci-test-report: acceptable");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error("ci-test-report: failed:", error instanceof Error ? error.message : error);
  process.exit(2);
}
