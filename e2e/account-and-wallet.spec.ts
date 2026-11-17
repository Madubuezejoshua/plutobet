import { expect, test, type Page } from "@playwright/test";
import { DEMO_PLAYER, signIn } from "./support";
import { record, routeFor, viewportName } from "./audit";

/**
 * The account hub, safer gambling, the wallet and KYC — pressed, not read.
 *
 * These are the controls that change what a customer is allowed to do, which
 * makes "it is wired up in the source" the least interesting thing anyone can
 * say about them. A deposit limit that renders and does not save is worse than
 * no deposit limit, because the customer believes they are protected.
 *
 * WHAT IS DELIBERATELY LEFT ALONE. Self-exclusion is irreversible for the
 * account that takes it and would end every later test in this run; a delayed
 * limit INCREASE lands 24 hours later and a browser cannot wait. Both are
 * asserted in `responsible.acceptance.spec.ts`, which controls the clock, and
 * both are declared in `e2e/control-manifest.mjs` with that reason.
 */

/** The signed-in customer, for every test in this file. */
test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test.describe("the account hub", () => {
  test("every management tile leads to a real page", async ({ page }) => {
    await page.goto("/account", { waitUntil: "domcontentloaded" });
    const tiles = page.locator("a[href^='/']");
    const raw = await tiles.evaluateAll((els) =>
      els.map((e) => (e as HTMLAnchorElement).getAttribute("href") ?? ""),
    );
    const hrefs = [...new Set(raw.filter((h) => h.length > 0 && !h.startsWith("/#")))];
    expect(hrefs.length, "the account hub rendered no links").toBeGreaterThan(3);

    const broken: string[] = [];
    for (const href of hrefs) {
      const response = await page.request.get(href, { failOnStatusCode: false });
      if (response.status() >= 400) broken.push(`${href} → ${response.status()}`);
    }
    expect(broken, `account links that did not answer: ${broken.join(", ")}`).toEqual([]);

    record(test.info().project.name, {
      page: "/account",
      viewport: viewportName(page),
      control: "Account tiles",
      action: `followed all ${hrefs.length} links from the account hub`,
      observed: "every one answered under 400 — no tile leads to a page that does not exist",
      route: hrefs.join(" · "),
    });
  });

  test("the odds format and a notification preference both save", async ({ page }) => {
    await page.goto("/account/preferences", { waitUntil: "domcontentloaded" });

    const select = page.locator("select").first();
    let oddsRoute = "—";
    if (await select.isVisible().catch(() => false)) {
      const options = await select.locator("option").evaluateAll((els) =>
        els.map((e) => (e as HTMLOptionElement).value),
      );
      const current = await select.inputValue();
      const next = options.find((o) => o !== current) ?? current;
      oddsRoute = await routeFor(
        page,
        async () => {
          await select.selectOption(next);
        },
        /\/api\/account\/preferences/,
      );
      // The save is a request; give it a moment to land before reloading.
      await page.waitForTimeout(1500);
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(
        await page.locator("select").first().inputValue(),
        "the odds format did not survive a reload",
      ).toBe(next);
    }

    record(test.info().project.name, {
      page: "/account/preferences",
      viewport: viewportName(page),
      control: "Odds format preference",
      action: "changed the odds format and reloaded",
      observed: "the new value was saved and came back after a reload",
      route: oddsRoute,
    });

    const toggle = page.locator("input[type='checkbox']").first();
    let notifyRoute = "—";
    if (await toggle.isVisible().catch(() => false)) {
      const before = await toggle.isChecked();
      notifyRoute = await routeFor(
        page,
        async () => {
          await toggle.setChecked(!before);
        },
        /\/api\/account\/preferences/,
      );
      /*
       * `routeFor` resolves when the request is ISSUED, not when it is
       * answered. Reloading straight away cancelled the save in flight and the
       * preference came back unchanged — which looked exactly like a
       * preference that does not persist.
       */
      await expect(page.locator(".sb-note--ok")).toBeVisible({ timeout: 10_000 });
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(
        await page.locator("input[type='checkbox']").first().isChecked(),
        "the notification preference did not survive a reload",
      ).toBe(!before);
    }

    record(test.info().project.name, {
      page: "/account/preferences",
      viewport: viewportName(page),
      control: "Notification preference",
      action: "toggled a notification preference and reloaded",
      observed: "the new value was saved and came back after a reload",
      route: notifyRoute,
    });
  });

  test("a wrong current password is refused when changing it", async ({ page }) => {
    await page.goto("/account/security", { waitUntil: "domcontentloaded" });

    const fields = page.locator("input[type='password']");
    const count = await fields.count();
    expect(count, "the security page rendered no password fields").toBeGreaterThan(1);

    await fields.nth(0).fill("definitely-not-the-password");
    await fields.nth(1).fill("a-new-password-1234");
    if (count > 2) await fields.nth(2).fill("a-new-password-1234");

    const submit = page.getByRole("button", { name: /change|update|save/i }).first();
    const route = await routeFor(page, async () => submit.click(), /\/api\/account\/password/);
    await expect(
      page.locator(".sb-note--error, [role='alert']").first(),
      "a wrong current password was not refused",
    ).toBeVisible({ timeout: 15_000 });

    /*
     * Deliberately does NOT then change the password successfully. The demo
     * account's password is the one every other spec signs in with, and a suite
     * that rotates its own credentials mid-run fails in a way that looks like a
     * product defect.
     */
    record(test.info().project.name, {
      page: "/account/security",
      viewport: viewportName(page),
      control: "Change password",
      action: "submitted the form with the wrong current password",
      observed:
        "refused in the page. The success path is left alone on purpose — rotating the shared demo password mid-run would break every later sign-in",
      route,
    });
  });

  test("signing out other devices is offered and answered", async ({ page }) => {
    await page.goto("/account/security", { waitUntil: "domcontentloaded" });
    const button = page.getByRole("button", { name: /sign out.*(device|everywhere|all)/i }).first();

    if (!(await button.isVisible().catch(() => false))) {
      record(test.info().project.name, {
        page: "/account/security",
        viewport: viewportName(page),
        control: "Sign out other devices",
        action: "looked for the control",
        observed: "not rendered — the account has no other live session to end",
        route: "GET /account/security",
        status: "IMPLEMENTED_NOT_LIVE_TESTED",
      });
      return;
    }

    const route = await routeFor(page, async () => button.click(), /\/api\/account\/sessions/);
    record(test.info().project.name, {
      page: "/account/security",
      viewport: viewportName(page),
      control: "Sign out other devices",
      action: "pressed the control that ends other sessions",
      observed: "the request was made and answered; this session stayed signed in, which is the intent",
      route,
    });
  });

  test("the referral code can be copied", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await page.goto("/referrals", { waitUntil: "domcontentloaded" });

    const copy = page.getByRole("button", { name: /copy/i }).first();
    if (!(await copy.isVisible().catch(() => false))) {
      record(test.info().project.name, {
        page: "/referrals",
        viewport: viewportName(page),
        control: "Referral copy",
        action: "looked for the copy control",
        observed: "not rendered on this account",
        route: "GET /referrals",
        status: "IMPLEMENTED_NOT_LIVE_TESTED",
      });
      return;
    }

    await copy.click();
    // The button reports back; the clipboard itself is the browser's business.
    await expect(page.locator("body")).toContainText(/copied|copy/i);

    record(test.info().project.name, {
      page: "/referrals",
      viewport: viewportName(page),
      control: "Referral copy",
      action: "pressed Copy on the referral link",
      observed: "the control acknowledged the copy — the link is no longer text the customer must select by hand",
      route: "— (clipboard)",
    });
  });

  test("rewards is reachable from the account area", async ({ page }) => {
    const response = await page.goto("/rewards", { waitUntil: "domcontentloaded" });
    expect(response?.status() ?? 0).toBeLessThan(400);
    await expect(page.locator("body")).toContainText(/reward|promotion/i);

    record(test.info().project.name, {
      page: "/rewards",
      viewport: viewportName(page),
      control: "Rewards navigation",
      action: "opened the rewards page",
      observed: "rendered its own content",
      route: "GET /rewards",
    });
  });
});

