import { appendFileSync, mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

/**
 * The audit ledger the browser run writes as it goes.
 *
 * Shared by every interaction spec, because the audit is one record of one run
 * and not one record per file.
 *
 * APPEND ONLY. Truncation happens exactly once per run, in `global-setup.ts`.
 * It used to happen in a `beforeAll`, which runs once per PROJECT — so the
 * second browser silently erased the first browser's rows and the audit
 * reported half a run as though it were all of it. Now that several files
 * contribute, the same mistake would erase a whole file's worth, so the rule is
 * worth restating: nothing here opens the file for writing.
 */

export function auditPath(project: string): string {
  return `artifacts/ui-review/interaction-audit-${project}.md`;
}

export interface AuditRow {
  page: string;
  viewport: string;
  control: string;
  action: string;
  observed: string;
  route: string;
  status?: string;
}

/**
 * Records one audited interaction.
 *
 * `control` is matched by `scripts/check-control-coverage.mjs` against
 * `e2e/control-manifest.mjs`, either exactly or as `"<name> — detail"`. Renaming
 * a control here without renaming it there turns a covered control into a
 * reported gap, which is the failure direction worth having.
 */
export function record(project: string, row: AuditRow): void {
  mkdirSync("artifacts/ui-review", { recursive: true });
  const status = row.status ?? "VERIFIED_IN_REAL_BROWSER";
  appendFileSync(
    auditPath(project),
    `| ${row.page} | ${row.viewport} | ${row.control} | ${row.action} | ${row.observed} | ${row.route} | \`${status}\` |\n`,
    "utf8",
  );
}

export function viewportName(page: Page): string {
  const size = page.viewportSize();
  return size ? `${size.width}×${size.height}` : "unknown";
}

/** Captures the request a control causes, so the audit can name the route. */
export async function routeFor(
  page: Page,
  act: () => Promise<void>,
  match: RegExp,
): Promise<string> {
  const waiting = page
    .waitForRequest((request) => match.test(request.url()), { timeout: 20_000 })
    .catch(() => null);
  await act();
  const request = await waiting;
  if (!request) return "—";
  const url = new URL(request.url());
  return `${request.method()} ${url.pathname}${url.search}`;
}

/**
 * A unique-enough address for a fresh test account.
 *
 * The journey registers real accounts through the real handler, so it needs an
 * address nothing else has used. `.local` is reserved and cannot leave the
 * machine even if something tried to send to it.
 */
export function freshEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@browser-test.local`;
}
