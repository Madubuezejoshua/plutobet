import { expect, test } from "@playwright/test";
import {
  DEMO_PLAYER,
  expectNoHorizontalOverflow,
  expectNoProblems,
  signIn,
  watchForProblems,
} from "./support";

/**
 * Every customer page, in a real browser, at desktop and phone sizes.
 *
 * WHAT THIS CATCHES THAT THE OTHER GATES DO NOT. A page can typecheck, lint,
 * pass every unit test and build cleanly while rendering unstyled, throwing in
 * the console, scrolling sideways on a phone, or answering 500. All four have
 * happened in this repository, and none of them was caught by a gate that does
 * not open a browser.
 *
 * Run against a REVIEW SERVER on a disposable local database. See
 * `playwright.config.ts` for why the server is not started from the config.
 */

/** Pages a signed-out visitor can reach. */
const PUBLIC_PAGES = [
  { path: "/", name: "board" },
  { path: "/sports", name: "sports" },
  { path: "/live", name: "live" },
  { path: "/results", name: "results" },
  { path: "/livescore", name: "livescore" },
  { path: "/jackpot", name: "jackpot" },
  { path: "/promotions", name: "promotions" },
  { path: "/casino", name: "casino" },
  { path: "/virtuals", name: "virtuals" },
  { path: "/pluto", name: "pluto" },
  { path: "/signin", name: "sign in" },
  { path: "/register", name: "register" },
  { path: "/forgot-password", name: "password reset" },
  { path: "/fantasy", name: "fantasy (unavailable)" },
  { path: "/live-casino", name: "live casino (unavailable)" },
  { path: "/lucky-numbers", name: "lucky numbers (unavailable)" },
];

/** Pages that need a session. */
const PRIVATE_PAGES = [
  { path: "/bets", name: "my bets" },
  { path: "/wallet", name: "wallet" },
  { path: "/deposit", name: "deposit" },
  { path: "/withdraw", name: "withdraw" },
  { path: "/kyc", name: "kyc" },
  { path: "/responsible", name: "safer gambling" },
  { path: "/account", name: "account" },
  { path: "/account/security", name: "security" },
  { path: "/account/preferences", name: "preferences" },
  { path: "/referrals", name: "referrals" },
  { path: "/rewards", name: "rewards" },
];

test.describe("public pages", () => {
  for (const page of PUBLIC_PAGES) {
    test(`${page.name} renders without errors or overflow`, async ({ page: browserPage }) => {
      const problems = watchForProblems(browserPage);

      const response = await browserPage.goto(page.path, { waitUntil: "networkidle" });

      expect(response?.status(), `${page.path} status`).toBeLessThan(400);
      expectNoProblems(problems, page.path);
      await expectNoHorizontalOverflow(browserPage, page.path);

      // The redesign's own stylesheet reached the browser. This is the check
      // that would have caught the @import ordering defect, where every gate
      // passed and the page rendered as unstyled HTML.
      const styled = await browserPage.evaluate(() => {
        const shell = document.querySelector(".sb");
        if (!shell) return false;
        return window.getComputedStyle(shell).fontFamily.includes("Inter");
      });
      expect(styled, `${page.path} is missing the sportsbook stylesheet`).toBe(true);
    });
  }
});

test.describe("private pages", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, DEMO_PLAYER);
  });

  for (const page of PRIVATE_PAGES) {
    test(`${page.name} renders without errors or overflow`, async ({ page: browserPage }) => {
      const problems = watchForProblems(browserPage);

      const response = await browserPage.goto(page.path, { waitUntil: "networkidle" });

      expect(response?.status(), `${page.path} status`).toBeLessThan(400);
      // A signed-in customer must not be bounced back to sign-in.
      expect(new URL(browserPage.url()).pathname, `${page.path} redirected`).not.toContain(
        "/signin",
      );
      expectNoProblems(problems, page.path);
      await expectNoHorizontalOverflow(browserPage, page.path);
    });
  }
});

test.describe("pages that must refuse a signed-out visitor", () => {
  for (const page of PRIVATE_PAGES) {
    test(`${page.name} sends a signed-out visitor to sign in`, async ({ page: browserPage }) => {
      await browserPage.goto(page.path);

      // Not a 500, not a blank page, and not the content: the customer is asked
      // to sign in and told where they were going.
      await expect(browserPage).toHaveURL(/\/signin/);
      const callback = new URL(browserPage.url()).searchParams.get("callbackUrl");
      expect(callback, `${page.path} lost the destination`).toBeTruthy();
    });
  }
});

test.describe("the pages that do not exist", () => {
  test("an unknown route answers 404 with a way out", async ({ page }) => {
    const problems = watchForProblems(page);

    const response = await page.goto("/this-route-does-not-exist");

    expect(response?.status()).toBe(404);

    /*
     * Chromium logs "Failed to load resource: 404" for the navigation itself.
     * On a page we asked for BECAUSE it 404s, that line is the browser
     * reporting what we requested, not a defect — so it is dropped here rather
     * than added to the shared ignore list, where it would hide a genuine 404
     * on some other page's asset.
     */
    problems.consoleErrors = problems.consoleErrors.filter(
      (text) => !/status of 404/.test(text),
    );
    expectNoProblems(problems, "404");
    // A dead end is worse than the 404 itself.
    await expect(page.getByRole("link").first()).toBeVisible();
  });

  test("the health endpoint reports on the environment", async ({ request }) => {
    const response = await request.get("/api/health");
    const body = (await response.json()) as { status?: string; checks?: unknown[] };

    // 200 or 503 are both legitimate answers — it reports, it does not assert
    // that everything is fine. What matters is that it answers with checks.
    expect([200, 503]).toContain(response.status());
    expect(Array.isArray(body.checks)).toBe(true);

    // And it never leaks a value.
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/postgres:\/\/|redis:\/\/|rediss:\/\/|sk_live|npg_/);
  });
});

test.describe("the measured column", () => {
  /*
   * WHY THIS EXISTS. `.sb-page` is the container every non-board page sits in.
   * Its rules were defined in `legacy-bridge.css`, and deleting that file took
   * them with it: headings went hard against the left edge and tables spanned
   * the full 1440px. Nothing failed. Not the typecheck, not the linter, not
   * `next build`, and not the browser suite above — because that suite measures
   * horizontal OVERFLOW, and a full-bleed page does not overflow. It was caught
   * by a person looking at a screenshot, which is not a control.
   *
   * So the container is asserted directly. The board and the auth pages are
   * deliberately edge to edge and simply do not use `.sb-page`; this only
   * checks pages that claim the class, which is exactly the set that broke.
   */
  const COLUMNED = ["/live", "/results", "/jackpot", "/promotions", "/livescore", "/fantasy"];

  for (const path of COLUMNED) {
    test(`${path} is held in a measured column`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "a phone viewport is narrower than the column");

      await page.goto(path, { waitUntil: "networkidle" });

      const measured = await page.evaluate(() => {
        const el = document.querySelector(".sb-page");
        if (!el) return null;
        const style = window.getComputedStyle(el);
        return {
          width: el.getBoundingClientRect().width,
          maxWidth: style.maxWidth,
          viewport: window.innerWidth,
        };
      });

      expect(measured, `${path} has no .sb-page container`).not.toBeNull();
      expect(measured?.maxWidth, `${path} container has no max-width`).not.toBe("none");
      // The reported symptom, stated as the assertion: content the full width
      // of a 1440px window is the defect, whatever the rule that caused it.
      expect(
        measured!.width,
        `${path} spans the whole viewport — the page container is not applying`,
      ).toBeLessThan(measured!.viewport);
    });
  }
});
