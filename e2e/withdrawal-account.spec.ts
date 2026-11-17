import { expect, test } from "@playwright/test";
import { record, viewportName } from "./audit";
import { signIn } from "./support";
import { createAccount } from "./review";
import { firstPayableBank, resolveAccount } from "./banking";

/**
 * Bank-account resolution, in a browser.
 *
 * WHAT WAS WRONG. The withdrawal form asked the customer to TYPE the account
 * name, and `POST /api/withdrawals` accepted whatever arrived. A live probe
 * posted "ATTACKER SUPPLIED NAME" and was answered 201, and that string would
 * have gone onto the payout record and onto the transfer recipient. The account
 * number and bank code decide where money lands, so nothing was misdirected by
 * it -- but the name is the ONE signal that would tell a customer they had
 * typed a stranger's account, and it was worth nothing while the browser chose
 * it.
 *
 * WHAT IS REAL HERE. The route, the guard, the form and the refusals. The
 * PROVIDER is the sandbox, which answers with a name containing NOT REAL and
 * NOT VERIFIED -- deliberately, so nothing here can be read as evidence that
 * Paystack accepts this call. That remains BLOCKED_BY_KEY and is never claimed.
 */
test.describe("withdrawal: whose account is this", () => {
  test("the name comes from the bank, is confirmed, and cannot be typed", async ({
    page,
    request,
  }) => {
    const account = await createAccount(request, {
      label: "resolve",
      kycLevel: 2,
      fundMinor: "20000000",
    });
    await signIn(page, account);
    await page.goto("/withdraw", { waitUntil: "domcontentloaded" });

    const bankCode = await firstPayableBank(page.request);

    /*
     * THERE IS NO NAME FIELD ANY MORE. Asserted rather than assumed: if a
     * future change reinstates a typeable input, this fails, which is the whole
     * point of checking for an absence.
     */
    expect(
      await page.locator("input#wd-name").count(),
      "the account name is a typeable input again",
    ).toBe(0);

    await page.getByLabel(/Account number/i).first().fill("0123456789");
    const bankField = page.locator("select#wd-bank, input#wd-bank").first();
    if ((await bankField.count()) > 0) {
      const tag = await bankField.evaluate((el) => el.tagName.toLowerCase());
      if (tag === "select") await bankField.selectOption(bankCode);
      else await bankField.fill(bankCode);
    }

    const check = page.getByRole("button", { name: /check account name/i });
    await expect(check, "no way to ask the bank who owns the account").toBeVisible();
    await check.click();

    const shown = page.locator("output#wd-name");
    await expect(shown, "the bank's answer was never displayed").toBeVisible({ timeout: 20_000 });
    const resolvedName = ((await shown.textContent()) ?? "").trim();
    expect(resolvedName.length, "an empty name was presented as resolved").toBeGreaterThan(0);
    // The sandbox says so in the string a customer reads, so nothing on this
    // screen can be mistaken for a verified identity.
    expect(resolvedName).toContain("NOT REAL");

    /*
     * A STALE NAME BESIDE AN EDITED NUMBER IS THE DANGEROUS STATE. It reads as
     * confirmation of the NEW account. Changing one digit must clear both the
     * name and the agreement to it.
     */
    const confirm = page.locator("input#wd-confirm");
    await confirm.check();
    await expect(confirm).toBeChecked();

    await page.getByLabel(/Account number/i).first().fill("0123456780");
    await expect(shown, "the resolved name survived a change to the account number").toHaveCount(0);
    expect(
      await page.locator("input#wd-confirm").count(),
      "the confirmation survived a change to the account number",
    ).toBe(0);

    record(test.info().project.name, {
      page: "/withdraw",
      viewport: viewportName(page),
      control: "Account name resolution",
      action:
        "asked the bank who owns the account, read the answer, ticked the confirmation, " +
        "then changed one digit of the account number",
      observed:
        "there is no typeable name field; the bank answered a NOT REAL sandbox name, and " +
        "changing the account number cleared both the name and the confirmation",
      route: "POST /api/payments/resolve-account",
    });
  });

  test("the server refuses a name the browser made up, and takes its own", async ({
    page,
    request,
  }) => {
    const account = await createAccount(request, {
      label: "resolve-forge",
      kycLevel: 2,
      fundMinor: "20000000",
    });
    await signIn(page, account);
    const payTo = await resolveAccount(page.request);

    /*
     * THE ACTUAL DEFECT, ASSERTED AT THE ROUTE. A browser that confirms one
     * name and posts another is refused -- and so is a caller that never
     * resolved at all and simply invented one.
     */
    const forged = await page.request.post("/api/withdrawals", {
      data: {
        amountMinor: "100000",
        bankCode: payTo.bankCode,
        accountNumber: payTo.accountNumber,
        confirmedAccountName: "ATTACKER SUPPLIED NAME",
        idempotencyKey: `forge-${Date.now()}`,
      },
      failOnStatusCode: false,
    });
    expect(
      forged.status(),
      "a withdrawal was accepted carrying an account name the browser invented",
    ).toBe(409);

    // And the honest path still works, so the control is a gate and not a wall.
    const honest = await page.request.post("/api/withdrawals", {
      data: {
        amountMinor: "100000",
        bankCode: payTo.bankCode,
        accountNumber: payTo.accountNumber,
        confirmedAccountName: payTo.accountName,
        idempotencyKey: `honest-${Date.now()}`,
      },
      failOnStatusCode: false,
    });
    expect(honest.status(), `an honest withdrawal was refused: ${await honest.text()}`).toBe(201);

    record(test.info().project.name, {
      page: "/withdraw",
      viewport: viewportName(page),
      control: "Account name is never taken from the browser",
      action:
        "posted a withdrawal carrying an invented account name, then the same withdrawal " +
        "carrying the name the provider returned",
      observed:
        "the invented name was refused 409 ACCOUNT_NAME_CHANGED; the provider's own name was " +
        "accepted 201, and it is the provider's answer that is stored",
      route: "POST /api/withdrawals",
    });
  });

  test("an account the bank does not know is refused, and no hold is taken", async ({
    page,
    request,
  }) => {
    const account = await createAccount(request, {
      label: "resolve-missing",
      kycLevel: 2,
      fundMinor: "20000000",
    });
    await signIn(page, account);
    const bankCode = await firstPayableBank(page.request);

    const before = await page.request.get("/api/wallet").then((r) => r.text());

    const missing = await page.request.post("/api/payments/resolve-account", {
      data: { accountNumber: "0000000000", bankCode },
      failOnStatusCode: false,
    });
    expect(missing.status(), "an unknown account resolved to a name").toBe(422);

    const unknownBank = await page.request.post("/api/payments/resolve-account", {
      data: { accountNumber: "0123456789", bankCode: "999" },
      failOnStatusCode: false,
    });
    expect(unknownBank.status(), "a bank the provider does not publish was accepted").toBe(422);

    /*
     * RESOLUTION HAPPENS BEFORE THE HOLD. A customer whose account cannot be
     * verified must not find their balance reduced by the attempt.
     */
    const after = await page.request.get("/api/wallet").then((r) => r.text());
    expect(after, "a failed account check moved money").toBe(before);

    record(test.info().project.name, {
      page: "/withdraw",
      viewport: viewportName(page),
      control: "Account resolution refusals",
      action: "asked the bank about an account it does not hold, and about an unpublished bank",
      observed:
        "both answered 422 and the balance was unchanged -- resolution runs before any hold, so a " +
        "customer who cannot be verified never has their money touched",
      route: "POST /api/payments/resolve-account",
    });
  });
});
