/**
 * Documentation consistency checks.
 *
 *   node scripts/check-docs.mjs
 *
 * WHY THIS EXISTS. `general.md` is the single source of truth for a money
 * system, and it went wrong in the only way a long status document ever goes
 * wrong: not by lying, but by being edited in one place and not another. A pass
 * repaired cash-out and updated §15, and §23 went on listing the same defect as
 * outstanding. A migration was added and §19 kept the old count. The header said
 * the branch was unmerged while §0 said it was merged. Every one of those was
 * true when written.
 *
 * A human proof-reading 2,000 lines catches some of that. A machine catches the
 * same class every time, which is the difference between a convention and a
 * control.
 *
 * WHAT IT DOES NOT DO. It cannot tell whether a claim is TRUE — only whether the
 * document contradicts itself or the repository. "989 tests pass" is outside its
 * reach; "29 migrations here and 27 there" is not. Evidence is still the
 * author's job.
 *
 * Exit 0 clean, 1 with findings. Every finding names the file, the line and what
 * to compare it against, because a checker that only says "inconsistent" makes
 * somebody re-derive the search that found it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The authoritative status vocabulary, from general.md §2. */
const STATUS_LABELS = new Set([
  "VERIFIED_IN_REAL_BROWSER",
  "VERIFIED_END_TO_END",
  "VERIFIED_AGAINST_REAL_PROVIDER_DATA",
  "VERIFIED_BY_INTEGRATION_TEST",
  "VERIFIED_BY_UNIT_TEST_ONLY",
  "IMPLEMENTED_NOT_LIVE_TESTED",
  "BLOCKED_BY_KEY",
  "BLOCKED_BY_CONTRACT",
  "BLOCKED_BY_OWNER_CONFIGURATION",
  "BLOCKED_BY_PRODUCT_DECISION",
  "BLOCKED_BY_REGULATION",
  "NOT_IMPLEMENTED",
  "FAILED",
  // Outcome words, not statuses of a feature. Allowed because they describe the
  // whole pass rather than a row.
  "DEVELOPER_OWNED_SPORTSBOOK_MVP_COMPLETE",
  "INTERNAL_SECURITY_VERIFICATION",
  // Named in prose as things this pass must NOT claim. Listing them here keeps
  // the checker from flagging the sentence that forbids them.
  "REAL_MONEY_READY",
  "PRODUCTION_READY",
  "LICENSED",
  "PAYMENTS_VERIFIED",
  "ALL_PRODUCTS_COMPLETE",
  "DEMO_READY",
]);

/**
 * Files this repository has deleted on purpose.
 *
 * A document may still DISCUSS them — the trail from a defect to its fix is
 * worth reading — but it must not describe them as present. The rule is that a
 * mention must sit near a word that marks it as gone.
 */
const DELETED_FILES = [
  { path: "src/styles/legacy-bridge.css", goneWords: /delet|remov|gone|retire|no longer|used to|gitignor/i },
  { path: "src/app/(site)/sports/bet-slip.tsx", goneWords: /delet|remov|gone|retire|no longer|replac|used to/i },
  { path: "src/components/layout/site-shell.tsx", goneWords: /delet|remov|gone|retire|no longer|replac|used to/i },
];

const findings = [];

function report(file, line, rule, message) {
  findings.push({ file, line, rule, message });
}

function readLines(rel) {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf8").split(/\r?\n/);
}

/** Markdown files this checker governs. */
function docFiles() {
  const top = readdirSync(ROOT).filter((f) => f.endsWith(".md"));
  const docs = existsSync(path.join(ROOT, "docs"))
    ? readdirSync(path.join(ROOT, "docs"))
        .filter((f) => f.endsWith(".md"))
        .map((f) => `docs/${f}`)
    : [];
  // `docs/history/` is deliberately excluded: it is a record of what was true on
  // a past date, and holding it to today's state would force somebody to edit
  // evidence.
  return [...top, ...docs];
}

/**
 * Dated logs, which record what was true when they were written.
 *
 * They are exempt from the CURRENT-STATE rules — a pass that correctly reported
 * 24 migrations in August is not wrong today, and "correcting" it would falsify
 * the record. They are NOT exempt from the rules about what a document may
 * claim about itself: a log may not declare itself the source of truth, and it
 * may not leave a placeholder.
 */
const HISTORICAL_DOCS = new Set(["NEXT_WORK_REPORT.md"]);

/** Documents that describe the state of the project right now. */
function currentStateDocs() {
  return docFiles().filter((f) => !HISTORICAL_DOCS.has(f));
}

// ---------------------------------------------------------------- 1. migrations

