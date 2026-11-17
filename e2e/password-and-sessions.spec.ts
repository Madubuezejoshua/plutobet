import { expect, test } from "@playwright/test";
import { record, viewportName } from "./audit";
import { signIn } from "./support";
import { createAccount, isolatedClientHeaders, waitForCode } from "./review";

/**
 * The three controls that decide who can get back into an account: resetting a
 * forgotten password, changing a known one, and throwing another device out.
 *
 * EVERY TEST HERE USES AN ACCOUNT CREATED SECONDS EARLIER. All three are
 * irreversible for whoever performs them — a reset signs every device out, a
 * change signs every OTHER device out, a revocation kills a session — and the
 * previous pass used that as the reason not to press them. It is not a reason;
 * it is a shared-fixture problem, and the answer is a fresh account, not a
 * paragraph of explanation next to an untested control.
 */

test.describe("password reset", () => {
  test("a forgotten password is reset and the new one signs in", async ({ page, request }) => {
    const account = await createAccount(request, { label: "reset" });
    const newPassword = "reset-by-browser-4413";

        // Its own client address, so the one-time-code budget is not shared with
    // every other test in the suite. See isolatedClientHeaders() for why this
    // is realistic rather than a hole cut in a control.
    await page.setExtraHTTPHeaders(isolatedClientHeaders());
    await page.goto("/forgot-password", { waitUntil: "domcontentloaded" });
    await page.locator("#reset-email").fill(account.email);
    await page.getByRole("button", { name: "Send reset code" }).click();

    await expect(page.locator("#reset-code")).toBeVisible();

    const code = await waitForCode(page, account.email);
    await page.locator("#reset-code").fill(code);
    await page.locator("#reset-new").fill(newPassword);
    await page.locator("#reset-confirm").fill(newPassword);
    await page.getByRole("button", { name: "Reset password" }).click();

    await expect(page.getByText(/password has been reset/i)).toBeVisible({ timeout: 20_000 });

    /*
     * THE OLD PASSWORD MUST STOP WORKING, and that is asserted before the new
     * one is tried. A reset that sets a new password without invalidating the
     * old one is the failure mode worth catching, and it would be invisible in
     * a test that only checked the happy path.
     */
    await page.goto("/signin", { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForTimeout(2500);
    expect(new URL(page.url()).pathname, "the OLD password still signed in").toContain("/signin");

    await signIn(page, { email: account.email, password: newPassword });
    const wallet = await page.request.get("/api/wallet", { failOnStatusCode: false });
    expect(wallet.status(), "the NEW password did not produce a working session").toBe(200);

    record(test.info().project.name, {
      page: "/forgot-password",
      viewport: viewportName(page),
      control: "Password reset completed",
      action:
        "requested a reset code on an isolated account, read it from the review mailbox, set a " +
        "new password, then tried both passwords at the sign-in form",
      observed:
        "the old password was refused and left the browser on /signin; the new one signed in and " +
        "/api/wallet answered 200",
      route: "POST /api/auth/password-reset · PUT /api/auth/password-reset",
    });
  });
});

test.describe("account security", () => {
  test("a password change from the account page succeeds and the new one works", async ({
    page,
    request,
  }) => {
    const account = await createAccount(request, { label: "pwchange" });
    const newPassword = "changed-in-the-browser-7712";

    await signIn(page, account);
    await page.goto("/account/security", { waitUntil: "domcontentloaded" });

    /*
     * BY ANCHORED REGEX, because the hint text lives inside the label: the
     * accessible name is "New password At least 10 characters…", so an exact
     * match finds nothing. Anchoring at the start is what keeps "New password"
     * from also matching "Confirm new password".
     */
    await page.getByLabel(/^Current password/).fill(account.password);
    await page.getByLabel(/^New password/).fill(newPassword);
    await page.getByLabel(/^Confirm new password/).fill(newPassword);
    await page.getByRole("button", { name: "Change password" }).click();

    await expect(page.getByText(/password changed/i)).toBeVisible({ timeout: 20_000 });

    // The device that made the change stays signed in. That is the documented
    // behaviour and the one a customer would be most annoyed to lose.
    const wallet = await page.request.get("/api/wallet", { failOnStatusCode: false });
    expect(wallet.status(), "the changing device was signed out of its own session").toBe(200);

    // And the new password is the one that works from a clean context.
    await page.context().clearCookies();
    await signIn(page, { email: account.email, password: newPassword });
    expect((await page.request.get("/api/wallet", { failOnStatusCode: false })).status()).toBe(200);

    record(test.info().project.name, {
      page: "/account/security",
      viewport: viewportName(page),
      control: "Change password — accepted",
      action: "changed the password of an isolated account through the form, then signed in again",
      observed:
        "the change succeeded, the device that made it kept its session, and the new password " +
        "signed in from a cleared browser context",
      route: "POST /api/account/password",
    });
  });

  test("revoking another device stops that device's next request", async ({ page, browser, request }) => {
    const account = await createAccount(request, { label: "revoke" });

    /*
     * TWO REAL BROWSER CONTEXTS, not two fetches.
     *
     * A revoked session is downgraded on its NEXT request, so the claim is
     * about what a second browser experiences afterwards — which needs a
     * second browser holding its own cookie jar. The previous pass called this
     * an integration boundary on the grounds that a browser can only observe
     * the effect one request later. Observing the effect one request later IS
     * the control; that is what the customer who pressed the button is buying.
     */
    const second = await browser.newContext();
    const otherDevice = await second.newPage();
    await signIn(otherDevice, account);
    expect(
      (await otherDevice.request.get("/api/wallet", { failOnStatusCode: false })).status(),
      "the second device never had a working session",
    ).toBe(200);

    await signIn(page, account);
    await page.goto("/account/security", { waitUntil: "domcontentloaded" });

    const signOutButtons = page.getByRole("button", { name: "Sign out", exact: true });
    const revokeAll = page.getByRole("button", { name: /Sign out all other devices/ });

    let control: string;
    if ((await signOutButtons.count()) > 0) {
      await signOutButtons.first().click();
      control = "Sign out one device";
    } else {
      // The list groups by device signature, so two headless contexts can look
      // like one device. Revoking all others reaches the same session and is
      // the control a customer would use in that situation anyway.
      await expect(revokeAll).toBeVisible();
      await revokeAll.click();
      control = "Sign out other devices";
    }
    await page.waitForTimeout(2000);

    // This device is untouched.
    expect(
      (await page.request.get("/api/wallet", { failOnStatusCode: false })).status(),
      "revoking another device signed this one out too",
    ).toBe(200);

    // The other one is not.
    const after = await otherDevice.request.get("/api/wallet", { failOnStatusCode: false });
    expect(
      after.status(),
      `the revoked device's next request still succeeded (${after.status()})`,
    ).toBeGreaterThanOrEqual(400);

    await second.close();

    record(test.info().project.name, {
      page: "/account/security",
      viewport: viewportName(page),
      control: "Session revocation refresh",
      action:
        `signed the same isolated account in from two browser contexts, then used "${control}" ` +
        "in the first",
      observed:
        `the revoked context's next call to /api/wallet answered ${after.status()}, while the ` +
        "revoking context still answered 200",
      route: "DELETE /api/account/sessions",
    });
  });
});
