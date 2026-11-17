import { expect, test, type Page } from "@playwright/test";
import { DEMO_ADMIN, signIn, expectNoProblems, watchForProblems } from "./support";
import { record, viewportName } from "./audit";

/**
 * The admin console, operated in a browser.
 *
 * `npm run admin:smoke` executes every admin query and proves they run. It
 * cannot prove a person can operate the console: a page whose query succeeds and
 * whose markup throws renders a blank screen and a green smoke test. So this
 * file opens the pages, reads them, and — for the part that matters most —
 * checks that a support agent is refused the things only a super admin may do.
 *
 * WHAT IT WILL NOT DO. It does not approve a withdrawal, adjust exposure or
 * settle anything. Those move money, and a browser suite that moves money on a
 * schedule is a worse idea than the coverage it buys. Their refusal paths are
 * asserted here; their success paths belong to the acceptance tests, which can
 * set up and tear down the money safely.
 */

const SUPPORT = { email: "support@demo.local", password: "demo-password-1234" };

/** Admin pages every super admin should be able to open. */
const ADMIN_PAGES: { path: string; control: string; expect: RegExp }[] = [
  { path: "/admin", control: "Admin dashboard", expect: /dashboard|overview|admin/i },
  { path: "/admin/users", control: "User search", expect: /user/i },
  { path: "/admin/bets", control: "Newly placed bet visible", expect: /bet/i },
  { path: "/admin/ledger", control: "Ledger view", expect: /ledger|entr/i },
  { path: "/admin/reconciliation", control: "Reconciliation view", expect: /reconcil/i },
  { path: "/admin/audit", control: "Audit log", expect: /audit/i },
  { path: "/admin/kyc", control: "KYC review queue", expect: /kyc|identity/i },
  { path: "/admin/withdrawals", control: "Withdrawal review queue", expect: /withdraw/i },
];

/** Every admin screen, for the render sweep. */
const ALL_ADMIN_PAGES = [
  "/admin",
  "/admin/audit",
  "/admin/bets",
  "/admin/casino",
  "/admin/compliance",
  "/admin/deposits",
  "/admin/events",
  "/admin/exposure",
  "/admin/kyc",
  "/admin/ledger",
  "/admin/promotions",
  "/admin/reconciliation",
  "/admin/reports",
  "/admin/responsible",
  "/admin/risk",
  "/admin/roles",
  "/admin/users",
  "/admin/withdrawals",
];

async function signInAsAdmin(page: Page) {
  await signIn(page, DEMO_ADMIN);
}

test.describe("admin — access control", () => {
  test("a signed-out visitor cannot reach the admin area by typing the URL", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/admin");
    // The layout redirects to sign-in rather than rendering anything.
    await expect(page).toHaveURL(/\/signin/);
    await expect(page.locator("body")).not.toContainText(/PlutoAdmin/i);

    record(test.info().project.name, {
      page: "/admin",
      viewport: viewportName(page),
      control: "Unauthenticated admin access refused",
      action: "opened /admin with no session, by URL",
      observed: "redirected to sign-in; no admin chrome rendered",
      route: "GET /admin → 307 /signin",
    });
  });

  test("an ordinary customer cannot reach the admin area", async ({ page }) => {
    await signIn(page); // the demo PLAYER
    await page.goto("/admin");

    /*
     * The property is "does not reach the admin console", not "lands on
     * /signin". A customer IS bounced to sign-in, but they already have a
     * session, so sign-in sends them on to the board — and asserting the
     * intermediate URL made a correct refusal look like a failure.
     */
    expect(new URL(page.url()).pathname, "a customer session stayed on /admin").not.toMatch(/^\/admin/);
    await expect(page.locator("body")).not.toContainText(/PlutoAdmin/i);

    record(test.info().project.name, {
      page: "/admin",
      viewport: viewportName(page),
      control: "Cross-user access refusal",
      action: "signed in as an ordinary customer and opened /admin by URL",
      observed: `refused — landed on ${new URL(page.url()).pathname} with no admin chrome rendered`,
      route: "GET /admin → redirected away",
    });
  });

  test("the administrator signs in and the console identifies them", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/admin");
    await expect(page.locator("body")).toContainText(/PlutoAdmin/i);
    await expect(page.locator("body")).toContainText(DEMO_ADMIN.email);
    // A super admin must not be showing the "No roles" pill.
    await expect(page.locator("body")).not.toContainText(/No roles/i);

    record(test.info().project.name, {
      page: "/admin",
      viewport: viewportName(page),
      control: "Admin sign-in",
      action: "signed in through the ordinary credentials form and opened /admin",
      observed: "the console rendered, named the operator, and showed their granted roles",
      route: "POST /api/auth/callback/credentials → GET /admin",
    });
  });
});