/**
 * Every stated migration total must match the journal.
 *
 * The real count is read from `drizzle/meta/_journal.json`, not from another
 * document, because two documents agreeing with each other and both being wrong
 * is the failure this is here to catch.
 */
function checkMigrationTotals() {
  const journalPath = path.join(ROOT, "drizzle", "meta", "_journal.json");
  if (!existsSync(journalPath)) return;
  const actual = JSON.parse(readFileSync(journalPath, "utf8")).entries.length;

  const patterns = [
    /(\d+)\s+migrations?\b/gi,
    /\b(\d+)\s+of\s+\1\b/gi, // "29 of 29"
    /Migrations\s*\|\s*(\d+)/gi,
  ];

  for (const rel of currentStateDocs()) {
    const lines = readLines(rel);
    if (!lines) continue;
    lines.forEach((text, i) => {
      /*
       * Only judge a line that is ABOUT migrations. "18 of 18 admin queries"
       * matches the N-of-N shape and has nothing to do with the schema; an
       * earlier version of this check reported three such lines and would have
       * taught everyone to skim past the output.
       */
      if (!/migration/i.test(text)) return;
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(text)) !== null) {
          const stated = Number(m[1]);
          /*
           * The N-of-N shape must sit NEXT TO the word it is a count of. One
           * line reads "migrations 29 of 29 … admin smoke 18 of 18", and
           * without this the 18 was reported as a wrong migration total.
           */
          const near = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
          if (!/migration/i.test(near)) continue;
          // Only judge numbers in the plausible range for this project's
          // migration count. "3 migrations ago" style prose is not a total.
          if (stated >= 10 && stated <= 200 && stated !== actual) {
            report(
              rel,
              i + 1,
              "migration-total",
              `states ${stated} migrations; drizzle/meta/_journal.json has ${actual}`,
            );
          }
        }
      }
    });
  }
}

// ------------------------------------------------------- 2. readiness blockers

/**
 * All statements of a readiness blocker count must agree with each other.
 *
 * The true number comes from running the script, which this checker does not do
 * — so it enforces INTERNAL consistency. Two sections disagreeing is always a
 * defect regardless of which one is right.
 */
function checkReadinessBlockerTotals() {
  const seen = { demo: [], real: [] };

  for (const rel of currentStateDocs()) {
    const lines = readLines(rel);
    if (!lines) continue;
    lines.forEach((text, i) => {
      const blocker = /(\d+)\s+blocker/i.exec(text);
      if (!blocker) return;
      const count = Number(blocker[1]);
      const isReal = /real[-\s]?money|REAL_MONEY_READY/i.test(text);
      const isDemo = /demo|DEMO_READY/i.test(text);
      if (isReal) seen.real.push({ rel, line: i + 1, count });
      else if (isDemo) seen.demo.push({ rel, line: i + 1, count });
    });
  }

  for (const [name, entries] of Object.entries(seen)) {
    const counts = [...new Set(entries.map((e) => e.count))];
    if (counts.length > 1) {
      for (const e of entries) {
        report(
          e.rel,
          e.line,
          "readiness-blockers",
          `${name} blocker count ${e.count} disagrees with other statements (${counts.join(", ")})`,
        );
      }
    }
  }
}

// ------------------------------------------- 3. done AND in the active backlog

/**
 * Nothing may be marked finished and also sit in the active developer backlog.
 *
 * The backlog table is the one titled "Blocked by nothing". Its whole meaning is
 * "a developer could start this today", so an entry that is already done makes
 * the section describe work that does not exist.
 */
