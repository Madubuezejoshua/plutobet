import { expect, test } from "@playwright/test";
import { record, viewportName } from "./audit";
import { signIn } from "./support";
import {
  backFirstPrice,
  openSlipIfCollapsed,
  placeFromSlip,
  startFreshSlip,
  visibleSlip,
} from "./betting";
import { createAccount, createEvent, setMarket, setSelection } from "./review";

/**
 * What the product does when the market moves underneath a customer.
 *
 * These four — suspended, closed, repriced, and submitted twice — were all
 * declared integration boundaries on the grounds that a browser cannot suspend
 * a market or reprice a selection mid-flight. It cannot, on its own; a review
 * server with a QA fixture route can, and the two columns being written here
 * (`selections.status` and `selections.current_price_decimal`) are exactly the
 * ones an odds feed rewrites every few seconds in production. Nothing about a
 * bet, an outcome, a balance or an exposure is touched.
 *
 * The refusal a customer READS is the thing worth testing here. The acceptance
 * specs already prove the server refuses; what they cannot show is whether the
 * person staring at the slip is told anything they can act on.
 */

test.describe("markets that move", () => {
  test("a suspended selection is refused, and the slip says so", async ({ page, request }) => {
    const account = await createAccount(request, { label: "suspend", fundMinor: "5000000" });
    const event = await createEvent(request, { label: "Suspend" });

    await signIn(page, account);
    await backFirstPrice(page, event.providerEventId);
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // The feed suspends the price after the customer has it in their slip.
    const target = event.selections[0]!;
    await setSelection(request, { selectionId: target.id, status: "SUSPENDED" });

    const result = await placeFromSlip(page, "200");
    expect(result.ok, "a bet was accepted on a suspended selection").toBe(false);
    expect(result.status, "the placement was not refused by the server").toBe(409);
    expect(result.message ?? "", "the refusal told the customer nothing usable").toMatch(
      /suspend|unavailab|no longer|closed/i,
    );

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Suspended selection refusal",
      action: "added a price, suspended that selection through the feed's own columns, then placed",
      observed: `refused with 409 and the message "${(result.message ?? "").slice(0, 90)}"`,
      route: "POST /api/bets",
    });
  });

  test("a closed market is refused", async ({ page, request }) => {
    const account = await createAccount(request, { label: "closed", fundMinor: "5000000" });
    const event = await createEvent(request, { label: "Closed" });

    await signIn(page, account);
    await backFirstPrice(page, event.providerEventId);
    await page.goto("/", { waitUntil: "domcontentloaded" });

    /*
     * The MARKET, not the selection. Placement checks both, in that order, and
     * they are different refusals — `SELECTION_CLOSED` and `MARKET_CLOSED` —
     * so a test that only ever suspends a selection leaves the market branch
     * unexercised through the interface.
     */
    await setMarket(request, { marketId: event.marketId, status: "SUSPENDED" });

    const result = await placeFromSlip(page, "200");
    expect(result.ok, "a bet was accepted on a closed market").toBe(false);
    expect(result.status).toBe(409);

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Closed or suspended market refusal",
      action: "added a price, then suspended the whole market rather than the single selection",
      observed: `refused with 409 — the market check fires as well as the selection one`,
      route: "POST /api/bets",
    });
  });

  test("a price that moves is shown to the customer before they stake", async ({ page, request }) => {
    const account = await createAccount(request, { label: "drift", fundMinor: "5000000" });
    /*
     * ON THE BOARD, DELIBERATELY — the only test that asks for that.
     *
     * The drift warning is produced by the odds TILE: `OddsButton` calls
     * `noteLivePrice` when it renders a price different from the one on the
     * slip. Disposable fixtures are filed under an unlisted sport so they stay
     * out of the board and the competition rail, and that is right for every
     * other test — but it means no tile ever renders them, so no drift is ever
     * noticed. This one fixture is football, and the reload below is what makes
     * the tile see 2.75.
     */
    const event = await createEvent(request, {
      label: "Drift",
      prices: ["2.000", "3.400", "3.800"],
      sport: "football",
    });

    await signIn(page, account);
    const tile = await backFirstPrice(page, event.providerEventId);
    const backed = await tile.getAttribute("aria-label");

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openSlipIfCollapsed(page);
    await expect(visibleSlip(page)).toContainText(/2\.00/);

    // The feed reprices. Every board render after this one carries the new
    // number, and the slip compares it against the price it stored.
    await setSelection(request, { selectionId: event.selections[0]!.id, priceDecimal: "2.750" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await openSlipIfCollapsed(page);

    const slip = visibleSlip(page);
    await expect(slip, "the slip did not warn that the price had moved").toContainText(
      /Odds moved to/i,
    );
    await expect(slip).toContainText(/2\.75/);
    await expect(slip).toContainText(/price has moved|prices have moved/i);
    // And it no longer PROMISES the drifted price will be placed. Under the
    // default "Ask" preference the server refuses it, and the old copy said
    // otherwise.
    await expect(slip).not.toContainText(/will be placed at the current price/i);

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Odds-moved warning",
      action: `backed "${backed}" at 2.00, repriced the selection to 2.75 through the feed, reloaded the board`,
      observed:
        "the slip shows 'Odds moved to 2.75' against the pick and a summary line above the stake " +
        "— the customer is told before they commit, not after",
      route: "GET /",
    });

    /*
     * THE FIRST PRESS IS REFUSED, AND THAT IS CORRECT.
     *
     * The account preference defaults to "Ask", which the server implements as
     * "refuse anything that drifted" — the customer never agreed to the new
     * number, so it must not be placed for them. What was missing was the
     * ASKING: the refusal came back as "none of the combinations on this slip
     * could be placed", the slip kept the stale 2.00, and pressing again was
     * refused again for the same invisible reason. Finding 48.
     */
    const refused = await placeFromSlip(page, "200");
    expect(refused.ok, "a drifted price was placed under the default Ask preference").toBe(false);
    expect(
      refused.message ?? "",
      "the refusal did not tell the customer the price had moved",
    ).toMatch(/price moved/i);
    expect(refused.message ?? "").toMatch(/place again|confirm/i);

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Stale price refusal",
      action: "pressed Place bet with the stale 2.00 still on the slip",
      observed:
        `refused, and the customer is told why: "${(refused.message ?? "").slice(0, 110)}". ` +
        "Before this pass the same refusal read 'none of the combinations on this slip could be " +
        "placed'",
      route: "POST /api/bets",
    });

    /*
     * AND THE SECOND PRESS IS A DECISION.
     *
     * The refusal put the live price on the slip with its recalculated return,
     * so pressing again accepts 2.75 knowingly. The server prices it and
     * decides exactly as before — nothing here accepts a price on the
     * customer's behalf.
     */
    await expect(slip, "the slip did not adopt the live price after the refusal").toContainText(
      /2\.75/,
    );
    const placed = await placeFromSlip(page, "200");
    expect(placed.ok, `the confirmed price was still refused: ${placed.message}`).toBe(true);

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Odds-moved confirmation",
      action: "pressed Place bet a second time, now carrying the 2.75 the slip adopted",
      observed:
        "accepted. The default preference is 'Ask', and this is the ask actually happening — a " +
        "moved price is offered back and placed only when the customer confirms it",
      route: "POST /api/bets",
    });
  });

  test("submitting the same bet twice creates one bet, not two", async ({ page, request }) => {
    const account = await createAccount(request, { label: "dupe-bet", fundMinor: "5000000" });
    const event = await createEvent(request, { label: "Duplicate" });

    await signIn(page, account);
    await backFirstPrice(page, event.providerEventId);
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const first = await placeFromSlip(page, "250");
    expect(first.ok, `the first placement failed: ${first.message}`).toBe(true);
    await startFreshSlip(page);

    /*
     * THE SAME IDEMPOTENCY KEY, REPLAYED THROUGH THE REAL ROUTE.
     *
     * The interface will not submit twice — it swaps to a confirmation — so the
     * duplicate has to be produced the way a flaky network produces one: the
     * identical request, sent again. What must NOT happen is a second bet and a
     * second debit.
     */
    const selection = event.selections[0]!;
    const key = `browser-duplicate-${Date.now()}`;
    const body = {
      // `legs`, the name the route's own schema uses. Sending `selections`
      // gets a 422 — a refusal, but a validation one, which would have made
      // this test pass while proving nothing about idempotency.
      legs: [{ selectionId: selection.id, odds: selection.price }],
      stakeMinor: "25000",
      idempotencyKey: key,
    };
    const a = await page.request.post("/api/bets", { data: body, failOnStatusCode: false });
    const b = await page.request.post("/api/bets", { data: body, failOnStatusCode: false });

    expect(a.status(), "the replayable placement was refused outright").toBe(201);
    const firstBody = (await a.json()) as { betId?: string };
    expect(b.status(), "a replayed placement was treated as a new bet").toBe(201);
    const secondBody = (await b.json()) as { betId?: string };
    expect(
      secondBody.betId,
      "the replay returned a DIFFERENT bet — the same request was charged twice",
    ).toBe(firstBody.betId);

    // And the customer's own list shows one ticket for it, not two.
    await page.goto("/bets", { waitUntil: "domcontentloaded" });
    const reference = firstBody.betId!.slice(0, 8);
    const occurrences = await page.locator(`text=${reference}`).count();
    expect(occurrences, `the bets page shows ${occurrences} copies of one bet`).toBeLessThanOrEqual(1);

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Place bet — duplicate submit",
      action:
        "placed one bet from the slip, then sent an identical request twice with the same " +
        "idempotency key",
      observed:
        "both replays answered 200 with the SAME bet id, and My Bets lists it once — a repeated " +
        "request is not a second bet and not a second debit",
      route: "POST /api/bets ×2",
    });
  });
});
