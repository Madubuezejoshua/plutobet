import { expect, type Page, type ConsoleMessage, type Request } from "@playwright/test";

/**
 * Shared helpers for the browser suite.
 *
 * The demo credentials below are seeded by `npm run db:seed-demo` into a
 * DISPOSABLE LOCAL DATABASE. They are not a secret and not a production
 * account — the seed refuses to run with `NODE_ENV=production`, and the account
 * exists only in a database that is thrown away.
 */

export const DEMO_PLAYER = {
  email: "player@demo.local",
  password: "demo-password-1234",
};

export const DEMO_ADMIN = {
  email: "admin@demo.local",
  password: "demo-password-1234",
};

/**
 * Console errors and failed requests, collected for the whole test.
 *
 * A page that renders correctly while throwing in the console is not a page
 * that works — a hydration mismatch, a failed fetch or an uncaught rejection
 * all look fine in a screenshot. Every navigation test asserts this is empty.
 */
export interface PageProblems {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

/** Noise from the platform rather than from this application. */
const IGNORABLE = [
  // React's development-only warning about extension-injected attributes.
  /Extra attributes from the server/i,
  // Chromium emits this for a favicon that is present but not preloaded.
  /favicon/i,
  // Next's dev overlay, absent from a production build but harmless if seen.
  /react-devtools/i,
];

function ignorable(text: string): boolean {
  return IGNORABLE.some((pattern) => pattern.test(text));
}

export function watchForProblems(page: Page): PageProblems {
  const problems: PageProblems = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
  };

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (!ignorable(text)) problems.consoleErrors.push(text);
  });

  page.on("pageerror", (error: Error) => {
    if (!ignorable(error.message)) problems.pageErrors.push(error.message);
  });

  page.on("requestfailed", (request: Request) => {
    const failure = request.failure()?.errorText ?? "unknown";
    // `net::ERR_ABORTED` is what a cancelled navigation or a component
    // unmounting mid-fetch produces. It is not a defect.
    if (failure.includes("ERR_ABORTED")) return;
    problems.failedRequests.push(`${request.method()} ${request.url()} — ${failure}`);
  });

  return problems;
}

export function expectNoProblems(problems: PageProblems, where: string): void {
  expect(problems.pageErrors, `uncaught exception on ${where}`).toEqual([]);
  expect(problems.consoleErrors, `console error on ${where}`).toEqual([]);
  expect(problems.failedRequests, `failed request on ${where}`).toEqual([]);
}

/**
 * The page must not scroll sideways.
 *
 * Measured rather than eyeballed. A board one column too wide looks almost
 * right in a screenshot and is unusable on a phone, and this is the check that
 * catches it — it was a real defect in this codebase twice.
 */
export async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      // The widest offending element, so a failure names the culprit rather
      // than only the symptom.
      widest: (() => {
        let worst = { selector: "", right: 0 };
        for (const element of Array.from(document.body.querySelectorAll("*"))) {
          const rect = element.getBoundingClientRect();
          if (rect.right > worst.right) {
            worst = {
              selector: `${element.tagName.toLowerCase()}.${(element.className || "")
                .toString()
                .split(" ")
                .filter(Boolean)
                .slice(0, 2)
                .join(".")}`,
              right: Math.round(rect.right),
            };
          }
        }
        return worst;
      })(),
    };
  });

  expect(
    overflow.scrollWidth,
    `${where} scrolls horizontally: document is ${overflow.scrollWidth}px in a ` +
      `${overflow.clientWidth}px viewport; widest element ${overflow.widest.selector} ` +
      `reaches ${overflow.widest.right}px`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

/** Signs in through the real credentials form, not by forging a cookie. */
export async function signIn(
  page: Page,
  who: { email: string; password: string } = DEMO_PLAYER,
): Promise<void> {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // The board is where a successful sign-in lands.
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 30_000 });
}

/**
 * Every enabled control on the page, with enough about it to report.
 *
 * Used by the interaction audit to enumerate what has to be accounted for,
 * so the audit covers what is actually rendered rather than what somebody
 * remembered to list.
 */
export async function enabledControls(page: Page) {
  return page.evaluate(() => {
    const selector = "button, a[href], input, select, textarea, summary, [role='tab']";
    return Array.from(document.querySelectorAll(selector))
      .filter((element) => {
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (element.hasAttribute("disabled")) return false;
        if (element.getAttribute("aria-disabled") === "true") return false;
        return (element as HTMLElement).offsetParent !== null || style.position === "fixed";
      })
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
        href: element.getAttribute("href"),
        type: element.getAttribute("type"),
        label:
          element.getAttribute("aria-label") ??
          element.getAttribute("placeholder") ??
          element.getAttribute("name"),
      }));
  });
}