function checkBacklogVersusDone() {
  const rel = "general.md";
  const lines = readLines(rel);
  if (!lines) return;

  // The backlog section runs from its heading to the next heading.
  let start = -1;
  let end = lines.length;
  lines.forEach((text, i) => {
    if (start === -1 && /Blocked by nothing/i.test(text)) start = i;
    else if (start !== -1 && i > start && /^#{2,4}\s/.test(text) && end === lines.length) end = i;
  });
  if (start === -1) return;

  /*
   * A section that declares itself empty may still LIST what used to be in it,
   * next to where each item's evidence now lives. That table is a record of
   * completion, not a backlog, so scanning stops where it begins — otherwise
   * this rule reports every row of the very table that resolves it.
   */
  for (let i = start; i < end; i += 1) {
    if (/Was listed here|Where its evidence/i.test(lines[i])) {
      end = i;
      break;
    }
  }

  /*
   * Each entry is a subject and the evidence that it is finished. Matching on a
   * phrase rather than a fuzzy similarity keeps this readable and keeps a false
   * positive from teaching people to ignore the checker.
   */
  const finishedSubjects = [
    { in: /cash-?out exposure defect/i, why: "§15 records cash-out repaired, reachable and tested" },
    { in: /account-status gate on cash-?out/i, why: "§15 records assertMayCashOut gating on status" },
    { in: /bank list for withdrawals/i, why: "§0 stage 5f records the route, picker and 12 tests" },
    { in: /date-of-birth backfill/i, why: "§0 stage 5d records the flow, banner and gates" },
    { in: /redis caching of .?liveVersion/i, why: "§0 stage 5e records the cache and its tests" },
    { in: /load tests? for the homepage/i, why: "§0 stage 6 records the measured load run" },
    { in: /prompt-?injection corpus/i, why: "§0 stage 5i records 53 attacks and 59 tests" },
    { in: /retire the legacy bridge/i, why: "the file is deleted from the repository" },
  ];

  for (let i = start; i < end; i += 1) {
    for (const subject of finishedSubjects) {
      if (subject.in.test(lines[i])) {
        report(
          rel,
          i + 1,
          "done-in-backlog",
          `listed in the active developer backlog but finished — ${subject.why}`,
        );
      }
    }
  }
}

// ------------------------------------------ 4. deleted files described as live

function checkDeletedFilesNotDescribedAsPresent() {
  for (const rel of currentStateDocs()) {
    const lines = readLines(rel);
    if (!lines) continue;
    lines.forEach((text, i) => {
      for (const deleted of DELETED_FILES) {
        if (!text.includes(deleted.path) && !text.includes(path.basename(deleted.path))) continue;
        if (existsSync(path.join(ROOT, deleted.path))) continue; // not deleted after all
        /*
         * Search the whole SECTION, not a fixed window.
         *
         * A deletion is announced in a banner under the heading, and the
         * paragraph explaining what the file used to do can sit well below it.
         * Two fixed windows were tried — one line, then five — and each was one
         * paragraph too short for the next document. A section is the unit a
         * human reads, so it is the unit this reads too.
         */
        let from = 0;
        for (let k = i; k >= 0; k -= 1) {
          if (/^#{1,6}\s/.test(lines[k])) {
            from = k;
            break;
          }
        }
        let to = lines.length;
        for (let k = i + 1; k < lines.length; k += 1) {
          if (/^#{1,6}\s/.test(lines[k])) {
            to = k;
            break;
          }
        }
        const context = lines.slice(from, to).join(" ");
        if (!deleted.goneWords.test(context)) {
          report(
            rel,
            i + 1,
            "deleted-file-live",
            `${deleted.path} no longer exists, and nothing nearby says so`,
          );
        }
      }
    });
  }
}

// ------------------------------------------------ 5. one source of truth only

function checkSingleSourceOfTruth() {
  const claim = /single source of truth/i;
  for (const rel of docFiles()) {
    const lines = readLines(rel);
    if (!lines) continue;
    lines.forEach((text, i) => {
      if (!claim.test(text)) return;
      if (rel === "general.md") return; // the one document allowed to claim it
      // Other documents may POINT at general.md; they may not claim it.
      if (/general\.md/i.test(text)) return;
      report(
        rel,
        i + 1,
        "source-of-truth",
        "claims to be the single source of truth; only general.md may, and others must point at it",
      );
    });
  }
}

// ------------------------------------------------------ 6. status label check

function checkStatusLabels() {
  // Screaming-snake tokens of 2+ words, which is the shape every status uses.
  const token = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,6})\b/g;
  /*
   * Ordinary uppercase identifiers that are not statuses. Without this the
   * checker would flag every environment variable and SQL keyword in the
   * document, and a checker with fifty false positives is one nobody runs.
   */
  const notAStatus =
    /^(DATABASE_URL|DIRECT_DATABASE_URL|MIGRATION_DATABASE_URL|POSTGRES_URL|POSTGRES_URL_NON_POOLING|DATABASE_URL_UNPOOLED|REDIS_URL|KV_URL|KV_REST_API_URL|KV_REST_API_TOKEN|AUTH_SECRET|NEXTAUTH_URL|NEXTAUTH_SECRET|AUTH_URL|IDENTITY_PEPPER|ODDS_API_KEY|ODDS_LIVE_CONTRACT|PAYSTACK_SECRET_KEY|PAYSTACK_PUBLIC_KEY|TERMII_API_KEY|TERMII_SENDER_ID|RESEND_API_KEY|RESEND_FROM|SENTRY_DSN|SENTRY_AUTH_TOKEN|NEXT_PUBLIC_SENTRY_DSN|B2_[A-Z_]+|INNGEST_[A-Z_]+|UPSTASH_[A-Z_]+|SEED_ADMIN_[A-Z_]+|APP_DATABASE_ROLE|WALLET_LOCK_TIMEOUT|DATABASE_POOL_MAX|DIRECT_DATABASE_POOL_MAX|ALLOW_QA_CREDIT|NODE_ENV|NEXT_RUNTIME|VERCEL_ENV|RAILWAY_[A-Z_]+|CI|GITHUB_TOKEN|GH_TOKEN|GIT_TOKEN|PLUTOBET_ENVIRONMENT|PLAYWRIGHT_BASE_URL|ASSUMED_FINISHED_AFTER_MS|SET_NULL|NOT_NULL|SET_LOCAL|SKIP_LOCKED|FOR_UPDATE|SUPER_ADMIN|SUPPORT_AGENT|SELF_EXCLUDED|CASHED_OUT|USER_ID|LC_[A-Z]+|STATUS_DLL_NOT_FOUND|HTTP_LOAD|INTERACTION_AUDIT|PROJECT_STATUS|PLUTOBET_STATUS|PLUTOBET_CORE_FLOW_VALIDATION|DEVELOPER_COMPLETION_REPORT|NEXT_WORK_REPORT|OWNER_LAUNCH_CHECKLIST|UI_REDESIGN_REPORT|README|AGENTS|CLAUDE|MVP_COMPLETE)$/;

  for (const rel of currentStateDocs()) {
    const lines = readLines(rel);
    if (!lines) continue;

    /*
     * The section of general.md that RETIRES labels has to name them, and it
     * says so itself. Its range is found rather than hard-coded to a line
     * number, because a line number in a checker goes stale the first time
     * somebody adds a paragraph above it.
     */
    let exemptFrom = -1;
    let exemptTo = -1;
    lines.forEach((text, i) => {
      if (exemptFrom === -1 && /why it is a downgrade/i.test(text)) exemptFrom = i;
      else if (exemptFrom !== -1 && exemptTo === -1 && i > exemptFrom && /^#{2,4}\s/.test(text)) exemptTo = i;
    });
    if (exemptFrom !== -1 && exemptTo === -1) exemptTo = lines.length;

    lines.forEach((text, i) => {
      if (exemptFrom !== -1 && i >= exemptFrom && i < exemptTo) return;
      token.lastIndex = 0;
      let m;
      while ((m = token.exec(text)) !== null) {
        const word = m[1];
        if (STATUS_LABELS.has(word)) continue;
        if (notAStatus.test(word)) continue;
        // Only judge tokens that LOOK like a status verb, so unrelated
        // constants do not drag the checker into guesswork.
        if (!/^(VERIFIED|BLOCKED|IMPLEMENTED|NOT|FAILED|DEVELOPER|REAL|PRODUCTION|ALL)_/.test(word)) continue;
        report(rel, i + 1, "status-label", `"${word}" is not in the general.md §2 vocabulary`);
      }
    });
  }
}

