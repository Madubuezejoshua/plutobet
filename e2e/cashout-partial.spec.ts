import { expect, test } from "@playwright/test";
import { record, viewportName } from "./audit";
import { signIn } from "./support";
import { backFirstPrice, naira, placeFromSlip, visibleCashMinor } from "./betting";
import { createAccount, createEvent, invariants, setSelection } from "./review";

/**
 * Taking half a cash-out and leaving the rest running.
 *
 * The panel has always OFFERED this — "Take half and leave the rest running" —
 * and the previous pass asserted that the choice was presented and then left
 * taking it to an acceptance spec, on the grounds that the arithmetic is what
 * matters and a browser cannot see it. Half of that is right: the browser
 * cannot check the exposure release. The other half is wrong, because the
 * question a customer has is not arithmetic at all. It is "if I take half, is
 * my bet still running, and did I get paid?" — and only the product can answer
 * that.
 *
 * So this presses the checkbox and then reads the answer off the ticket, the
 * balance, and the invariant endpoint.
 */

test.describe("partial cash-out", () => {
  test("half is paid, the rest keeps running, and nothing is paid twice", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const account = await createAccount(request, { label: "partial", fundMinor: "10000000" });
    const event = await createEvent(request, { label: "Partial" });

    await signIn(page, account);
    await backFirstPrice(page, event.providerEventId);
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const placed = await placeFromSlip(page, "400");
    expect(placed.ok, `the bet could not be placed: ${placed.message}`).toBe(true);

    const afterStake = await visibleCashMinor(page);

    await page.goto("/bets", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Cash out" }).first().click();

    const half = page.getByText(/Take half and leave the rest running/i).first();
    await expect(half, "the panel did not offer a partial cash-out").toBeVisible({
      timeout: 25_000,
    });

    // The whole-ticket offer on screen, before the half is ticked.
    const offerText = await page.locator(".sb-cashout__value").first().innerText();
    const wholeShown = BigInt(offerText.replace(/[^\d]/g, ""));
    await page.locator("input[type='checkbox']").first().check();

    /*
     * THE BUTTON MUST NOW PROMISE THE HALF, NOT THE WHOLE.
     *
     * It used to say "Accept <whole offer>" with the half ticked and then pay
     * half — the wrong direction for a number somebody is agreeing to. Read off
     * the button rather than computed here, so what is asserted is what the
     * customer was actually shown.
     */
    const acceptButton = page.getByRole("button", { name: /^Accept / });
    const promised = BigInt(
      ((await acceptButton.innerText()).match(/[\d,]+\.\d{2}/)?.[0] ?? "0").replace(
        /[.,]/g,
        "",
      ),
    );
    expect(promised, "the button still promised the whole-ticket offer").toBeLessThan(wholeShown);

    const taking = page.waitForResponse(
      (r) => /\/api\/bets\/.+\/cashout/.test(r.url()) && r.request().method() === "POST",
    );
    await acceptButton.click();
    const response = await taking;
    expect(
      response.status(),
      `the partial cash-out was refused: ${await response.text()}`,
    ).toBe(200);

    const paidMinor = BigInt(((await response.json()) as { offerMinor: string }).offerMinor);

    await expect(page.getByText(/Cashed out for/i)).toBeVisible({ timeout: 25_000 });

    /*
     * THE BET IS STILL RUNNING. This is the whole promise of a partial, and the
     * one thing that would be invisible in a service-level assertion about
     * money: a ticket that says "Cashed out" after taking half would mean the
     * customer had unknowingly closed their position.
     */
    await page.goto("/bets", { waitUntil: "domcontentloaded" });
    const bodyText = await page.locator("body").innerText();
    // The pill on an unsettled ticket reads OPEN.
    expect(bodyText, "the bets page shows no open ticket after a PARTIAL cash-out").toMatch(
      /OPEN/i,
    );
    /*
     * AND IT SAYS WHAT IS LEFT. The page used to print the ORIGINAL stake and
     * the ORIGINAL potential return on a ticket that had already had half
     * bought back — "Stake 400, To return 800" when at most 400 could come
     * back. It did not even select the column that says otherwise.
     */
    expect(bodyText, "the ticket does not say how much was cashed out").toMatch(/cashed out/i);
    expect(bodyText, "the ticket still shows the whole stake as running").toMatch(/Still running/i);

    const afterCashout = await visibleCashMinor(page);
    expect(
      afterCashout - afterStake,
      `the balance moved by ${naira(afterCashout - afterStake)} but the payout was ${naira(paidMinor)}`,
    ).toBe(paidMinor);

    /*
     * HALF, NOT ALL. The offer shown was for the whole ticket; taking half must
     * pay about half of it. Asserted as a band rather than an exact figure —
     * the server reprices under the bet's row lock at the moment of acceptance
     * and pays the higher of the two, so an exact equality would be asserting
     * that no time passed.
     */
    expect(paidMinor).toBeLessThan(wholeShown);
    expect(paidMinor * 2n).toBeGreaterThanOrEqual((wholeShown * 95n) / 100n);
    // And the customer was paid at least what the button promised.
    expect(paidMinor, "paid less than the button said").toBeGreaterThanOrEqual(promised);

    const report = await invariants(request);
    expect(report.violations, `money invariants broke: ${report.violations.join(", ")}`).toEqual([]);

    record(test.info().project.name, {
      page: "/bets",
      viewport: viewportName(page),
      control: "Cash out — partial taken",
      action:
        `staked ₦400, asked for a price (${offerText}), ticked the "take half" option and ` +
        "accepted",
      observed:
        `${naira(paidMinor)} was paid — about half the full offer — the balance rose by exactly ` +
        "that, and the ticket is still Pending. Every money invariant is still zero",
      route: "GET /api/bets/:id/cashout · POST /api/bets/:id/cashout",
    });
  });

  test("an offer that falls between quoting and accepting is refused", async ({ page, request }) => {
    test.setTimeout(150_000);
    const account = await createAccount(request, { label: "stale-cashout", fundMinor: "10000000" });
    const event = await createEvent(request, { label: "StaleCashout", prices: ["2.000", "3.400", "3.800"] });

    await signIn(page, account);
    await backFirstPrice(page, event.providerEventId);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const placed = await placeFromSlip(page, "500");
    expect(placed.ok, `the bet could not be placed: ${placed.message}`).toBe(true);

    await page.goto("/bets", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Cash out" }).first().click();
    await expect(page.locator(".sb-cashout__value").first()).toBeVisible({ timeout: 25_000 });

    /*
     * THE RACE, DRIVEN FROM THE OUTSIDE.
     *
     * The customer is holding a price. The feed then moves the selection in
     * their favour — a longer price means the position is worth LESS to buy
     * back — and they accept the figure they were shown. The server reprices
     * under the bet's row lock and must refuse rather than pay the stale,
     * higher number.
     *
     * This was declared an integration boundary on the grounds that a browser
     * cannot reprice between quote and take. It cannot on its own; a review
     * server with a fixture route can, and the two columns being written are
     * the ones an odds feed rewrites continuously in production.
     */
    await setSelection(request, { selectionId: event.selections[0]!.id, priceDecimal: "9.500" });

    const taking = page.waitForResponse(
      (r) => /cashout/.test(r.url()) && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: /^Accept / }).click();
    const response = await taking;

    expect(
      response.status(),
      "a cash-out was paid at a price the position was no longer worth",
    ).toBeGreaterThanOrEqual(400);
    await expect(page.locator(".sb-note--warn")).toBeVisible({ timeout: 20_000 });

    const report = await invariants(request);
    expect(report.violations, `money invariants broke: ${report.violations.join(", ")}`).toEqual([]);

    record(test.info().project.name, {
      page: "/bets",
      viewport: viewportName(page),
      control: "Cash out — stale offer refusal",
      action:
        "asked for a price, lengthened the selection from 2.00 to 9.50 through the feed, then " +
        "accepted the figure that was still on screen",
      observed:
        `refused with ${response.status()} and the page explains it — the server reprices under ` +
        "the bet's row lock and will not pay a stale offer. Nothing was charged and every money " +
        "invariant is still zero",
      route: "GET /api/bets/:id/cashout · POST /api/bets/:id/cashout",
    });
  });
});