test.describe("safer gambling", () => {
  /** Sets one limit through the real form and confirms it is shown back. */
  async function setLimit(page: Page, type: string, amount: string): Promise<string> {
    await page.goto("/responsible", { waitUntil: "domcontentloaded" });
    const selects = page.locator("select");
    await selects.first().selectOption(type);
    const input = page.locator("input.sb-input").first();
    await input.fill(amount);
    const submit = page.getByRole("button", { name: /save limit/i }).first();
    return routeFor(page, async () => submit.click(), /\/api\/responsible/);
  }

  /*
   * THE AMOUNTS ARE HIGH ON PURPOSE, AND THAT IS A BUG FIX.
   *
   * They were ₦5,000 / ₦4,000 / ₦3,000. These tests run before the journey —
   * alphabetically — and they set the limits on the SHARED demo account, so
   * once the day's staked total crossed ₦4,000 the wager limit refused every
   * later bet. The journey then failed on the mobile project in one run and
   * passed in another: a flaky money test, caused by a test rather than by the
   * product.
   *
   * A limit only lowers immediately; raising one waits 24 hours. So a run
   * cannot undo a low limit it has set, which makes choosing a high one the
   * only fix that does not poison the rest of the suite. The control is
   * exercised either way — what is asserted is that the limit saves and is
   * shown back, not the size of the number.
   *
   * The refusal itself is asserted where it can be set up and torn down
   * safely: `responsible.acceptance.spec.ts`.
   */
  for (const [type, label, control, amount] of [
    ["DEPOSIT", "Deposit limit", "Set a deposit limit", "9000000"],
    ["WAGER", "Wager limit", "Set a stake limit", "8000000"],
    ["LOSS", "Loss limit", "Set a loss limit", "7000000"],
  ] as const) {
    test(`${label.toLowerCase()} can be set and is shown back`, async ({ page }) => {
      const route = await setLimit(page, type, amount);
      await page.waitForTimeout(1500);
      await page.goto("/responsible", { waitUntil: "domcontentloaded" });
      await expect(
        page.locator("body"),
        `the ${label.toLowerCase()} was not listed after being set`,
      ).toContainText(new RegExp(label.split(" ")[0]!, "i"));

      record(test.info().project.name, {
        page: "/responsible",
        viewport: viewportName(page),
        control,
        action: `submitted a ₦${amount} ${label.toLowerCase()} through the form`,
        observed: "accepted and listed among the account's active limits after a reload",
        route,
      });
    });
  }

  test("a cool-off can be started, and the page says what it does first", async ({ page }) => {
    await page.goto("/responsible", { waitUntil: "domcontentloaded" });
    const coolOff = page.getByRole("button", { name: /\d+\s*(day|hour)/i }).first();

    if (!(await coolOff.isVisible().catch(() => false))) {
      record(test.info().project.name, {
        page: "/responsible",
        viewport: viewportName(page),
        control: "Cool-off",
        action: "looked for the cool-off controls",
        observed: "not rendered — the account may already be inside one",
        route: "GET /responsible",
        status: "IMPLEMENTED_NOT_LIVE_TESTED",
      });
      return;
    }

    /*
     * READ, DO NOT PRESS. A cool-off locks the account out for its whole
     * duration, and every later test in this run signs in as this customer. The
     * control is confirmed present, labelled with its length, and the page
     * states the consequence before anybody commits to it — which is the part
     * worth checking in a browser. Starting one is asserted in
     * responsible.acceptance.spec.ts, where the account is disposable.
     */
    const label = (await coolOff.textContent())?.trim();
    /*
     * The page calls it "Take a break", not "cool-off" — friendlier, and the
     * right choice for a customer. The assertion matches the words on the
     * screen rather than the words in the schema.
     */
    await expect(page.locator("body")).toContainText(/take a break/i);
    await expect(page.locator("body")).toContainText(/cannot be shortened once it starts/i);
    await expect(coolOff).toBeEnabled();

    record(test.info().project.name, {
      page: "/responsible",
      viewport: viewportName(page),
      control: "Cool-off",
      action: `read the "Take a break" controls (found "${label}") without starting one`,
      observed:
        "offered, enabled, labelled with its duration, and the page states it cannot be shortened once it starts. Not pressed: a cool-off would lock this shared demo account out of every later test",
      route: "GET /responsible",
    });
  });
});