// ------------------------------------------------------- 7. placeholders left

function checkPlaceholders() {
  const placeholder = /\bTBD\b|\bTODO\b|\bFIXME\b|\bXXX\b|\bLorem ipsum\b|\{\{[^}]+\}\}|<PLACEHOLDER|\bFILL[ _-]?ME\b/i;
  for (const rel of docFiles()) {
    const lines = readLines(rel);
    if (!lines) continue;
    lines.forEach((text, i) => {
      /*
       * The audit sections legitimately quote the marker words they search for,
       * and `test.todo` is a Vitest API rather than an unfinished sentence.
       */
      if (/`TODO`|`FIXME`|`HACK`|`XXX`|grep|search(ed)? (the repository|for)|marker/i.test(text)) return;
      if (/\.todo\b|test\.todo|describe\.todo|`\.only`/i.test(text)) return;
      // "0 todo" and "Todo tests | 0" are TEST COUNTS, not unfinished writing.
      if (/\d+\s*todo\b|todo tests?\s*\|/i.test(text)) return;
      if (placeholder.test(text)) {
        report(rel, i + 1, "placeholder", "unresolved placeholder or marker left in a document");
      }
    });
  }
}

// ------------------------------------------------------- 8. the branch it is about

/** git, or null when git cannot answer — CI tarballs and shallow checkouts. */
function git(...args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * The branch the document says it describes must be the branch that is checked
 * out.
 *
 * THE FAILURE THIS CATCHES, EXACTLY. The header read "Branch described:
 * `main`" for an entire pass whose work lived on a feature branch. Every
 * number under it was measured on the feature branch, so a reader following the
 * header would have gone to `main` and found none of it. Nothing in the
 * document contradicted itself; it contradicted the repository, which is the
 * one thing a status file is not allowed to do.
 */
function checkBranchDescribed() {
  const actual = git("rev-parse", "--abbrev-ref", "HEAD");
  if (!actual || actual === "HEAD") return; // detached or no git: nothing to compare

  for (const rel of currentStateDocs()) {
    const lines = readLines(rel);
    if (!lines) continue;
    lines.forEach((text, i) => {
      // The header writes it as "**Branch described:** `name`", so the bold
      // markers sit between the colon and the value.
      const stated = /Branch described:\**\s*`([^`]+)`/i.exec(text);
      if (!stated) return;
      if (stated[1] !== actual) {
        report(
          rel,
          i + 1,
          "branch-described",
          `says it describes "${stated[1]}"; the checked-out branch is "${actual}"`,
        );
      }
    });
  }
}

/**
 * A stated count of commits on this branch must match git.
 *
 * Counted from `main`, which is where the branch was cut, so the number is
 * deterministic and needs no network. A document that says "four commits" after
 * a fifth has landed is the same class of staleness as a wrong migration total,
 * and it is the one a reader uses to decide what still has to be published.
 */
function checkBranchCommitCount() {
  const actual = git("rev-list", "--count", "main..HEAD");
  if (actual === null || actual === "") return;
  const count = Number(actual);
  if (!Number.isFinite(count)) return;

  for (const rel of currentStateDocs()) {
    const lines = readLines(rel);
    if (!lines) continue;
    lines.forEach((text, i) => {
      if (!/commits? on this branch/i.test(text)) return;
      const stated = /(\d+)\s+commits? on this branch|Commits on this branch\s*\|\s*\*{0,2}(\d+)/i.exec(text);
      if (!stated) return;
      const value = Number(stated[1] ?? stated[2]);
      if (Number.isFinite(value) && value !== count) {
        report(
          rel,
          i + 1,
          "branch-commit-count",
          `states ${value} commits on this branch; git rev-list main..HEAD counts ${count}`,
        );
      }
    });
  }
}

// ----------------------------------------------------- 9. browser-suite totals

/**
 * Every stated browser-suite total must match the run that produced the report,
 * and the statements must match each other.
 *
 * THE FAILURE THIS CATCHES. Sections 3, 4, 5 and 26 all quoted "139 passed"
 * long after the suite had grown past 270, and one sentence still described it
 * "growing from 118 to 152". Each was true on the day it was written and none
 * was true together. A reader cannot tell which of four numbers is current, and
 * the honest answer — read it from the run — is what this does.
 */
function browserRunTotals() {
  const file = path.join(ROOT, "artifacts", "playwright-report.json");
  if (!existsSync(file)) return null;
  try {
    const stats = JSON.parse(readFileSync(file, "utf8")).stats ?? {};
    const passed = Number(stats.expected ?? 0);
    const skipped = Number(stats.skipped ?? 0);
    const failed = Number(stats.unexpected ?? 0);
    if (passed + skipped + failed === 0) return null;
    /*
     * A FAILED OR INTERRUPTED RUN IS NOT A SOURCE OF TOTALS.
     *
     * The report is rewritten by every invocation, including one that was
     * cancelled halfway. Comparing the document against those numbers would
     * report a document that is right and a run that never finished, which
     * teaches people to ignore the checker. When the last run did not pass
     * cleanly, this rule falls back to internal consistency.
     */
    if (failed > 0) return null;
    return { passed, skipped, failed, total: passed + skipped + failed };
  } catch {
    return null;
  }
}

/**
 * Phrases that pin a figure to a moment other than now.
 *
 * Shared by the browser-total and interaction-total rules, because a changelog
 * entry and a waypoint paragraph are the same situation: a number that was true
 * when it was written, kept on purpose, and labelled.
 */
const HISTORICAL_MARKER =
  /\bat that point\b|\bwaypoint\b|\bat the time\b|\bin that pass\b|\bas it stood\b|\bthen stood at\b|\bthat pass measured\b|\bpreviously\b|\bused to\b|\bwas then\b/i;

function checkBrowserTotals() {
  const run = browserRunTotals();
  const stated = [];

  for (const rel of currentStateDocs()) {
    const lines = readLines(rel);
    if (!lines) continue;
    lines.forEach((text, i) => {
      /*
       * The figure that follows the word "playwright", not the first figure on
       * the line. One row reads "vitest 989 passed … playwright 273 passed",
       * and taking the first match reported the UNIT total as a browser total —
       * a false positive, which is the failure mode that gets a checker
       * switched off.
       */
      const afterPlaywright = /playwright[^|]*?(\d{2,4})\s+passed/i.exec(text);
      /*
       * "139 Playwright tests" puts the number BEFORE the word, so the pattern
       * above cannot see it. That exact phrasing was live in two places while
       * the suite stood at 273 — a stale claim the first version of this rule
       * walked straight past, which is why it is matched explicitly.
       */
      const beforePlaywright = /(\d{2,4})\s+(?:Playwright|browser) tests?\b/i.exec(text);
      /*
       * THE GATE TABLE PUTS THE COMMAND AND THE RESULT IN DIFFERENT CELLS.
       *
       *   | Browser | `npx playwright test` | **273 passed, 13 skipped** |
       *
       * Both patterns above stop at a `|`, so neither could see that row — and
       * that row is the single most-read statement of the browser total in the
       * document. It sat at 139 through an entire pass while the checker
       * reported the file clean. A rule that misses the headline figure is
       * worse than no rule, because it certifies it.
       *
       * Matched on the ROW: a table line naming playwright or leading with a
       * Browser label, excluding the unit row, which names vitest in its own
       * command cell.
       */
      const tableRow =
        /^\s*\|/.test(text) &&
        !/vitest|unit/i.test(text) &&
        (/playwright/i.test(text) || /^\s*\|\s*Browser\s*\|/i.test(text))
          ? /(\d{2,4})\s+passed/i.exec(text)
          : null;
      const m =
        afterPlaywright ??
        beforePlaywright ??
        tableRow ??
        (/browser (?:suite|tests?)/i.test(text) && !/vitest|unit/i.test(text)
          ? /(\d{2,4})\s+passed/i.exec(text)
          : null);
      if (!m) return;
      /*
       * A FIGURE THAT DATES ITSELF IS NOT A STALE FIGURE.
       *
       * §26 is a changelog: each entry records what a PAST pass measured, and
       * those numbers are supposed to differ from today's. Rewriting them to
       * match the current run would destroy the only record of how the suite
       * grew, and deleting them would be worse. So a line may keep a historical
       * total on ONE condition — that it says so on the same line.
       *
       * The exemption is deliberately narrow, and it is the same device rule 12
       * uses. It fires only on an explicit backward-looking marker, so a
       * present-tense claim ("the browser suite passes 139 tests") is still
       * caught. Writing "at that point" above a number you believe to be
       * current is not a way around the checker; it is a false statement about
       * your own document, and it is one a reader can see.
       */
      if (HISTORICAL_MARKER.test(text)) return;
      stated.push({ rel, line: i + 1, count: Number(m[1]) });
    });
  }

  if (run) {
    for (const s of stated) {
      if (s.count !== run.passed) {
        report(
          s.rel,
          s.line,
          "browser-totals",
          `states ${s.count} browser tests passed; artifacts/playwright-report.json records ${run.passed}`,
        );
      }
    }
    return;
  }

  // No report to compare against: enforce that the document agrees with itself.
  const distinct = [...new Set(stated.map((s) => s.count))];
  if (distinct.length > 1) {
    for (const s of stated) {
      report(
        s.rel,
        s.line,
        "browser-totals",
        `browser pass count ${s.count} disagrees with other statements (${distinct.join(", ")})`,
      );
    }
  }
}

// -------------------------------------------- 10. audited-interaction totals

/**
 * A stated number of audited interactions must match the generated audit.
 *
 * The audit is a table generated FROM the run, so its row count is the only
 * honest source for this number. Sections 3 and 5 both said "38 audited
 * interactions" against a file that by then held several hundred.
 */
function checkInteractionTotals() {
  const file = path.join(ROOT, "artifacts", "ui-review", "INTERACTION_AUDIT.md");
  if (!existsSync(file)) return;
  const rows = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("|") && l.split("|").length >= 8)
    /*
     * The header row and its separator are not interactions.
     *
     * The first cell is `Project`, not `Page` — the audit is merged from two
     * browser projects and names which one each row came from. Matching only
     * `Page` counted the HEADER as an interaction, so this rule demanded a
     * number one higher than the file actually holds and the document could
     * never satisfy it. An off-by-one in a checker is worse than none: it makes
     * a correct document look wrong, and the fix somebody reaches for is to
     * write the wrong number down.
     */
    .filter((l) => !/^\|\s*(Project|Page|-+|:?-+:?)\s*\|/i.test(l)).length;
  if (rows === 0) return;

  for (const rel of currentStateDocs()) {
    const lines = readLines(rel);
    if (!lines) continue;
    lines.forEach((text, i) => {
      const m = /(\d{1,4})\s+audited interactions?/i.exec(text);
      if (!m) return;
      if (HISTORICAL_MARKER.test(text)) return;
      const stated = Number(m[1]);
      if (stated !== rows) {
        report(
          rel,
          i + 1,
          "interaction-total",
          `states ${stated} audited interactions; artifacts/ui-review/INTERACTION_AUDIT.md has ${rows} rows`,
        );
      }
    });
  }
}

// ------------------------------------------------- 11. a sentence said twice

/**
 * The same sentence twice in a row.
 *
 * "QA ledger credit is not a deposit" appeared on two consecutive lines,
 * which is what happens when a paragraph is rewritten beside its own earlier
 * version. It reads as an error to anyone who notices and is invisible to
 * anyone who does not, and no proof-read reliably catches it in 2,500 lines.
 *
 * Short lines are ignored — table separators, headings and boilerplate repeat
 * legitimately — and so is anything inside a fenced code block, where a
 * repeated line is usually the point.
 */
function checkRepeatedSentences() {
  for (const rel of currentStateDocs()) {
    const lines = readLines(rel);
    if (!lines) continue;

    let fenced = false;
    const recent = [];
    lines.forEach((raw, i) => {
      if (/^\s*```/.test(raw)) fenced = !fenced;
      if (fenced) return;

      const text = raw.trim().replace(/\s+/g, " ");
      if (text.length < 40) return;
      if (/^[|>#-]/.test(text)) return;

      const earlier = recent.find((r) => r.text === text);
      if (earlier) {
        report(
          rel,
          i + 1,
          "repeated-sentence",
          `repeats line ${earlier.line} word for word — "${text.slice(0, 60)}…"`,
        );
      }
      recent.push({ text, line: i + 1 });
      // A short window: a sentence legitimately recurs in a document this long,
      // and only an immediate repetition is a copy-paste error.
      if (recent.length > 4) recent.shift();
    });
  }
}

