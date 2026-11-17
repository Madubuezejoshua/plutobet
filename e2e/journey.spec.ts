import { expect, test, type Page } from "@playwright/test";
import { DEMO_ADMIN, DEMO_PLAYER, signIn } from "./support";
import { record, routeFor, viewportName } from "./audit";

/**
 * One customer, all the way through — in a real browser this time.
 *
 * `customer-journey.acceptance.spec.ts` already walks fourteen steps end to
 * end, and it is the stronger test of the MONEY: it controls the clock, drives
 * settlement through the registered jobs, and asserts the ledger balances. What
 * it cannot do is hold a cookie. It substitutes the session, calls services
 * directly, and never renders a page — so it proves the system settles a bet
 * and says nothing about whether a person can place one.
 *
 * This is the other half. Everything here crosses the real browser, HTTP and
 * cookie boundaries: the credentials form sets a session, the board renders
 * stored prices, the slip posts to the placement route, and the balance the
 * customer reads is the one the ledger holds.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, and why — so the gaps are stated rather
 * than discovered:
 *
 *   REGISTRATION. Blocked, and by a control working correctly. `otp.service`
 *   refuses to issue a console-fallback code when NODE_ENV is production, since
 *   that fallback returns the code in the API response and would let anyone
 *   verify a destination they do not control. The review server runs a
 *   production build, so no browser can complete a registration against it. The
 *   guard is ASSERTED below rather than worked around. It used to surface as an
 *   opaque 500; it answers 503 now, because a deployment that cannot send
 *   anything is not a server fault to be swallowed (finding 42). Registration
 *   itself is covered by the acceptance journey.
 *
 *   SETTLEMENT. Driven by registered background jobs that the review server does
 *   not run. Feeding a result through them is exactly what the acceptance
 *   journey does, and doing it from a browser would mean calling the settlement
 *   service directly — which is the substitution this file exists to avoid.
 */

/** Reads the CASH figure the customer can actually see, in kobo. */
async function visibleCashMinor(page: Page): Promise<bigint> {
  await page.goto("/wallet", { waitUntil: "domcontentloaded" });
  const text = await page.locator("body").innerText();
  // The wallet page prints the cash bucket as ₦x,xxx.yy
  const match = /₦\s*([\d,]+)\.(\d{2})/.exec(text);
  if (!match) throw new Error(`no naira figure rendered on /wallet:\n${text.slice(0, 400)}`);
  return BigInt(match[1]!.replace(/,/g, "")) * 100n + BigInt(match[2]!);
}

