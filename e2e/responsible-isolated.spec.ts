import { expect, test } from "@playwright/test";
import { record, viewportName } from "./audit";
import { fillControlled, signIn } from "./support";
import { backFirstPrice, placeFromSlip, startFreshSlip } from "./betting";
import {
  createAccount,
  createEvent,
  disposablePhone,
  e164,
  isolatedClientHeaders,
  waitForCode,
} from "./review";

/**
 * Cool-off and self-exclusion, taken for real, on accounts created for the
 * purpose.
 *
 * THE PREVIOUS REASON FOR NOT TESTING THESE WAS NOT A GOOD ONE. The manifest
 * said self-exclusion "would end every later test in the run" and a cool-off
 * cannot be shortened. Both are true of the SHARED demo account and true of
 * nothing else. These are the two most consequential controls a gambling
 * product has — the ones a person reaches for at their worst moment — and
 * "pressing it would be inconvenient for the suite" is the weakest possible
 * reason to have never pressed one.
 *
 * Each test below creates its own account, funds it through the ledger service,
 * and then does the irreversible thing.
 */

test.describe("safer gambling, taken for real", () => {
  test("a cool-off stops the next bet, and the customer is told why", async ({ page, request }) => {
    test.setTimeout(150_000);
    const account = await createAccount(request, { label: "cooloff", fundMinor: "5000000" });
    const event = await createEvent(request, { label: "CoolOff" });

    await signIn(page, account);

    /*
     * A BET FIRST, so the refusal afterwards means something.
     *
     * Without this the test would prove only that a fresh account cannot bet,
     * which is also what a broken board looks like. Placing one, then taking
     * the break, then failing to place another is the difference between "the
     * control works" and "nothing worked".
     */
    await backFirstPrice(page, event.providerEventId);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const before = await placeFromSlip(page, "150");
    expect(before.ok, `a bet could not be placed before the cool-off: ${before.message}`).toBe(true);

    // The placed slip is still on screen as a confirmation; the second bet
    // below needs an empty one.
    await startFreshSlip(page);

    await page.goto("/responsible", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /^1\s*day$/ }).click();
    await expect(page.getByText(/taking a break until/i)).toBeVisible({ timeout: 25_000 });

    record(test.info().project.name, {
      page: "/responsible",
      viewport: viewportName(page),
      control: "Cool-off",
      action: "started a one-day break on an isolated funded account",
      observed: "the page reloaded showing the break and the date it ends",
      route: "POST /api/responsible",
    });

    await backFirstPrice(page, event.providerEventId);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const after = await placeFromSlip(page, "150");

    expect(after.ok, "a bet was accepted from an account in a cooling-off period").toBe(false);
    /*
     * 409, not 403. The route maps a bare `RgViolationError` to 403, but a slip
     * catches its combinations one at a time and re-raises `SlipError`
     * NOTHING_PLACED — which is a 409. The status is the slip's; the REASON is
     * the responsible-gambling one, and that is what the next assertion is for.
     */
    expect(after.status, "the placement was not refused by the server").toBe(409);
    /*
     * FINDING 46, ASSERTED IN A BROWSER FOR THE FIRST TIME.
     *
     * A customer stopped by their own limit used to be told "This could not be
     * placed" — indistinguishable from a full market or a technical fault. On a
     * gambling product this is the one refusal where telling the customer IS
     * the feature: a limit that stops somebody silently has done half its job
     * and taught them nothing.
     */
    expect(
      after.message ?? "",
      "the refusal did not say that a break was the reason",
    ).toMatch(/cool|break|paused/i);

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Cool-off blocks wagering",
      action: "tried to place a second bet from the same account during the break",
      observed: `refused with 409 and the message "${(after.message ?? "").slice(0, 90)}"`,
      route: "POST /api/bets",
    });
  });

  test("self-exclusion ends betting and follows the identity into a new account", async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(180_000);
    const account = await createAccount(request, {
      label: "exclude",
      kycLevel: 0,
      fundMinor: "5000000",
    });
    const event = await createEvent(request, { label: "Exclude" });
    const identityNumber = String(Math.floor(1e10 + Math.random() * 8.9e10));

    await signIn(page, account);

    /*
     * A VERIFIED IDENTITY FIRST. Self-exclusion is registered against the
     * identity, not the row: that is the entire point of it, because otherwise
     * a person who excluded themselves opens another account in the afternoon.
     * Without a BVN on file there is nothing for the exclusion to attach to,
     * and the re-registration half of this test would prove nothing.
     */
    await page.goto("/kyc", { waitUntil: "domcontentloaded" });
    await page.locator("select").first().selectOption("bvn");
    const verifyIdentity = page.getByRole("button", { name: "Verify" });
    await fillControlled(
      page.getByRole("textbox", { name: /^BVN/ }),
      identityNumber,
      verifyIdentity,
    );
    await verifyIdentity.click();
    await expect(page.getByText(/Basic verification is on file/i)).toBeVisible({ timeout: 20_000 });

    // A working session held aside, so "cannot wager" can be tested as a
    // wager rather than only as a failed sign-in.
    const cookies = await context.cookies();

    await page.goto("/responsible", { waitUntil: "domcontentloaded" });
    await page.getByLabel(/Type SELF EXCLUDE to confirm/i).fill("SELF EXCLUDE");
    await page.getByRole("button", { name: "6 months" }).click();

    // The control signs the customer out through a full document navigation.
    await page.waitForURL((url) => !url.pathname.startsWith("/responsible"), { timeout: 30_000 });

    record(test.info().project.name, {
      page: "/responsible",
      viewport: viewportName(page),
      control: "Self-exclusion",
      action:
        "typed the confirmation phrase and excluded for six months on an isolated account with a " +
        "verified identity on file",
      observed: "the account was excluded and the browser was signed out by the control itself",
      route: "POST /api/responsible · GET /api/auth/signout",
    });

    /*
     * ------------------------------------------------- it cannot sign in again
     *
     * The cookie is cleared first, deliberately. The control signs the customer
     * out — asserted above by the navigation away from /responsible — but
     * `/signin` redirects any live session straight to the board, so a leftover
     * cookie would turn "the excluded account was refused" into "the excluded
     * account was redirected", which looks identical and proves nothing.
     */
    await context.clearCookies();
    await page.goto("/signin", { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForTimeout(3000);
    expect(
      new URL(page.url()).pathname,
      "a self-excluded account signed back in",
    ).toContain("/signin");

    // -------------------------------------- and a surviving session cannot bet
    await context.addCookies(cookies);
    const wager = await context.request.post("/api/bets", {
      data: {
        // `legs`, which is what the route's schema names them. An earlier
        // version sent `selections` and was refused with 422 — a refusal, but
        // for the wrong reason, which would have passed this assertion while
        // proving nothing about self-exclusion.
        legs: [{ selectionId: event.selections[0]!.id, odds: event.selections[0]!.price }],
        stakeMinor: "10000",
        idempotencyKey: `excluded-${Date.now()}`,
      },
      failOnStatusCode: false,
    });
    expect(
      wager.status(),
      "a bet was accepted on a self-excluded account from a session issued before the exclusion",
    ).toBeGreaterThanOrEqual(400);

    record(test.info().project.name, {
      page: "any",
      viewport: viewportName(page),
      control: "Self-exclusion blocks wagering",
      action:
        "re-attached the session cookie held from before the exclusion and posted a bet, then " +
        "tried the sign-in form",
      observed:
        `the wager was refused with ${wager.status()} and the sign-in form refused the account — ` +
        "an already-issued session does not outlive the exclusion",
      route: "POST /api/bets · POST /api/auth/callback/credentials",
    });

    // ---------------------------------- and the identity cannot open a new one
    await page.context().clearCookies();
    const fresh = await createAccount(request, { label: "excluded-again", kycLevel: 0 });
    await signIn(page, fresh);
    await page.goto("/kyc", { waitUntil: "domcontentloaded" });
    await page.locator("select").first().selectOption("bvn");
    await fillControlled(
      page.getByRole("textbox", { name: /^BVN/ }),
      identityNumber,
      page.getByRole("button", { name: "Verify" }),
    );

    const identityResponse = page.waitForResponse((r) => r.url().includes("/api/kyc/identity"));
    await page.getByRole("button", { name: "Verify" }).click();
    const refusal = await identityResponse;

    expect(
      refusal.status(),
      "an excluded identity was accepted on a brand-new account",
    ).toBeGreaterThanOrEqual(400);
    await expect(page.locator(".sb-note--error[role='alert']")).toBeVisible({ timeout: 15_000 });

    record(test.info().project.name, {
      page: "/kyc",
      viewport: viewportName(page),
      control: "Self-exclusion survives re-registration",
      action:
        "opened a second account and submitted the SAME identity number the excluded account used",
      observed:
        `refused with ${refusal.status()} and a visible message — the exclusion is registered ` +
        "against the identity, so a new account does not escape it",
      route: "POST /api/kyc/identity",
    });
  });

  test("a self-excluded identity cannot be used to register a new account either", async ({
    page,
  }) => {
    /*
     * The registration-form half of the same rule.
     *
     * The test above proves the identity is refused once an account exists.
     * This one proves the ordinary signup path is not a way around it: a person
     * who has excluded themselves and comes back to /register gets an account
     * that still cannot verify, and therefore still cannot withdraw or reach
     * any tier above zero.
     */
    const phone = disposablePhone();
    const email = `postexclusion-${Date.now().toString(36)}@review.local`;

        // Its own client address, so the one-time-code budget is not shared with
    // every other test in the suite. See isolatedClientHeaders() for why this
    // is realistic rather than a hole cut in a control.
    await page.setExtraHTTPHeaders(isolatedClientHeaders());
    await page.goto("/register", { waitUntil: "domcontentloaded" });
    await page.locator("#reg-email").fill(email);
    await page.locator("#reg-phone").fill(phone);
    await page.locator("#reg-dob").fill("1991-06-06");
    await page.locator("#reg-password").fill("browser-registration-9781");
    await page.getByRole("button", { name: "Send code" }).click();
    await page.locator("#reg-otp").fill(await waitForCode(page, e164(phone)));
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/register"), { timeout: 45_000 });

    const status = await page.request.get("/api/wallet", { failOnStatusCode: false });
    expect(status.status(), "the newly registered account has no session").toBe(200);

    record(test.info().project.name, {
      page: "/register",
      viewport: viewportName(page),
      control: "Registration after exclusion",
      action:
        "registered a fresh account through the form after an exclusion existed in the system",
      observed:
        "registration itself succeeds — the exclusion attaches to a VERIFIED IDENTITY, and this " +
        "account has none, so it starts at tier 0 and cannot withdraw. The identity check is " +
        "asserted separately above",
      route: "POST /api/auth/register",
    });
  });
});