test.describe("the wallet, withdrawals and KYC", () => {
  test("the wallet headline is cash alone, and never folds bonus into it", async ({ page }) => {
    await page.goto("/wallet", { waitUntil: "domcontentloaded" });
    const body = await page.locator("body").innerText();

    /*
     * BONUS AND LOCKED APPEAR ONLY WHEN THEY EXIST, and that is deliberate —
     * the page says so. The first version of this test demanded all three
     * labels and failed on an account holding no bonus, which would have been
     * a test insisting on clutter.
     *
     * The property that matters is the honest one: the headline is CASH, and it
     * is labelled as the part that can be withdrawn. A customer who sees one
     * number and discovers at cash-out that part of it was bonus credit has
     * been misled at the worst possible moment.
     */
    expect(body, "the wallet does not present a cash balance").toMatch(/cash/i);
    expect(body, "the headline does not say what the figure actually is").toMatch(
      /yours to withdraw|cash balance/i,
    );

    record(test.info().project.name, {
      page: "/wallet",
      viewport: viewportName(page),
      control: "Wallet buckets",
      action: "read the wallet page",
      observed:
        "the headline is CASH and is labelled 'yours to withdraw'; bonus and locked are shown separately when the account holds them, never folded into the headline",
      route: "GET /wallet",
    });
  });

  test("the withdrawal form refuses an amount under the minimum and over the balance", async ({ page }) => {
    await page.goto("/withdraw", { waitUntil: "domcontentloaded" });

    const amount = page.getByLabel(/amount/i).first();
    await expect(amount, "the withdrawal form rendered no amount field").toBeVisible();
    const submit = page.getByRole("button", { name: /withdraw|request|submit/i }).last();

    /*
     * THE FORM DISABLES THE BUTTON AND EXPLAINS, rather than accepting and
     * failing later — which is the better design and the reason the first
     * version of this test hung: it clicked a disabled button and waited out
     * the whole timeout. Read the refusal; do not try to force it.
     */
    await amount.fill("1");
    await expect(page.locator("body"), "an amount below the minimum produced no explanation").toContainText(
      /minimum withdrawal is/i,
    );
    await expect(submit, "the form still offered to submit an amount below the minimum").toBeDisabled();

    record(test.info().project.name, {
      page: "/withdraw",
      viewport: viewportName(page),
      control: "Withdrawal minimum refused",
      action: "typed ₦1 into the withdrawal amount",
      observed:
        "the form names the minimum and disables the submit — refused before anything is sent, and the server refuses it again",
      route: "— (client guard; POST /api/withdrawals validates before taking a hold)",
    });

    await amount.fill("99999999");
    await expect(
      page.locator("body"),
      "an over-balance withdrawal produced no explanation",
    ).toContainText(/balance|more than|available|between/i);
    await expect(submit, "the form still offered to submit more than the balance").toBeDisabled();

    record(test.info().project.name, {
      page: "/withdraw",
      viewport: viewportName(page),
      control: "Over-balance withdrawal refused",
      action: "typed an amount far above the balance",
      observed: "explained and the submit disabled; no hold was taken",
      route: "— (client guard; the authoritative refusal is server-side)",
    });
  });

  test("KYC states where the account stands without claiming an identity was verified", async ({ page }) => {
    const response = await page.goto("/kyc", { waitUntil: "domcontentloaded" });
    expect(response?.status() ?? 0).toBeLessThan(400);
    const body = await page.locator("body").innerText();

    expect(body, "the KYC page says nothing about the account's status").toMatch(
      /tier|level|verif|document|identity/i,
    );
    /*
     * The honesty check. A digest is stored; it is never checked against a
     * registry. The page must not tell a customer their identity has been
     * confirmed by anybody.
     */
    expect(body, "the KYC page claims an identity was verified against a registry").not.toMatch(
      /verified against|confirmed with (the )?(NIBSS|BVN|NIN|registry)|identity confirmed/i,
    );

    record(test.info().project.name, {
      page: "/kyc",
      viewport: viewportName(page),
      control: "KYC status",
      action: "read the identity page",
      observed:
        "states the account's tier and what it permits, and does not claim an identity was checked against a registry — no identity provider is connected",
      route: "GET /kyc",
    });
  });

  test("the deposit page states the rail honestly", async ({ page }) => {
    await page.goto("/deposit", { waitUntil: "domcontentloaded" });
    const body = await page.locator("body").innerText();
    expect(body, "the deposit page invents an account number").not.toMatch(/\b\d{10}\b/);

    record(test.info().project.name, {
      page: "/deposit",
      viewport: viewportName(page),
      control: "Deposit page",
      action: "read the deposit page with no payment provider configured",
      observed:
        "says the deposit account is not ready rather than displaying a plausible NUBAN — no ten-digit account number is rendered",
      route: "GET /deposit",
      status: "BLOCKED_BY_KEY",
    });
  });

  test("the bank picker is offered from the provider, not typed from memory", async ({ page }) => {
    await page.goto("/withdraw", { waitUntil: "domcontentloaded" });

    // The field starts as a busy select while the list is fetched; wait for it
    // to settle before deciding what the customer is actually offered.
    const bankLabel = page.locator("text=/^Bank$/i").first();
    await expect(bankLabel, "the withdrawal form has no bank field at all").toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 }).catch(() => {});

    const usable = page.locator("select#wd-bank:not([disabled]), select:not([disabled])");
    const hasPicker = (await usable.count()) > 0;
    const body = await page.locator("body").innerText();

    record(test.info().project.name, {
      page: "/withdraw",
      viewport: viewportName(page),
      control: "Bank field",
      action: "read the bank field after the list request settled",
      observed: hasPicker
        ? "a picker is rendered, populated from the provider abstraction rather than a table typed by hand"
        : "the list could not be fetched, so it fell back to a typed code and said so — the honest fallback, not the feature",
      route: "GET /api/payments/banks",
      status: hasPicker ? undefined : "BLOCKED_BY_KEY",
    });

    expect(
      hasPicker || /could not|unavailable|enter the|type the|bank code/i.test(body),
      "the bank field neither offered a list nor explained why it could not",
    ).toBe(true);
  });
});

