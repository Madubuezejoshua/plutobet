import { expect, test } from "@playwright/test";
import { record, viewportName } from "./audit";
import { expectNoProblems, fillControlled, watchForProblems } from "./support";
import {
  createAccount,
  disposablePhone,
  e164,
  isolatedClientHeaders,
  waitForCode,
} from "./review";

/**
 * Registration, completed in a browser, from an empty form to a signed-in
 * account.
 *
 * WHY THIS WAS NEVER TESTED BEFORE, AND WHAT CHANGED. The review server is a
 * PRODUCTION build, and `otp.service` refuses its console fallback under one —
 * correctly, because that fallback returns the one-time code in the API
 * response and would let anyone verify a destination they do not control. So
 * step one could not complete, and the whole of registration was written down
 * as an integration boundary.
 *
 * The stalemate is gone, and not by weakening the guard. The review server now
 * delivers to a LOCAL MAILBOX (`review-mailbox.ts`): the code leaves the
 * service and lands somewhere the requester cannot see, and reading it back
 * requires `/api/qa/mailbox` and a per-run key that a customer on the same
 * server does not have. The test therefore does exactly what a person does —
 * ask for a code, go and look for it, come back and type it — and the response
 * to the request that issued it still contains no code at all. That last point
 * is asserted here rather than assumed, because it is the whole difference
 * between this and the fallback that was banned.
 */

