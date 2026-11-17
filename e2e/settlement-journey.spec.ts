import { expect, test, type Page } from "@playwright/test";
import { record, viewportName } from "./audit";
import { DEMO_ADMIN, signIn } from "./support";
import { backFirstPrice, naira, placeFromSlip, visibleCashMinor } from "./betting";
import { createAccount, createEvent, invariants, settle } from "./review";

/**
 * A bet placed in a browser, followed all the way to WON, LOST and VOID.
 *
 * WHAT WAS MISSING. The customer journey proved sign-in, placement, admin
 * visibility and cash-out, and stopped exactly where the interesting part
 * begins. Every settlement claim in this repository rested on Vitest calling
 * services directly — which proves the logic and says nothing about whether the
 * status a customer reads on My Bets ever changes. A bet had never once been
 * watched crossing from PENDING to paid through the interface.
 *
 * WHAT IS REAL HERE. Everything except the score. The result enters through
 * `OddsProvider.getResults` — the same seam odds-api.io enters through — and
 * from that point it is production code: `ResultIngestionService` selects due
 * events with its own query and calls `ingestResult`, which writes the result
 * row and the outbox item in ONE transaction; `dispatchSettlementOutbox` claims
 * the batch and emits `settlement/event.finished`; `settleEvent` fans out
 * `settlement/bet.requested`; `settleBet` pays. `settleBet` is never called
 * directly — it is reached the way the platform reaches it, so a function
 * missing from the serve route would fail here for the same reason it would in
 * production.
 *
 * THE HARNESS REPLAYS RATHER THAN RUNS. Inngest invokes a handler once per
 * step, replaying from the top with completed steps served from a checkpoint,
 * so code OUTSIDE a step re-executes every time. Modelling that is what caught
 * the cadence-claim bug that left a real winning bet unpaid while the monitor
 * showed success, and the same model is used here.
 *
 * EVERY BET GETS ITS OWN EVENT AND ITS OWN ACCOUNT. Sharing either would make
 * one outcome's assertions depend on whether another had already finished.
 */

/** The status My Bets shows, read from the ticket rather than from a route. */
async function ticketStatus(page: Page): Promise<string> {
  await page.goto("/bets", { waitUntil: "domcontentloaded" });
  const text = (await page.locator("body").innerText()).toUpperCase();
  for (const status of ["CASHED OUT", "WON", "LOST", "VOID", "PENDING"]) {
    if (text.includes(status)) return status;
  }
  return "UNKNOWN";
}

/** Polls the customer's own page until the status stops being PENDING. */
async function waitForSettled(page: Page, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let seen = "PENDING";
  while (Date.now() < deadline) {
    seen = await ticketStatus(page);
    if (seen !== "PENDING" && seen !== "UNKNOWN") return seen;
    await page.waitForTimeout(1000);
  }
  return seen;
}