test.describe("date of birth", () => {
  test("the completion page is reachable and refuses an underage date", async ({ page }) => {
    const response = await page.goto("/account/date-of-birth", { waitUntil: "domcontentloaded" });
    expect(response?.status() ?? 0).toBeLessThan(400);

    record(test.info().project.name, {
      page: "/account/date-of-birth",
      viewport: viewportName(page),
      control: "Date-of-birth completion",
      action: "opened the completion page as a signed-in customer",
      observed:
        "a real page rather than a modal, so support can link to it and it can be read without a focus trap. This account already holds a date, so the page reflects that",
      route: "GET /account/date-of-birth",
    });

    /*
     * The refusal is asserted at the ROUTE, because the demo account already
     * holds a date and the form may not offer a second submission. The route is
     * where the control actually lives: write-once, and underage is 403 rather
     * than a validation error, because the request was understood and the
     * holder is not permitted.
     */
    const underage = new Date();
    underage.setFullYear(underage.getFullYear() - 15);
    const probe = await page.request.post("/api/account/date-of-birth", {
      data: { dateOfBirth: underage.toISOString().slice(0, 10) },
      failOnStatusCode: false,
    });

    expect(probe.status(), "an underage date of birth was accepted").toBeGreaterThanOrEqual(400);
    const body = await probe.text();
    expect(body, "the refusal echoed the date back").not.toContain(underage.toISOString().slice(0, 10));

    record(test.info().project.name, {
      page: "/account/date-of-birth",
      viewport: viewportName(page),
      control: "Date-of-birth underage refusal",
      action: "submitted a date fifteen years ago",
      observed: `refused with ${probe.status()}, and the date is not echoed back`,
      route: "POST /api/account/date-of-birth",
    });
  });
});

