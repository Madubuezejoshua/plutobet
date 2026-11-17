import { expect, test } from "@playwright/test";
import { record, viewportName } from "./audit";
import { signIn } from "./support";
import { createAccount } from "./review";
import { resolveAccount } from "./banking";

/**
 * The two refusals that decide whether money can leave: the KYC tier, and the
 * rolling daily cap.
 *
 * WHY EACH TEST OWNS AN ACCOUNT. "Requires an account at a specific KYC tier
 * with a specific day's history" was the previous reason for calling this an
 * integration boundary, and it is a correct description of the difficulty and a
 * poor reason not to do it. Constructing that state is three lines now, and the
 * refusal a customer actually sees — in the form, before the request, and again
 * from the server if they get past it — is not something an acceptance test on
 * the service can show.
 *
 * The caps come from `DEFAULT_WITHDRAWAL_LIMITS`: tier 0 cannot withdraw at
 * all, tier 1 is ₦50,000 a day, tier 2 is ₦500,000, tier 3 is ₦5,000,000.
 */

const TIER_1_CAP_MINOR = 5_000_000n; // ₦50,000

test.describe("withdrawal limits", () => {
  test("an unverified account is refused outright", async ({ page, request }) => {
    const account = await createAccount(request, {
      label: "wd-tier0",
      kycLevel: 0,
      fundMinor: "20000000", // ₦200,000 — money is not the obstacle
    });

    await signIn(page, account);
    // The provider's own answer for this account. A withdrawal will accept no
    // other name, so the test asks the same way the form does.
    const payTo = await resolveAccount(page.request);
    await page.goto("/withdraw", { waitUntil: "domcontentloaded" });

    /*
     * The SERVER's answer is what counts, so it is asked directly as well as
     * through the form. A page that renders a disabled button proves the page
     * is careful; it does not prove the account cannot withdraw.
     */
    const refused = await page.request.post("/api/withdrawals", {
      data: {
        amountMinor: "1000000",
        bankCode: payTo.bankCode,
        accountNumber: payTo.accountNumber,
        confirmedAccountName: payTo.accountName,
        idempotencyKey: `tier0-${Date.now()}`,
      },
      failOnStatusCode: false,
    });
    expect(
      refused.status(),
      "an account that has never proved who owns it withdrew money",
    ).toBeGreaterThanOrEqual(400);

    // And the page says so rather than presenting a form that cannot work.
    const body = await page.locator("body").innerText();
    expect(body).toMatch(/verif|₦0|cannot|limit/i);

    record(test.info().project.name, {
      page: "/withdraw",
      viewport: viewportName(page),
      control: "Daily cap and KYC restriction — tier 0",
      action:
        "funded an unverified (tier 0) account with ₦200,000 and requested a ₦10,000 withdrawal",
      observed:
        `refused with ${refused.status()}; the page also tells the customer verification is ` +
        "needed. Tier 0 has a cap of zero — an account that can take money out without ever " +
        "proving who owns it is a laundering route",
      route: "POST /api/withdrawals",
    });
  });

  test("a tier-1 account is refused above its daily cap and accepted below it", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const account = await createAccount(request, {
      label: "wd-tier1",
      kycLevel: 1,
      fundMinor: "20000000", // ₦200,000, comfortably above the ₦50,000 cap
    });

    await signIn(page, account);
    // The provider's own answer for this account. A withdrawal will accept no
    // other name, so the test asks the same way the form does.
    const payTo = await resolveAccount(page.request);
    await page.goto("/withdraw", { waitUntil: "domcontentloaded" });

    // ------------------------------------------------- over the cap, in one go
    const over = await page.request.post("/api/withdrawals", {
      data: {
        amountMinor: (TIER_1_CAP_MINOR + 100_00n).toString(),
        bankCode: payTo.bankCode,
        accountNumber: payTo.accountNumber,
        confirmedAccountName: payTo.accountName,
        idempotencyKey: `tier1-over-${Date.now()}`,
      },
      failOnStatusCode: false,
    });
    expect(over.status(), "a tier-1 account withdrew more than its daily cap").toBeGreaterThanOrEqual(
      400,
    );

    // The form refuses it too, before the request, with the figure named.
    await page.getByLabel(/Amount/i).first().fill("60000");
    await expect(page.getByText(/daily limit at this verification level/i)).toBeVisible({
      timeout: 15_000,
    });

    // ------------------------------------------------------- under it, twice
    const first = await page.request.post("/api/withdrawals", {
      data: {
        amountMinor: "4000000", // ₦40,000
        bankCode: payTo.bankCode,
        accountNumber: payTo.accountNumber,
        confirmedAccountName: payTo.accountName,
        idempotencyKey: `tier1-ok-${Date.now()}`,
      },
      failOnStatusCode: false,
    });
    // 201: the route answers Created, because a withdrawal REQUEST is a new
    // resource awaiting review rather than a completed transfer.
    expect(first.status(), "a withdrawal within the cap was refused").toBe(201);

    /*
     * THE CAP IS A ROLLING TOTAL, NOT A PER-REQUEST CEILING.
     *
     * ₦40,000 then ₦20,000 is ₦60,000 in a day. Each is individually under the
     * ₦50,000 limit, and a cap implemented as a per-request check would let
     * both through — which is the version of this bug that is easy to write and
     * impossible to see without asking twice.
     */
    const second = await page.request.post("/api/withdrawals", {
      data: {
        amountMinor: "2000000", // ₦20,000
        bankCode: payTo.bankCode,
        accountNumber: payTo.accountNumber,
        confirmedAccountName: payTo.accountName,
        idempotencyKey: `tier1-second-${Date.now()}`,
      },
      failOnStatusCode: false,
    });
    expect(
      second.status(),
      "two withdrawals each under the cap summed past it and both were accepted",
    ).toBeGreaterThanOrEqual(400);

    record(test.info().project.name, {
      page: "/withdraw",
      viewport: viewportName(page),
      control: "Daily cap and KYC restriction",
      action:
        "on a tier-1 account: asked for ₦50,100 (over the cap), then ₦40,000 (accepted), then " +
        "₦20,000 (which would take the day past ₦50,000)",
      observed:
        `${over.status()} · ${first.status()} · ${second.status()} — the cap is a ROLLING DAILY ` +
        `TOTAL, not a ` +
        "per-request ceiling, and the form names the limit before the request is made",
      route: "POST /api/withdrawals",
    });
  });
});