// --------------------------------------- 12. finished work called unfinished

/**
 * Nothing that is finished may be described as unfinished ANYWHERE.
 *
 * Rule 3 already stops a finished item sitting in the active backlog. This is
 * the same rule without the section boundary, because the failure it catches
 * happened outside one: §20's security table went on carrying
 * "Prompt-injection corpus | NOT_IMPLEMENTED" while §0 recorded the 53-attack
 * corpus and its 59 tests. The backlog was clean and the document was still
 * wrong.
 */
const FINISHED_SUBJECTS = [
  { in: /cash-?out exposure defect/i, evidence: "§15 records cash-out repaired, reachable and tested" },
  { in: /date-of-birth backfill/i, evidence: "§0 stage 5d records the flow, banner and gates" },
  { in: /bank list for withdrawals/i, evidence: "§0 stage 5f records the route, picker and its tests" },
  { in: /redis caching of .?liveVersion/i, evidence: "§0 stage 5e records the cache and its tests" },
  { in: /load tests? for the homepage/i, evidence: "§0 stage 6 records the measured load run" },
  { in: /prompt-?injection corpus/i, evidence: "§0 stage 5i records 53 attacks and 59 tests" },
  { in: /retire the legacy bridge/i, evidence: "the file is deleted from the repository" },
  { in: /legacy[- ]style removal/i, evidence: "the legacy bridge stylesheet is deleted" },
  {
    in: /bank[- ]account resolution|resolveBankAccount|account[- ]name resolution/i,
    evidence: "§11 records the provider call, the route, the read-only field and its tests",
  },
];

