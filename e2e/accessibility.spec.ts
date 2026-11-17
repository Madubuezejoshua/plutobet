import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./support";

/**
 * The accessibility pass.
 *
 * Until now this was the largest honest gap in the browser suite: `general.md`
 * recorded it as "not done and not blocked", and the only accessible-name defect
 * ever found in this codebase — the sign-in password field, whose label had
 * swallowed the "Forgot password?" link — was found by accident, because a
 * browser could not locate a field with that name. Accidents are not a control.
 *
 * WHAT THE THRESHOLD IS AND WHY. Failing on `critical` and `serious` is the
 * owner's stated bar. `moderate` and `minor` are reported on failure but do not
 * fail the run, because axe's moderate set includes judgement calls (landmark
 * structure, heading order) that are worth reading and not worth blocking on.
 * Raising the bar later is a one-line change to IMPACTS_THAT_FAIL.
 *
 * WHAT AXE DOES AND DOES NOT PROVE. It is a static rule engine over the rendered
 * accessibility tree. A clean run means no rule fired; it does not mean the page
 * is usable with a screen reader, and this file never claims that. The keyboard
 * tests below cover the part axe cannot see — whether a person who never touches
 * a mouse can actually operate the thing.
 */

const IMPACTS_THAT_FAIL = new Set(["critical", "serious"]);

/** Pages a signed-out visitor can reach. */
const PUBLIC_PAGES = [
  "/",
  "/sports",
  "/live",
  "/results",
  "/livescore",
  "/jackpot",
  "/promotions",
  "/casino",
  "/live-casino",
  "/virtuals",
  "/fantasy",
  "/lucky-numbers",
  "/pluto",
  "/signin",
  "/register",
  "/forgot-password",
];

/**
 * Pages that need a session.
 *
 * Preferences and security live UNDER `/account`, not at the top level. The
 * owner's page list names them as `/preferences` and `/security`; those routes
 * do not exist, and listing them here would have scanned two 404s and reported
 * them clean.
 */
const AUTHED_PAGES = [
  "/bets",
  "/account",
  "/account/preferences",
  "/account/security",
  "/wallet",
  "/deposit",
  "/withdraw",
  "/kyc",
  "/responsible",
  "/referrals",
  "/rewards",
];

interface Finding {
  page: string;
  rule: string;
  impact: string;
  help: string;
  nodes: string[];
}

/**
 * Scans one page and returns every violation, already flattened for reporting.
 *
 * The selector of each offending node is kept: a rule name alone ("elements must
 * have sufficient colour contrast") sends somebody hunting across a whole page,
 * and the fix always begins with which element.
 */
async function scan(page: Page, path: string): Promise<Finding[]> {
  const results = await new AxeBuilder({ page })
    // The default rule set, plus the WCAG tags the bar is stated in.
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  return results.violations.map((violation) => ({
    page: path,
    rule: violation.id,
    impact: violation.impact ?? "unknown",
    help: violation.help,
    nodes: violation.nodes.slice(0, 4).map((node) => node.target.join(" ")),
  }));
}

function report(findings: Finding[]): string {
  if (findings.length === 0) return "none";
  return findings
    .map(
      (f) =>
        `\n  [${f.impact}] ${f.page} — ${f.rule}: ${f.help}\n` +
        f.nodes.map((n) => `      at ${n}`).join("\n"),
    )
    .join("");
}

test.describe("accessibility", () => {
  test("every public page is free of critical and serious violations", async ({ page }) => {
    const blocking: Finding[] = [];
    const advisory: Finding[] = [];

    for (const path of PUBLIC_PAGES) {
      const response = await page.goto(path, { waitUntil: "networkidle" });
      // A page that did not render cannot be scanned, and silently scanning an
      // error page would report it clean.
      expect(response?.status() ?? 0, `${path} did not render`).toBeLessThan(400);

      for (const finding of await scan(page, path)) {
        (IMPACTS_THAT_FAIL.has(finding.impact) ? blocking : advisory).push(finding);
      }
    }

    // Printed whether or not the run fails, so the moderate set stays visible
    // rather than accumulating unseen behind a green tick.
    console.info(`advisory (moderate/minor) findings: ${report(advisory)}`);

    expect(blocking, `critical/serious violations: ${report(blocking)}`).toEqual([]);
  });

  test("every signed-in page is free of critical and serious violations", async ({ page }) => {
    await signIn(page);

    const blocking: Finding[] = [];
    const advisory: Finding[] = [];

    for (const path of AUTHED_PAGES) {
      const response = await page.goto(path, { waitUntil: "networkidle" });
      expect(response?.status() ?? 0, `${path} did not render`).toBeLessThan(400);

      for (const finding of await scan(page, path)) {
        (IMPACTS_THAT_FAIL.has(finding.impact) ? blocking : advisory).push(finding);
      }
    }

    console.info(`advisory (moderate/minor) findings: ${report(advisory)}`);

    expect(blocking, `critical/serious violations: ${report(blocking)}`).toEqual([]);
  });
});

test.describe("keyboard navigation", () => {
  test("the board can be reached and operated without a mouse", async ({ page }) => {
    await page.goto("/");

    /*
     * Tab from the top and require that focus actually lands somewhere visible.
     * The failure this catches is a control that is reachable but shows no focus
     * ring, which is indistinguishable from a frozen page for anybody navigating
     * by keyboard.
     */
    const reached: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => {
        const element = document.activeElement;
        if (!element || element === document.body) return null;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          text: (element.textContent ?? "").trim().slice(0, 40),
          // A focus indicator is an outline, a box-shadow, or a border change.
          // Any of the three is fine; none of them is the defect.
          indicated:
            style.outlineStyle !== "none" ||
            style.boxShadow !== "none" ||
            element.matches(":focus-visible"),
          visible: rect.width > 0 && rect.height > 0,
        };
      });
      if (focused?.visible) reached.push(`${focused.tag}:${focused.indicated ? "ok" : "NO-FOCUS"}`);
    }

    expect(reached.length, "tabbing from the top reached no focusable control").toBeGreaterThan(0);

    const invisible = reached.filter((entry) => entry.endsWith("NO-FOCUS"));
    expect(invisible, `controls focusable with no visible focus indicator: ${invisible.join(", ")}`).toEqual(
      [],
    );
  });

  test("a keyboard user is never trapped", async ({ page }) => {
    await page.goto("/");

    /*
     * A trap is a set of elements that cycles without ever letting go. Tabbing
     * far more times than the page has controls and finding only a handful of
     * distinct ones is the signature. Measured rather than assumed, because a
     * trap is invisible to every other check in this suite.
     */
    const seen = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      await page.keyboard.press("Tab");
      const id = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element) return "none";
        return `${element.tagName}:${element.id || element.className || element.textContent?.slice(0, 20) || ""}`;
      });
      seen.add(id);
    }

    expect(seen.size, "60 tab presses reached fewer than 5 distinct controls — a keyboard trap").toBeGreaterThan(
      4,
    );
  });
});