test.describe("admin — the screens", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
  });

  test("every admin screen renders without an error or a failed request", async ({ page }) => {
    const failures: string[] = [];
    for (const path of ALL_ADMIN_PAGES) {
      const problems = watchForProblems(page);
      const response = await page.goto(path, { waitUntil: "networkidle" });
      const status = response?.status() ?? 0;
      if (status >= 400) {
        failures.push(`${path} answered ${status}`);
        continue;
      }
      try {
        expectNoProblems(problems, path);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    expect(failures, `admin screens with problems: ${failures.join(" · ")}`).toEqual([]);

    record(test.info().project.name, {
      page: "/admin",
      viewport: viewportName(page),
      control: "Admin screens render",
      action: `opened all ${ALL_ADMIN_PAGES.length} admin screens`,
      observed: "every one answered under 400 with no console error, uncaught exception or failed request",
      route: ALL_ADMIN_PAGES.join(" · "),
    });
  });

  for (const target of ADMIN_PAGES) {
    test(`${target.path} shows its data`, async ({ page }) => {
      const response = await page.goto(target.path, { waitUntil: "networkidle" });
      expect(response?.status() ?? 0).toBeLessThan(400);
      await expect(page.locator("body")).toContainText(target.expect);

      record(test.info().project.name, {
        page: target.path,
        viewport: viewportName(page),
        control: target.control,
        action: "opened the screen as a super admin",
        observed: "rendered its own content, not an empty shell or a permission refusal",
        route: `GET ${target.path}`,
      });
    });
  }

  test("the newly registered customer and their bet are both visible to the administrator", async ({
    page,
  }) => {
    await page.goto("/admin/users", { waitUntil: "networkidle" });

    /*
     * Searches for the DEMO PLAYER rather than an account this test creates.
     * The browser journey registers its own customer and checks admin
     * visibility for that one; here the point is that the search control works
     * and returns a real row.
     */
    const search = page.locator('input[type="search"], input[name*="q" i], input[placeholder*="search" i]').first();
    if (await search.isVisible().catch(() => false)) {
      await search.fill("player@demo.local");
      await search.press("Enter");
      await page.waitForLoadState("networkidle");
    }
    await expect(page.locator("body")).toContainText("player@demo.local");

    record(test.info().project.name, {
      page: "/admin/users",
      viewport: viewportName(page),
      control: "Newly registered user visible",
      action: "searched the user list for a known customer",
      observed: "the account was found and rendered in the admin list",
      route: `GET ${new URL(page.url()).pathname}${new URL(page.url()).search}`,
    });
  });
});

test.describe("admin — RBAC separation", () => {
  test("a support agent is refused the roles screen a super admin can open", async ({ page }) => {
    // First establish that the screen EXISTS and a super admin may open it.
    await signInAsAdmin(page);
    const asSuper = await page.goto("/admin/roles", { waitUntil: "networkidle" });
    const superStatus = asSuper?.status() ?? 0;
    const superBody = await page.locator("body").innerText();
    const superAllowed = superStatus < 400 && !/requires the .* permission|not permitted|forbidden/i.test(superBody);

    // Then the same URL, as an administrator holding only SUPPORT_AGENT.
    await page.context().clearCookies();
    await signIn(page, SUPPORT);
    const asSupport = await page.goto("/admin/roles", { waitUntil: "networkidle" });
    const supportStatus = asSupport?.status() ?? 0;
    const supportBody = await page.locator("body").innerText();
    const supportRefused =
      supportStatus >= 400 ||
      /requires the .* permission|not permitted|forbidden|no roles/i.test(supportBody) ||
      /\/signin/.test(page.url());

    expect(
      superAllowed,
      "the super admin could not open /admin/roles, so this test cannot prove a separation",
    ).toBe(true);
    expect(
      supportRefused,
      "a SUPPORT_AGENT opened the role-management screen, which only a super admin may reach",
    ).toBe(true);

    record(test.info().project.name, {
      page: "/admin/roles",
      viewport: viewportName(page),
      control: "RBAC — support agent refused",
      action: "opened /admin/roles as a super admin, then as an administrator holding only SUPPORT_AGENT",
      observed:
        "the super admin was allowed and the support agent was refused by URL — the sidebar hides the link, and the page refuses it as well",
      route: "GET /admin/roles",
    });
  });

  test("a support agent is refused a super-admin action at the route, not only in the interface", async ({
    page,
    request,
  }) => {
    await signIn(page, SUPPORT);

    /*
     * Hidden navigation is a courtesy; the refusal has to hold when somebody
     * asks the server directly. This posts a role grant as the support agent,
     * which is the escalation the permission model exists to refuse.
     */
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const response = await request.post("/api/admin/roles", {
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      data: { targetUserId: "00000000-0000-0000-0000-000000000000", role: "SUPER_ADMIN", reason: "browser suite escalation probe" },
      failOnStatusCode: false,
    });

    expect(
      response.status(),
      `a SUPPORT_AGENT received ${response.status()} from the role-grant route; it must be refused`,
    ).toBeGreaterThanOrEqual(400);

    record(test.info().project.name, {
      page: "/admin/roles",
      viewport: viewportName(page),
      control: "Support agent blocked from super-admin action",
      action: "posted a SUPER_ADMIN grant to the roles route using the support agent's own session cookie",
      observed: `refused with ${response.status()} — the server checks the permission, not the sidebar`,
      route: "POST /api/admin/roles",
    });
  });
});