const UNFINISHED_WORDS =
  /NOT_IMPLEMENTED|\bnot implemented\b|\boutstanding\b|\bstill to do\b|\bnot (?:yet )?(?:built|written|done|started)\b|\bremains? (?:to be|un)done\b/i;

function checkFinishedNotCalledUnfinished() {
  for (const rel of currentStateDocs()) {
    const lines = readLines(rel);
    if (!lines) continue;
    lines.forEach((text, i) => {
      if (!UNFINISHED_WORDS.test(text)) return;
      for (const subject of FINISHED_SUBJECTS) {
        if (!subject.in.test(text)) continue;
        /*
         * A line may legitimately say a thing USED to be unfinished, as long as
         * it says so. The trail from a defect to its fix is worth reading.
         */
        if (/\bwas\b|\bused to\b|\bno longer\b|\buntil\b|\bpreviously\b|\bnow\b/i.test(text)) continue;
        report(
          rel,
          i + 1,
          "finished-called-unfinished",
          `describes finished work as unfinished — ${subject.evidence}`,
        );
      }
    });
  }
}

// ------------------------- 14. an attack that was accepted, inside a pass

/**
 * A security result may not say an attack SUCCEEDED and still stand as evidence.
 *
 * THE FAILURE THIS CATCHES, EXACTLY. The CSRF row in the security matrix read:
 * "a withdrawal posted with Origin: https://evil.example.com. The last one was
 * accepted with 201 -- finding 51". That sentence sat inside a table headed by
 * a claim that the internal security verification passes, and it stayed there
 * for a whole pass after the guard had been written. A reader skimming the
 * matrix saw a security section; a reader of that one cell saw an accepted
 * attack. Both readings came from the same table.
 *
 * The rule is narrow on purpose. It fires only where an acceptance verb sits
 * beside a success status on a line that also names an attack, and it does NOT
 * fire on a line saying the attempt was refused or dating itself as history.
 * Recording what a defect USED to do is exactly what this document is for; the
 * requirement is only that it cannot be the CURRENT result.
 */