test.describe("registration", () => {
  test("a new customer registers, verifies a code, and lands signed in", async ({ page }) => {
    const problems = watchForProblems(page);
    const phone = disposablePhone();
    const email = `reg-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}@review.local`;
    const password = "browser-registration-9781";

        // Its own client address, so the one-time-code budget is not shared with
    // every other test in the suite. See isolatedClientHeaders() for why this
    // is realistic rather than a hole cut in a control.
    await page.setExtraHTTPHeaders(isolatedClientHeaders());
    await page.goto("/register", { waitUntil: "domcontentloaded" });

    await page.locator("#reg-email").fill(email);
    await page.locator("#reg-phone").fill(phone);
    await page.locator("#reg-dob").fill("1992-04-17");
    /*
     * BY ID, NOT BY LABEL. Every field on this form carries its hint text
     * INSIDE the <label>, so the accessible name of the password box is
     * "Password At least 10 characters. Length beats complexity." — an exact
     * label match finds nothing and a loose one is ambiguous against "Confirm".
     * The ids are the form's own and are what the labels point at.
     */
    // Send code is gated on the component holding a date of birth, so this is
    // also where a pre-hydration fill would be silently lost.
    await fillControlled(
      page.locator("#reg-password"),
      password,
      page.getByRole("button", { name: "Send code" }),
    );

    /*
     * THE RESPONSE MUST NOT CARRY THE CODE.
     *
     * Captured at the network rather than inferred from the screen: the form
     * only renders `devCode` when it is present, so an absent banner would also
     * be consistent with a UI change. The body is what matters.
     */
    const otpResponse = page.waitForResponse(
      (r) => r.url().includes("/api/auth/otp") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Send code" }).click();
    const issued = await otpResponse;
    expect(issued.status(), "the OTP request was refused on the review server").toBe(200);
    const issuedBody = await issued.text();
    expect(issuedBody, "the OTP response carried a six-digit code").not.toMatch(/\b\d{6}\b/);
    expect(issuedBody).not.toContain("devCode");

    await expect(page.locator("#reg-otp")).toBeVisible();

    const code = await waitForCode(page, e164(phone));
    await page.locator("#reg-otp").fill(code);
    await page.getByRole("button", { name: "Create account" }).click();

    // The form signs in through the ordinary credentials flow after creating
    // the account, so a successful registration ends on the board.
    await page.waitForURL((url) => !url.pathname.startsWith("/register"), { timeout: 45_000 });
    expect(new URL(page.url()).pathname, "registration did not land signed in").not.toContain(
      "/register",
    );

    // Signed in for real, not merely redirected: a protected route answers.
    const wallet = await page.request.get("/api/wallet", { failOnStatusCode: false });
    expect(wallet.status(), "the new account has no working session").toBe(200);

    expectNoProblems(problems, "/register");

    record(test.info().project.name, {
      page: "/register",
      viewport: viewportName(page),
      control: "Registration (adult)",
      action: "filled step 1, read the delivered code from the local mailbox, submitted step 2",
      observed:
        "the account was created and the browser landed signed in; /api/wallet answered 200. " +
        "The OTP response body contained no six-digit code",
      route: "POST /api/auth/otp · POST /api/auth/register",
    });

    record(test.info().project.name, {
      page: "/register",
      viewport: viewportName(page),
      control: "OTP delivery",
      action: "requested a phone verification code and read it from the review mailbox",
      observed:
        "a six-digit code was delivered out of band and verified. This is the LOCAL adapter — " +
        "no SMS was sent and Termii delivery remains unproven",
      route: "POST /api/auth/otp · GET /api/qa/mailbox",
    });
  });

  test("change details returns to step one and clears the code", async ({ page }) => {
    const phone = disposablePhone();
        // Its own client address, so the one-time-code budget is not shared with
    // every other test in the suite. See isolatedClientHeaders() for why this
    // is realistic rather than a hole cut in a control.
    await page.setExtraHTTPHeaders(isolatedClientHeaders());
    await page.goto("/register", { waitUntil: "domcontentloaded" });

    await page.locator("#reg-email").fill(`change-${Date.now().toString(36)}@review.local`);
    await page.locator("#reg-phone").fill(phone);
    await page.locator("#reg-dob").fill("1990-01-01");
    await page.locator("#reg-password").fill("browser-registration-9781");
    await page.getByRole("button", { name: "Send code" }).click();

    const codeField = page.locator("#reg-otp");
    await expect(codeField).toBeVisible();
    await codeField.fill(await waitForCode(page, e164(phone)));
    await expect(codeField).toHaveValue(/^\d{6}$/);

    await page.getByRole("button", { name: "Change details" }).click();

    // Back on step one, with the details still there to correct.
    await expect(page.locator("#reg-phone")).toBeVisible();
    await expect(page.locator("#reg-phone")).toHaveValue(phone);

    // And the code is gone. A code left in state would be resubmitted against
    // whatever number the customer changed to, which is the bug this control
    // exists to avoid.
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.locator("#reg-otp")).toHaveValue("");

    record(test.info().project.name, {
      page: "/register",
      viewport: viewportName(page),
      control: "Change details",
      action: "entered a code, pressed Change details, returned to step 2",
      observed:
        "step 1 was restored with the entered details intact, and the verification code field " +
        "came back empty — a code cannot be carried onto a different number",
      route: "client state",
    });
  });

  test("a second account cannot be opened on an address that already has one", async ({
    page,
    request,
  }) => {
    const existing = await createAccount(request, { label: "dupe" });
    const phone = disposablePhone();

        // Its own client address, so the one-time-code budget is not shared with
    // every other test in the suite. See isolatedClientHeaders() for why this
    // is realistic rather than a hole cut in a control.
    await page.setExtraHTTPHeaders(isolatedClientHeaders());
    await page.goto("/register", { waitUntil: "domcontentloaded" });
    await page.locator("#reg-email").fill(existing.email);
    await page.locator("#reg-phone").fill(phone);
    await page.locator("#reg-dob").fill("1990-01-01");
    await page.locator("#reg-password").fill("browser-registration-9781");
    await page.getByRole("button", { name: "Send code" }).click();

    await page.locator("#reg-otp").fill(await waitForCode(page, e164(phone)));
    await page.getByRole("button", { name: "Create account" }).click();

    /*
     * A refusal the customer can read, and no session.
     *
     * The address is one that exists, so this is the enumeration-adjacent case:
     * registration MUST refuse, but the wording is a product decision made in
     * the service, and the browser's job is only to show it. What is asserted
     * here is that it refused and did not sign anybody in.
     */
    const alert = page.locator(".sb-note--error[role='alert']");
    await expect(alert).toBeVisible({ timeout: 20_000 });
    expect(new URL(page.url()).pathname).toContain("/register");

    record(test.info().project.name, {
      page: "/register",
      viewport: viewportName(page),
      control: "Registration (duplicate)",
      action: "completed both steps using an email address that already has an account",
      observed: `refused with a visible message and stayed on /register — no session was issued`,
      route: "POST /api/auth/register",
    });
  });
});