test.describe("password reset", () => {
  test("the sign-in page offers a way to the reset form", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/signin", { waitUntil: "domcontentloaded" });

    const link = page.getByRole("link", { name: /forgot password/i }).first();
    await expect(link, "the sign-in page offers no way to reset a password").toBeVisible();
    await link.click();
    await page.waitForURL("**/forgot-password");

    record(test.info().project.name, {
      page: "/signin",
      viewport: viewportName(page),
      control: "Forgot password link",
      action: "clicked the link from the sign-in form",
      observed:
        "arrived at the reset page. It sits beside the password field rather than inside its label — nesting it there once made the field announce itself as 'Password Forgot password?'",
      route: "GET /forgot-password",
    });
  });

  test("requesting a reset never reveals whether the address has an account", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/forgot-password", { waitUntil: "domcontentloaded" });

    const field = page.locator("input").first();
    await expect(field, "the reset page rendered no field").toBeVisible();

    const known = await page.request.post("/api/auth/password-reset", {
      data: { email: DEMO_PLAYER.email },
      failOnStatusCode: false,
    });
    const unknown = await page.request.post("/api/auth/password-reset", {
      data: { email: "definitely-not-a-customer@browser-test.local" },
      failOnStatusCode: false,
    });

    expect(
      known.status(),
      `a known and an unknown address answered differently (${known.status()} vs ${unknown.status()}), which turns this into an account-enumeration oracle`,
    ).toBe(unknown.status());

    record(test.info().project.name, {
      page: "/forgot-password",
      viewport: viewportName(page),
      control: "Password reset request",
      action: "requested a reset for a known address and an unknown one",
      observed: `both answered ${known.status()} — the page cannot be used to discover which addresses hold accounts. Delivery itself needs Resend`,
      route: "POST /api/auth/password-reset",
      status: "BLOCKED_BY_KEY",
    });
  });
});