const ACCEPTED_ATTACK =
  /\b(?:accepted|succeeded|allowed|went through|got through)\b[^.]{0,60}?\b(?:20[01])\b/i;

const SAYS_IT_WAS_REFUSED =
  /\brefused\b|\brejected\b|\bblocked\b|\b40[13]\b|\bno longer\b|\bused to\b|\bpreviously\b|\bwas then\b|\bat the time\b|\bhas since\b|\bnow answers\b|\bFIXED\b|\bfixed\b/i;

function checkNoAcceptedAttackInSecurityMatrix() {
  for (const rel of currentStateDocs()) {
    const lines = readLines(rel);
    if (!lines) continue;
    lines.forEach((text, i) => {
      if (!ACCEPTED_ATTACK.test(text)) return;
      // Only lines that are about an attack at all.
      if (
        !/attack|hostile|forged|origin|csrf|xss|injection|bypass|spoof|replay|traversal/i.test(text)
      ) {
        return;
      }
      if (SAYS_IT_WAS_REFUSED.test(text)) return;
      report(
        rel,
        i + 1,
        "accepted-attack",
        "a security result records an attack as accepted without saying it was fixed",
      );
    });
  }
}

// ------------------------------------------- 15. the unit-suite total

/**
 * Every stated Vitest total must agree with every other one.
 *
 * THE FAILURE THIS CATCHES. The browser total had a rule and the unit total did
 * not, so the same staleness simply moved: three separate sentences said
 * "unchanged at 989", "moved from 975 to 989" and "test count is 989" while the
 * gate table said something else entirely. Each was true when written. None was
 * true together, and a reader had four numbers and no way to choose.
 *
 * There is no machine-readable Vitest report committed here to compare against
 * — the CI job writes one, local runs do not — so this enforces INTERNAL
 * agreement, which is the property that was actually broken. Historical figures
 * are exempt on the same terms as everywhere else: say so on the same line.
 */
