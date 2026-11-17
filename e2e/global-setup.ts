import { mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Clears the previous run's audit rows — ONCE, before any project starts.
 *
 * This is the only place allowed to delete them. A `beforeAll` cannot do it:
 * that hook runs once per project, so the second browser would erase the first
 * browser's rows and the audit would report half a run as though it were the
 * whole one. That defect actually shipped, and the fix was per-project files;
 * now that several spec files contribute to each of those files, the truncation
 * has to move somewhere that runs once, which is here.
 *
 * It removes ONLY the per-project fragments. The merged `INTERACTION_AUDIT.md`
 * and the screenshots are built afterwards by `scripts/build-ui-review.mjs`, and
 * deleting a deliverable because a test run started is how an earlier version of
 * the capture script destroyed the audit it was meant to sit beside.
 */
export default function globalSetup(): void {
  const dir = path.resolve("artifacts/ui-review");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(dir)) return;

  let removed = 0;
  for (const file of readdirSync(dir)) {
    if (/^interaction-audit-.+\.md$/.test(file)) {
      rmSync(path.join(dir, file));
      removed += 1;
    }
  }
  if (removed > 0) {
    console.info(`[audit] cleared ${removed} per-project audit fragment(s) from the previous run`);
  }
}