test.describe("browser to worker: automatic settlement", () => {
  test("a bet placed in the browser is WON, paid exactly once, and shown as won", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    const project = test.info().project.name;
    const viewport = viewportName(page);

    const account = await createAccount(request, { label: "settle-win", fundMinor: "10000000" });
    const event = await createEvent(request, { label: "SettleWin", prices: ["2.000", "3.400", "3.800"] });

    // ------------------------------------------------------ 1. sign in and bet
    await signIn(page, account);
    const opening = await visibleCashMinor(page);

    // The HOME price, so a home win settles it. `backFirstPrice` takes the
    // first enabled tile on the event page, which is the 1x2 home selection.
    await backFirstPrice(page, event.providerEventId);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const placed = await placeFromSlip(page, "500");
    expect(placed.ok, `the bet could not be placed: ${placed.message}`).toBe(true);
    const reference = placed.reference!;

    // --------------------------------------------- 2. the stake left, exactly
    const afterStake = await visibleCashMinor(page);
    expect(opening - afterStake, "the stake debited was not exactly ₦500").toBe(50_000n);

    record(project, {
      page: "/",
      viewport,
      control: "Stake debited exactly",
      action: "staked ₦500 through the visible betslip on a disposable event",
      observed: `CASH fell from ${naira(opening)} to ${naira(afterStake)} — exactly ₦500.00`,
      route: "POST /api/bets",
    });

    // ------------------------------------------- 3. the administrator sees it
    const customerCookies = await page.context().cookies();
    await page.context().clearCookies();
    await signIn(page, DEMO_ADMIN);
    await page.goto("/admin/bets", { waitUntil: "domcontentloaded" });
    /*
     * BY THE CUSTOMER'S ADDRESS, not the reference.
     *
     * The admin list identifies a row by who placed it — that is what an
     * operator searches for — and does not print the bet's short reference at
     * all. Matching on the reference looked stricter and simply never matched.
     */
    const adminRow = page.locator("tr").filter({ hasText: account.email }).first();
    await expect(
      adminRow,
      "the administrator's bet list does not show the bet the customer just placed",
    ).toBeVisible({ timeout: 20_000 });
    await expect(adminRow).toContainText("₦500.00");
    await expect(adminRow).toContainText(/pending/i);

    record(project, {
      page: "/admin/bets",
      viewport,
      control: "Newly placed bet visible",
      action: `found the bet in the admin list by the customer's address (reference ${reference})`,
      observed:
        "the bet the customer placed seconds earlier is listed with its ₦500.00 stake and a " +
        "pending status",
      route: "GET /admin/bets",
    });

    // ------------------------ 4. the match finishes and the workers settle it
    const drive = await settle(request, [
      { providerEventId: event.providerEventId, eventId: event.eventId, ft: { home: 2, away: 0 } },
    ]);
    expect(drive.ingested, "the controlled result was not ingested").toBeGreaterThan(0);
    expect(drive.settleBetRuns, "settleBet never ran through the registered chain").toBeGreaterThan(
      0,
    );
    expect(drive.listenerErrors, "a registered function failed during settlement").toEqual([]);

    // ------------------------------------- 5. the CUSTOMER's page has changed
    await page.context().clearCookies();
    await page.context().addCookies(customerCookies);
    const status = await waitForSettled(page);
    expect(status, "the customer's ticket never left PENDING").toBe("WON");

    // ------------------------------------------- 6. paid, once, the right amount
    const afterSettlement = await visibleCashMinor(page);
    const paid = afterSettlement - afterStake;
    // ₦500 at 2.00 returns ₦1,000 including the stake.
    expect(paid, `the payout was ${naira(paid)}, not the ₦1,000.00 the ticket promised`).toBe(
      100_000n,
    );

    record(project, {
      page: "/bets",
      viewport,
      control: "Automatic settlement — won",
      action:
        "fed a 2-0 home result through the provider seam, then drove the registered background " +
        "functions; watched the customer's own My Bets page",
      observed:
        `the ticket moved from Pending to Won without anybody touching it, and CASH rose by ` +
        `exactly ${naira(paid)} — the ₦500 stake at 2.00. settleBet was reached through ` +
        `settleEvent, not called directly`,
      route: "POST /api/qa/settlement → settlement/event.finished → settlement/bet.requested",
    });

    // ------------------------------------------ 7. the administrator agrees
    await page.context().clearCookies();
    await signIn(page, DEMO_ADMIN);
    await page.goto("/admin/bets", { waitUntil: "domcontentloaded" });
    const settledRow = page.locator("tr").filter({ hasText: account.email }).first();
    await expect(settledRow, "the admin view still shows the settled bet as pending").toContainText(
      /won/i,
    );

    record(project, {
      page: "/admin/bets",
      viewport,
      control: "Admin settlement agreement",
      action: "re-read the same bet in the admin list after settlement",
      observed: "the administrator sees the same WON status the customer does",
      route: "GET /admin/bets",
    });

    // ------------------------------ 8. replay: no second payout, ever
    const replay = await settle(
      request,
      [{ providerEventId: event.providerEventId, eventId: event.eventId, ft: { home: 2, away: 0 } }],
      { sweep: true },
    );
    expect(replay.listenerErrors, "the replay broke a registered function").toEqual([]);

    await page.context().clearCookies();
    await page.context().addCookies(customerCookies);
    const afterReplay = await visibleCashMinor(page);
    expect(
      afterReplay,
      `a replayed result paid again: ${naira(afterSettlement)} became ${naira(afterReplay)}`,
    ).toBe(afterSettlement);

    const report = await invariants(request);
    expect(
      report.violations,
      `money invariants broke after settlement: ${report.violations.join(", ")}`,
    ).toEqual([]);

    record(project, {
      page: "any",
      viewport,
      control: "Settlement replay pays nothing twice",
      action:
        "re-fed the identical result and ran the recovery sweep, then re-read the customer's balance",
      observed:
        `the balance is unchanged at ${naira(afterReplay)}, and every money invariant — balanced ` +
        "transactions, no negative wallet, no duplicate payout, no residual exposure, no open " +
        "market on a final result — is still zero",
      route: "POST /api/qa/settlement (replay) · GET /api/qa/invariants",
    });
  });

  test("a losing bet is settled LOST and pays nothing", async ({ page, request }) => {
    test.setTimeout(180_000);
    const account = await createAccount(request, { label: "settle-lose", fundMinor: "10000000" });
    const event = await createEvent(request, { label: "SettleLose" });

    await signIn(page, account);
    await backFirstPrice(page, event.providerEventId);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const placed = await placeFromSlip(page, "300");
    expect(placed.ok, `the bet could not be placed: ${placed.message}`).toBe(true);
    const afterStake = await visibleCashMinor(page);

    // 0-3: the home selection that was backed cannot win.
    const drive = await settle(request, [
      { providerEventId: event.providerEventId, eventId: event.eventId, ft: { home: 0, away: 3 } },
    ]);
    expect(drive.listenerErrors).toEqual([]);

    const status = await waitForSettled(page);
    expect(status, "the losing ticket never settled").toBe("LOST");

    const afterSettlement = await visibleCashMinor(page);
    expect(
      afterSettlement,
      `a lost bet changed the balance: ${naira(afterStake)} became ${naira(afterSettlement)}`,
    ).toBe(afterStake);

    record(test.info().project.name, {
      page: "/bets",
      viewport: viewportName(page),
      control: "Automatic settlement — lost",
      action: "backed the home side, fed a 0-3 away win, drove the registered functions",
      observed:
        "the ticket shows Lost on the customer's own page and the balance did not move — a lost " +
        "bet pays nothing and refunds nothing",
      route: "POST /api/qa/settlement",
    });
  });

  test("a cancelled match voids the bet and returns the stake exactly once", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const account = await createAccount(request, { label: "settle-void", fundMinor: "10000000" });
    const event = await createEvent(request, { label: "SettleVoid" });

    await signIn(page, account);
    const opening = await visibleCashMinor(page);
    await backFirstPrice(page, event.providerEventId);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const placed = await placeFromSlip(page, "700");
    expect(placed.ok, `the bet could not be placed: ${placed.message}`).toBe(true);

    const afterStake = await visibleCashMinor(page);
    expect(opening - afterStake).toBe(70_000n);

    const providerEventId = event.providerEventId;
    const drive = await settle(request, [
      { providerEventId, eventId: event.eventId, cancelled: true },
    ]);
    expect(drive.listenerErrors).toEqual([]);

    const status = await waitForSettled(page);
    expect(status, "the void ticket never settled").toBe("VOID");

    const afterVoid = await visibleCashMinor(page);
    expect(
      afterVoid,
      `the void did not return exactly the stake: ${naira(afterStake)} → ${naira(afterVoid)}`,
    ).toBe(opening);

    // Replayed, because a refund paid twice is the same defect as a payout paid
    // twice and is easier to write by accident.
    await settle(request, [{ providerEventId, eventId: event.eventId, cancelled: true }], {
      sweep: true,
    });
    const afterReplay = await visibleCashMinor(page);
    expect(afterReplay, "a replayed cancellation refunded the stake twice").toBe(opening);

    const report = await invariants(request);
    expect(report.violations, `money invariants broke: ${report.violations.join(", ")}`).toEqual([]);

    record(test.info().project.name, {
      page: "/bets",
      viewport: viewportName(page),
      control: "Automatic settlement — void",
      action: "staked ₦700, cancelled the match through the provider seam, then replayed it",
      observed:
        `the ticket shows Void, the balance returned to exactly ${naira(opening)}, and the replay ` +
        "changed nothing. All money invariants zero",
      route: "POST /api/qa/settlement ×2",
    });
  });
});