function checkUnitTotals() {
  const stated = [];
  for (const rel of currentStateDocs()) {
    const lines = readLines(rel);
    if (!lines) continue;
    lines.forEach((text, i) => {
      if (HISTORICAL_MARKER.test(text)) return;
      /*
       * Only a figure tied to the unit suite: "vitest ... N passed", or a
       * "test count"/"unit total" phrasing. A bare "N passed" is not enough —
       * the browser rows say that too, and claiming them here would report a
       * conflict between two different suites.
       */
      const m =
        /vitest[^|]*?(\d[\d,]{2,})\s+passed/i.exec(text) ??
        /(?:test count|unit total|vitest total)\D{0,24}?(\d[\d,]{2,})/i.exec(text);
      if (!m) return;
      stated.push({ rel, line: i + 1, count: Number(m[1].replace(/,/g, "")) });
    });
  }

  const distinct = [...new Set(stated.map((x) => x.count))];
  if (distinct.length > 1) {
    for (const x of stated) {
      report(
        x.rel,
        x.line,
        "unit-totals",
        `unit-test total ${x.count} disagrees with other statements (${distinct.join(", ")})`,
      );
    }
  }
}

// ------------------------------------------------------------------- run them

checkMigrationTotals();
checkReadinessBlockerTotals();
checkBacklogVersusDone();
checkDeletedFilesNotDescribedAsPresent();
checkSingleSourceOfTruth();
checkStatusLabels();
checkPlaceholders();
checkBranchDescribed();
checkBranchCommitCount();
checkBrowserTotals();
checkInteractionTotals();
checkRepeatedSentences();
checkFinishedNotCalledUnfinished();
checkNoAcceptedAttackInSecurityMatrix();
checkUnitTotals();

const byRule = new Map();
for (const f of findings) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);

if (findings.length === 0) {
  console.info(`check-docs: clean — ${docFiles().length} document(s), 15 rules`);
  process.exit(0);
}

console.error(`check-docs: ${findings.length} finding(s) across ${byRule.size} rule(s)\n`);
for (const f of findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
  console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.message}`);
}
console.error("\nFix the document, or the check. Do not silence it.");
process.exit(1);