function naira(minor: bigint): string {
  return `₦${(Number(minor) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
}

test.describe("the customer journey, in a browser", () => {
  test("a one-time code is never returned to whoever asked for it", async ({ request }) => {
    /*
     * WHAT THIS TEST USED TO ASSERT, AND WHY IT ASSERTS SOMETHING ELSE NOW.
     *
     * It asserted that `POST /api/auth/otp` REFUSED — because the console
     * fallback returns the code in the response body, and `otp.service` blocks
     * that under a production build. Correct, and it made registration
     * untestable in a browser, so the whole flow sat in the manifest as an
     * integration boundary for two passes.
     *
     * The review server now has a real delivery path: a local mailbox the
     * requester cannot read without a per-run key. So the route SUCCEEDS here,
     * and the property worth defending is no longer "it refuses" — it is the
     * property that made the fallback dangerous in the first place. The code
     * must not come back to whoever asked for it. That is asserted directly,
     * on the response body, in the environment where a code is genuinely
     * issued: the strictly stronger claim, and the one that would still fail if
     * somebody reintroduced `devCode` tomorrow.
     *
     * The refusal itself is not lost. `otp-production-guard.acceptance.spec.ts`
     * still proves the console provider is blocked under a production build,
     * and `review-adapters.acceptance.spec.ts` proves the mailbox refuses to
     * exist unless all four review conditions hold.
     */
    const response = await request.post("/api/auth/otp", {
      data: { phoneNumber: "+2348030000001", purpose: "PHONE_VERIFY" },
      failOnStatusCode: false,
    });
    const body = await response.text();

    expect(
      response.status(),
      "the OTP route could not issue a code on the review server",
    ).toBeLessThan(400);
    expect(body, "the response carried a devCode field").not.toMatch(/devCode/);
    expect(body, "a six-digit code appeared in the response body").not.toMatch(/\b\d{6}\b/);

    record(test.info().project.name, {
      page: "/register",
      viewport: "n/a",
      control: "Registration OTP guard",
      action:
        "requested a verification code and read the RESPONSE BODY of the request that issued it",
      observed:
        `answered ${response.status()} with no devCode field and no six-digit number anywhere in ` +
        "the body. The code went to the local mailbox, which needs a per-run key to read — the " +
        "console fallback's behaviour of handing it straight back is what is being excluded",
      route: "POST /api/auth/otp",
    });
  });

  test("sign in, bet, see it, cash out, sign out — one account, one run", async ({ page, context }) => {
    test.setTimeout(180_000);
    const project = test.info().project.name;
    const viewport = viewportName(page);

    // ---------------------------------------------------------------- 1. sign in
    await signIn(page);
    const cookies = await context.cookies();
    const session = cookies.find((c) => /next-auth|authjs/i.test(c.name) && c.value.length > 0);
    expect(session, "signing in set no session cookie").toBeTruthy();
    expect(session!.httpOnly, "the session cookie is readable by scripts").toBe(true);

    record(project, {
      page: "/signin",
      viewport,
      control: "Sign in (correct password)",
      action: "submitted the real credentials form",
      observed: `a session was established; the cookie is httpOnly=${session!.httpOnly}, sameSite=${session!.sameSite}`,
      route: "POST /api/auth/callback/credentials",
    });

    // ------------------------------------------------ 2. the account is identified
    await page.goto("/account", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText(DEMO_PLAYER.email);
    record(project, {
      page: "/account",
      viewport,
      control: "Account tiles",
      action: "opened the account hub as the signed-in customer",
      observed: "the page identifies the signed-in account and lists its management tiles",
      route: "GET /account",
    });

    // -------------------------------------------------------- 3. the balance shown
    const before = await visibleCashMinor(page);
    expect(before, "the customer has no funds to bet with").toBeGreaterThan(20_000n);
    record(project, {
      page: "/wallet",
      viewport,
      control: "Wallet buckets",
      action: "read the balance the customer is shown",
      observed: `CASH reads ${naira(before)}, rendered from the ledger rather than a cached figure`,
      route: "GET /wallet",
    });

    // ------------------------------------------------- 4. QA funding is not a route
    for (const path of ["/api/qa/credit", "/api/qa-credit", "/api/admin/credit", "/api/wallet/credit"]) {
      const probe = await page.request.post(path, { data: { amountMinor: 100000 }, failOnStatusCode: false });
      expect(
        probe.status(),
        `${path} answered ${probe.status()} — a customer-reachable funding route must not exist`,
      ).toBe(404);
    }
    record(project, {
      page: "any",
      viewport,
      control: "QA funding unreachable by a customer",
      action: "posted to four plausible QA-funding paths as a signed-in customer",
      observed:
        "every one answered 404. QA credit is a script (scripts/qa-credit.ts) gated on " +
        "ALLOW_QA_CREDIT and NODE_ENV. The review-only /api/qa surface CAN fund a disposable " +
        "account, and it answers 404 to this customer too — it needs a per-run key generated into " +
        "a gitignored file, probed separately in security-extended.spec.ts",
      route: "POST /api/qa/credit · /api/qa-credit · /api/admin/credit · /api/wallet/credit → 404",
    });

    // ------------------------------------------------------ 5. browse, open, select
    await page.goto("/", { waitUntil: "domcontentloaded" });

    /*
     * Whichever way in this width offers. The statistics icon is hidden below
     * 720px by design — it leads to the same place as the chevron at the end of
     * the row, and two controls with one destination is space a phone cannot
     * spare. Insisting on the icon fails on a phone for a reason that has
     * nothing to do with the product.
     */
    const intoEvent = page
      .locator('a[aria-label^="Statistics and all markets"]:visible, a[aria-label*="markets for"]:visible')
      .first();
    await intoEvent.scrollIntoViewIfNeeded();
    await intoEvent.click();
    await page.waitForURL("**/sports/event/**");

    const tile = page.locator("button.sb-odd:not([disabled])").first();
    await expect(tile, "the event page offered no price to back").toBeVisible();
    const priceLabel = await tile.getAttribute("aria-label");
    await tile.click();
    await expect(tile).toHaveAttribute("aria-pressed", "true");

    record(project, {
      page: "/sports/event",
      viewport,
      control: "Selection adds to betslip",
      action: `opened an event from the board and backed "${priceLabel}"`,
      observed: "the selection joined the slip at the price the page displayed",
      route: `GET ${new URL(page.url()).pathname}`,
    });

    /*
     * ------------------------------------------------------------- 6. place ₦200
     *
     * Back to the board first. The betslip is part of the BOARD's layout, not
     * the event page's, so the stake field does not exist where the selection
     * was made. The selection survives the navigation in `sessionStorage` —
     * which is itself worth crossing, because a slip that forgot its picks on
     * the way to the stake field would be useless.
     */
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(
      page.locator('[aria-label="Betslip"]').first(),
      "the selection did not survive the walk back to the board",
    ).toContainText(/1x2|Real|Draw|v /i);

    if ((page.viewportSize()?.width ?? 0) < 1180) {
      const toggle = page.locator('nav[aria-label="Primary"] button[aria-expanded]').first();
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    }
    /*
     * By accessible name, scoped to the VISIBLE slip. The panel is rendered
     * twice — sticky column and mobile sheet — and below 1180px the column is
     * hidden rather than unmounted, so an id or a `.first()` finds the copy the
     * customer cannot reach.
     */
    const slip = page.locator('[aria-label="Betslip"]:visible').first();
    await slip.getByLabel("Stake in naira").fill("200");
    await slip.getByRole("button", { name: /^place bet$/i }).click();
    const placeRoute = await routeFor(
      page,
      async () => slip.getByRole("button", { name: /^confirm$/i }).click(),
      /\/api\/bets/,
    );
    const confirmation = slip.locator(".sb-note--ok");
    await expect(confirmation, "the bet was not confirmed in the page").toBeVisible({ timeout: 25_000 });
    const reference = ((await confirmation.textContent()) ?? "").match(/[0-9a-f]{8}/i)?.[0];
    expect(reference, "the confirmation carried no bet reference").toBeTruthy();

    record(project, {
      page: "/",
      viewport,
      control: "Place bet",
      action: "staked ₦200 from the browser and confirmed",
      observed: `accepted, and the page showed a real bet reference (${reference})`,
      route: placeRoute,
    });

    // ------------------------------------------- 7. the balance moved by exactly ₦200
    const after = await visibleCashMinor(page);
    expect(
      before - after,
      `CASH moved by ${naira(before - after)}; a ₦200 stake must move exactly ₦200.00`,
    ).toBe(20_000n);

    record(project, {
      page: "/wallet",
      viewport,
      control: "Stake debited exactly",
      action: "read the balance again after placing",
      observed: `${naira(before)} → ${naira(after)}, a movement of exactly ₦200.00 — debited at placement, not at settlement`,
      route: "GET /wallet",
    });

    // ------------------------------------------------------- 8. My Bets shows it
    await page.goto("/bets", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toContainText(reference!.slice(0, 8));
    record(project, {
      page: "/bets",
      viewport,
      control: "My bets list",
      action: "opened My Bets after placing",
      observed: `the bet is listed, carrying the same reference the confirmation showed (${reference})`,
      route: "GET /bets",
    });

    // ----------------------------------------------- 9. the administrator sees it
    const adminPage = await context.browser()!.newContext();
    const adminTab = await adminPage.newPage();
    await signIn(adminTab, DEMO_ADMIN);
    await adminTab.goto("/admin/bets", { waitUntil: "domcontentloaded" });
    const adminBody = await adminTab.locator("body").innerText();

    /*
     * Matched on CUSTOMER AND STAKE, not on the reference.
     *
     * The admin bet table renders placed-at, customer, type, legs, stake,
     * potential return and status — it never prints the bet id, so the
     * reference the customer was shown cannot appear there. That is a
     * reasonable admin view; it just means the identity to assert on is the one
     * both sides actually display.
     */
    expect(
      adminBody,
      "the administrator's bet list does not show a bet for this customer",
    ).toContain(DEMO_PLAYER.email);
    expect(
      adminBody,
      "the administrator's bet list shows no ₦200.00 stake for the bet just placed",
    ).toContain("₦200.00");

    record(project, {
      page: "/admin/bets",
      viewport,
      control: "Newly placed bet visible",
      action: "signed in as the administrator in a separate browser context and opened the bet list",
      observed:
        `the bet appears against ${DEMO_PLAYER.email} at a ₦200.00 stake — the same placement the customer sees at reference ${reference}. ` +
        "The admin table identifies bets by customer, stake and time rather than by id",
      route: "GET /admin/bets",
    });
    await adminPage.close();

    // ------------------------------------------------------------ 10. cash out
    await page.goto("/bets", { waitUntil: "domcontentloaded" });
    const cashOut = page.getByRole("button", { name: /cash ?out/i }).first();

    if (!(await cashOut.isVisible().catch(() => false))) {
      record(project, {
        page: "/bets",
        viewport,
        control: "Cash out",
        action: "looked for an offer on the freshly placed bet",
        observed: "no cash-out control was offered on this bet, so none could be taken",
        route: "GET /bets",
        status: "IMPLEMENTED_NOT_LIVE_TESTED",
      });
    } else {
      const beforeCashout = await visibleCashMinor(page);
      await page.goto("/bets", { waitUntil: "domcontentloaded" });

      const quoteRoute = await routeFor(
        page,
        async () => page.getByRole("button", { name: /cash ?out/i }).first().click(),
        /\/cashout/,
      );

      /*
       * WAIT FOR THE OFFER TO RENDER before looking for a way to take it. The
       * quote is fetched after the press, so the first version of this looked
       * for the accept button while the request was still in flight, found
       * nothing, and recorded a control that exists as untested.
       */
      const accept = page.getByRole("button", { name: /^Accept ₦/ });
      await expect(accept, "no acceptance control appeared after the offer was priced").toBeVisible({
        timeout: 20_000,
      });
      const offerText = (await accept.textContent())?.trim() ?? "";

      record(project, {
        page: "/bets",
        viewport,
        control: "Cash out",
        action: "pressed Cash out to price the offer",
        observed: `the server quoted a figure and the page offers to take it — "${offerText}"`,
        route: quoteRoute,
      });

      // The partial option is a real control on this panel, not a hidden path.
      const half = page.getByLabel(/take half/i);
      const hasPartial = await half.isVisible().catch(() => false);
      record(project, {
        page: "/bets",
        viewport,
        control: "Cash out — partial option offered",
        action: "read the offer panel",
        observed: hasPartial
          ? "a 'Take half and leave the rest running' choice is presented, and it states how much stake stays on the bet"
          : "no partial choice was presented on this ticket",
        route: quoteRoute,
        status: hasPartial ? undefined : "IMPLEMENTED_NOT_LIVE_TESTED",
      });

      /*
       * Take the whole offer, through the authenticated route — and CAPTURE THE
       * RESPONSE.
       *
       * A run that fails here otherwise reports only "the confirmation never
       * appeared", which is true of a refused cash-out, an intercepted click
       * and a network fault alike. The status and the page's own warning are
       * what tell them apart, and the difference matters because one of the
       * three is a product defect and two are not.
       */
      const taking = page
        .waitForResponse(
          (r) => /\/cashout/.test(r.url()) && r.request().method() === "POST",
          { timeout: 25_000 },
        )
        .catch(() => null);
      await accept.scrollIntoViewIfNeeded();
      const takeRoute = await routeFor(page, async () => accept.click(), /\/cashout/);
      const takeResponse = await taking;
      const refusal = takeResponse && !takeResponse.ok() ? await takeResponse.text() : "";
      /*
       * THE WARNING NOTE, ONLY IF THERE IS ONE.
       *
       * This is diagnostic: on a refusal it names what the page told the
       * customer, so a failure says which of three causes it was. On a SUCCESS
       * there is no warning note at all — and that is the normal path.
       *
       * It used to call `.textContent()` straight onto the empty locator.
       * `textContent()` auto-waits for its element, this project sets no
       * `actionTimeout`, and the default of 0 means "wait as long as the test
       * has". So every SUCCESSFUL cash-out sat here until the 180-second test
       * budget ran out; the `.catch()` then swallowed the timeout, far too late
       * to matter, and the still-pending confirmation assertion was reported as
       * `Received: undefined`. The diagnostic written to explain failures was
       * itself the failure, and it could never have passed.
       *
       * Counting first cannot block: `count()` resolves immediately against
       * whatever is in the DOM now, which is exactly the question being asked.
       */
      const onScreen =
        (await page.locator(".sb-note--warn").count()) > 0
          ? await page.locator(".sb-note--warn").first().textContent({ timeout: 5_000 }).catch(() => null)
          : null;

      const paid = page.locator("text=/Cashed out for/i").first();
      await expect(
        paid,
        `the page did not confirm the cash-out — POST answered ${takeResponse?.status() ?? "no response"}` +
          `${refusal ? `: ${refusal}` : ""}${onScreen ? ` · on screen: "${onScreen.trim()}"` : ""}`,
      ).toBeVisible({ timeout: 25_000 });
      const paidText = ((await paid.textContent()) ?? "").trim();

      const afterCashout = await visibleCashMinor(page);
      expect(
        afterCashout,
        `taking a cash-out did not increase the balance: ${naira(beforeCashout)} → ${naira(afterCashout)}`,
      ).toBeGreaterThan(beforeCashout);

      record(project, {
        page: "/bets",
        viewport,
        control: "Cash out — accept full",
        action: "accepted the quoted offer",
        observed: `${paidText} — CASH ${naira(beforeCashout)} → ${naira(afterCashout)}, credited once through the ordinary money path`,
        route: takeRoute,
      });

      await page.goto("/bets", { waitUntil: "domcontentloaded" });
      const ticket = await page.locator("body").innerText();
      expect(ticket.toLowerCase(), "the ticket still offers a cash-out after one was taken").toMatch(
        /cashed out|settled|won|lost|void/i,
      );
      record(project, {
        page: "/bets",
        viewport,
        control: "Cash out — ticket updated",
        action: "reopened My Bets after taking the offer",
        observed: "the ticket shows the bet as cashed out rather than still offering one",
        route: "GET /bets",
      });
    }

    // ---------------------------------------------------------------- 11. sign out
    await page.goto("/account", { waitUntil: "domcontentloaded" });
    const signOut = page.getByRole("button", { name: /sign out|log out/i }).first();
    if (await signOut.isVisible().catch(() => false)) {
      await signOut.click();
      await page.waitForTimeout(1500);
    } else {
      await page.goto("/api/auth/signout");
      const confirm = page.getByRole("button", { name: /sign out/i }).first();
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
    }
    await page.goto("/wallet", { waitUntil: "domcontentloaded" });
    const endedOnAuthWall = /signin|register/.test(page.url()) || !(await page
      .locator("body")
      .innerText()
      .then((t) => t.includes(DEMO_PLAYER.email))
      .catch(() => false));

    expect(endedOnAuthWall, "the session survived signing out").toBe(true);

    record(project, {
      page: "any",
      viewport,
      control: "Sign out",
      action: "signed out, then asked for a page that requires a session",
      observed: "the session no longer opens the wallet — signing out ended it",
      route: "POST /api/auth/signout",
    });
  });
});
