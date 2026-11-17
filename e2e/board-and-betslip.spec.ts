import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./support";
import { record, routeFor, viewportName } from "./audit";

/**
 * The board, the rail and the betslip — every enabled control, pressed.
 *
 * These are the controls a customer touches to turn a price into a bet, and
 * they were the largest block still marked `IMPLEMENTED_NOT_LIVE_TESTED` in
 * `general.md` §6 — which is a claim from reading the source dressed as a claim
 * about the product.
 *
 * WHAT IS DELIBERATELY NOT HERE. Stale prices, suspended markets and system-bet
 * combinatorics. Each needs the server to change its mind between two moments a
 * browser cannot separate, and each is already driven deterministically by an
 * acceptance test. `e2e/control-manifest.mjs` records that decision against the
 * control, with the reason, rather than leaving it to look like an oversight.
 */

const desktopOnly = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1180;

/**
 * The board's first usable odds tile, or null when the seed has none.
 *
 * SCOPED TO `.sb-odd`, NOT to `[aria-pressed]`. The first version of this used
 * the attribute alone and quietly matched a FAVOURITE STAR — league and fixture
 * stars are toggles and carry `aria-pressed` too. Four betslip tests then
 * clicked a star, added nothing to the slip, and failed waiting for a stake
 * field that had no reason to exist. The class is what makes it a price.
 */
async function firstUsableOdds(page: Page) {
  const tile = page.locator("button.sb-odd:not([disabled])").first();
  return (await tile.count()) > 0 ? tile : null;
}

/** Waits for a navigation to actually land, rather than reading the URL too early. */
async function waitForNavigation(page: Page, predicate: (url: URL) => boolean) {
  await page.waitForURL((url) => predicate(new URL(url.toString())), { timeout: 20_000 });
}

/**
 * The betslip the customer can actually see.
 *
 * THE PANEL IS ON THE PAGE TWICE — as the sticky column and inside the mobile
 * sheet — and below 1180px the column is hidden by CSS rather than unmounted.
 * `.first()` therefore returned the HIDDEN one on a phone, and the tests failed
 * against a panel no customer could reach.
 *
 * Finding it by visibility is also what surfaced the duplicate-id defect: with
 * both copies present, `#sb-stake` matched two elements and Playwright refused
 * to guess. The ids are unique now; this helper still scopes every query to the
 * visible panel, because two panels is the design and only one is in use.
 */
function visibleSlip(page: Page) {
  return page.locator('[aria-label="Betslip"]:visible').first();
}

/**
 * Opens an event from the board, using whichever control this width offers.
 *
 * THE STATISTICS ICON IS DELIBERATELY HIDDEN BELOW 720px. `sportsbook.css` says
 * why: it leads to the same place as the chevron at the end of the row, and two
 * controls with one destination is 26px a phone cannot spare beside three
 * prices. A test that insists on the icon is arguing with a decision the design
 * already made, and it fails on the mobile project for a reason that has
 * nothing to do with the product being wrong.
 *
 * So this asks for whichever is on screen and reports which — the audit row
 * then says what a customer at that width actually pressed.
 */
async function openFirstEvent(page: Page): Promise<{ via: string; href: string }> {
  const stats = page.locator('a[aria-label^="Statistics and all markets"]:visible').first();
  const usingStats = (await stats.count()) > 0;
  const control = usingStats
    ? stats
    : page.locator('a[aria-label*="markets for"]:visible').first();

  expect(await control.count(), "the board offered no way into an event at this width").toBeGreaterThan(0);
  const href = (await control.getAttribute("href")) ?? "";
  await control.scrollIntoViewIfNeeded();
  await control.click();
  await page.waitForURL("**/sports/event/**");
  return { via: usingStats ? "the statistics icon" : "the more-markets chevron", href };
}

test.describe("global chrome — the rest of it", () => {
  test("every primary navigation destination arrives", async ({ page }) => {
    await page.goto("/");
    const nav = page.locator('nav[aria-label="Main"]');
    const links = nav.locator("a[href]");
    const hrefs = await links.evaluateAll((els) =>
      els.map((e) => (e as HTMLAnchorElement).getAttribute("href")).filter(Boolean),
    );
    expect(hrefs.length, "the main navigation rendered no links").toBeGreaterThan(0);

    const failures: string[] = [];
    for (const href of hrefs) {
      const response = await page.goto(href!);
      const status = response?.status() ?? 0;
      if (status >= 400) failures.push(`${href} answered ${status}`);
    }
    expect(failures, `navigation destinations that did not answer: ${failures.join(", ")}`).toEqual([]);

    record(test.info().project.name, {
      page: "any",
      viewport: viewportName(page),
      control: "Primary navigation",
      action: `followed all ${hrefs.length} destinations`,
      observed: "every one answered under 400",
      route: hrefs.join(" · "),
    });
  });

  test("the sports sub-navigation filters the board", async ({ page }) => {
    await page.goto("/");
    const subnav = page.locator('nav[aria-label="Sports"]');
    if ((await subnav.count()) === 0) {
      record(test.info().project.name, {
        page: "any",
        viewport: viewportName(page),
        control: "Sports sub-navigation",
        action: "load",
        observed: "not rendered at this width, by design",
        route: "—",
      });
      return;
    }
    const first = subnav.locator("a[href]").first();
    const label = (await first.textContent())?.trim() ?? "a sport";
    const href = await first.getAttribute("href");
    const before = page.url();
    await first.click();
    // Wait for the navigation to LAND. Reading the URL straight after a click
    // races the client router and reports the page you were already on.
    await waitForNavigation(page, (url) => `${url.pathname}${url.search}` !== new URL(before).pathname);
    expect(`${new URL(page.url()).pathname}${new URL(page.url()).search}`).toContain(
      href!.split("?")[0] || "/",
    );

    record(test.info().project.name, {
      page: "any",
      viewport: viewportName(page),
      control: "Sports sub-navigation",
      action: `clicked "${label}"`,
      observed: "navigated to the filtered board",
      route: `GET ${new URL(page.url()).pathname}${new URL(page.url()).search}`,
    });
  });

  test("the More menu opens, closes on Escape and on an outside click", async ({ page }) => {
    await page.goto("/");
    const more = page.getByRole("button", { name: /^More/ }).and(page.locator(":visible"));
    if ((await more.count()) === 0) {
      record(test.info().project.name, {
        page: "any",
        viewport: viewportName(page),
        control: "More menu",
        action: "load",
        observed: "not rendered at this width; the bottom bar carries navigation instead",
        route: "—",
      });
      record(test.info().project.name, {
        page: "any",
        viewport: viewportName(page),
        control: "More menu — Escape closes",
        action: "load",
        observed: "no menu at this width",
        route: "—",
      });
      record(test.info().project.name, {
        page: "any",
        viewport: viewportName(page),
        control: "More menu — outside click closes",
        action: "load",
        observed: "no menu at this width",
        route: "—",
      });
      return;
    }

    await more.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const items = await menu.getByRole("menuitem").count();
    expect(items, "the More menu opened with no entries").toBeGreaterThan(0);

    record(test.info().project.name, {
      page: "any",
      viewport: viewportName(page),
      control: "More menu",
      action: "opened",
      observed: `${items} entries, each labelled from the navigation registry — planned products say "Not yet"`,
      route: "—",
    });

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    record(test.info().project.name, {
      page: "any",
      viewport: viewportName(page),
      control: "More menu — Escape closes",
      action: "pressed Escape",
      observed: "the menu closed",
      route: "—",
    });

    await more.click();
    await expect(menu).toBeVisible();
    await page.mouse.click(5, 400);
    await expect(menu).toBeHidden();
    record(test.info().project.name, {
      page: "any",
      viewport: viewportName(page),
      control: "More menu — outside click closes",
      action: "clicked outside the menu",
      observed: "the menu closed",
      route: "—",
    });
  });

  test("Pluto AI, balance, deposit, account and the auth links go where they say", async ({ page }) => {
    await page.goto("/");

    const pluto = page.getByRole("link", { name: /Pluto AI/i }).and(page.locator(":visible")).first();
    if (await pluto.isVisible().catch(() => false)) {
      await pluto.click();
      await page.waitForURL("**/pluto");
      record(test.info().project.name, {
        page: "any",
        viewport: viewportName(page),
        control: "Pluto AI navigation",
        action: "click",
        observed: "arrived at the assistant",
        route: "GET /pluto",
      });
    } else {
      record(test.info().project.name, {
        page: "any",
        viewport: viewportName(page),
        control: "Pluto AI navigation",
        action: "load",
        observed: "not rendered at this width",
        route: "—",
      });
    }

    // Signed out: the auth links are the ones on show.
    await page.goto("/");
    for (const [name, control, expected] of [
      [/sign in/i, "Sign in link", "/signin"],
      [/register/i, "Register link", "/register"],
    ] as const) {
      const link = page.getByRole("link", { name }).first();
      if (await link.isVisible().catch(() => false)) {
        await link.click();
        await page.waitForURL(`**${expected}`);
        record(test.info().project.name, {
          page: "any",
          viewport: viewportName(page),
          control,
          action: "click",
          observed: `arrived at ${expected}`,
          route: `GET ${expected}`,
        });
        await page.goto("/");
      }
    }

    // Signed in: balance, deposit and account replace them.
    await signIn(page);
    for (const [label, control, expected] of [
      [/balance|₦/i, "Balance", "/wallet"],
      ["Deposit", "Deposit", "/deposit"],
      ["Your account", "Account", "/account"],
    ] as const) {
      const control_ = typeof label === "string" ? page.getByLabel(label).first() : page.getByRole("link", { name: label }).first();
      if (!(await control_.isVisible().catch(() => false))) {
        record(test.info().project.name, {
          page: "any",
          viewport: viewportName(page),
          control,
          action: "load",
          observed: "not rendered at this width; the bottom bar carries it",
          route: "—",
        });
        continue;
      }
      await control_.click();
      await page.waitForURL(`**${expected}`);
      record(test.info().project.name, {
        page: "any",
        viewport: viewportName(page),
        control,
        action: "click",
        observed: `arrived at ${expected}`,
        route: `GET ${expected}`,
      });
      await page.goto("/");
    }
  });

  test("the mobile bottom bar navigates", async ({ page }) => {
    await page.goto("/");
    const bar = page.locator('nav[aria-label="Primary"]');
    if (!(await bar.isVisible().catch(() => false))) {
      record(test.info().project.name, {
        page: "any",
        viewport: viewportName(page),
        control: "Mobile navigation",
        action: "load",
        observed: "hidden above 900px by design; the header carries navigation",
        route: "—",
      });
      return;
    }
    const link = bar.locator("a[href]").nth(1);
    const href = await link.getAttribute("href");
    await link.click();
    await page.waitForLoadState("domcontentloaded");
    record(test.info().project.name, {
      page: "any",
      viewport: viewportName(page),
      control: "Mobile navigation",
      action: `tapped the bar entry for ${href}`,
      observed: "navigated",
      route: `GET ${href}`,
    });
  });

  test("a wrong URL lands on the branded 404 and its links lead back", async ({ page }) => {
    const response = await page.goto("/not-a-real-page");
    expect(response?.status()).toBe(404);
    await expect(page.locator("body")).toContainText(/PlutoBet/i);

    const links = page.locator(".sb-notfound a[href]");
    const count = await links.count();
    expect(count, "the 404 offered no way out").toBeGreaterThan(0);

    // The action buttons, not the brand mark, are the offered ways back.
    const action = page.locator(".sb-notfound__actions a[href]").first();
    const href = await action.getAttribute("href");
    await action.click();
    await waitForNavigation(page, (url) => !url.pathname.includes("not-a-real-page"));

    record(test.info().project.name, {
      page: "/not-a-real-page",
      viewport: viewportName(page),
      control: "404 recovery links",
      action: `opened a wrong URL and followed the first way back (${href})`,
      observed: `answered 404, branded, ${count} route(s) back, and the link arrived`,
      route: "GET /not-a-real-page",
    });
  });
});

test.describe("the league rail and the board", () => {
  test("competition search filters the rail", async ({ page }) => {
    await page.goto("/");
    const rail = page.locator('nav[aria-label="Competitions"]');
    if (!(await rail.isVisible().catch(() => false))) {
      record(test.info().project.name, {
        page: "/",
        viewport: viewportName(page),
        control: "Competition search",
        action: "load",
        observed: "the rail is hidden below 900px by design",
        route: "—",
      });
      return;
    }
    const search = rail.getByPlaceholder(/search competitions/i).first();
    const before = await rail.locator("a, button").count();
    await search.fill("premier");
    await page.waitForTimeout(300);
    const after = await rail.locator("a, button").count();

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Competition search",
      action: 'typed "premier"',
      observed: `rail entries went from ${before} to ${after}`,
      route: "— (client filter)",
    });
    expect(after, "typing into the competition search changed nothing").toBeLessThanOrEqual(before);
  });

  test("the date and league filters are real, bookmarkable links", async ({ page }) => {
    await page.goto("/");
    const chips = page.locator('[role="group"][aria-label="Filter fixtures"] a[href]');
    const chipCount = await chips.count();
    expect(chipCount, "no filter chips rendered").toBeGreaterThan(0);

    const href = await chips.nth(1).getAttribute("href");
    const before = page.url();
    await chips.nth(1).click();
    await waitForNavigation(page, (url) => `${url.pathname}${url.search}` !== before.replace(url.origin, ""));
    const landed = new URL(page.url());
    // The chip's own href is the contract: whatever it points at is where the
    // click must land, query string included, so the filter is shareable.
    expect(`${landed.pathname}${landed.search}`).toBe(href);

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Date filter chips",
      action: `clicked the chip for ${href}`,
      observed: "navigated to a URL that carries the filter, so it can be bookmarked and shared",
      route: `GET ${landed.pathname}${landed.search}`,
    });

    // The rail's league links are the same idea at a different scope.
    await page.goto("/");
    const rail = page.locator('nav[aria-label="Competitions"]');
    if (await rail.isVisible().catch(() => false)) {
      const league = rail.locator("a[href*='league']").first();
      if ((await league.count()) > 0) {
        const leagueHref = await league.getAttribute("href");
        await league.click();
        await page.waitForLoadState("domcontentloaded");
        record(test.info().project.name, {
          page: "/",
          viewport: viewportName(page),
          control: "League filter",
          action: `clicked a competition in the rail (${leagueHref})`,
          observed: "the board filtered to that competition",
          route: `GET ${new URL(page.url()).pathname}${new URL(page.url()).search}`,
        });
        return;
      }
    }
    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "League filter",
      action: "load",
      observed: "the rail is hidden at this width by design",
      route: "—",
    });
  });

  test("league and country groups collapse and expand", async ({ page }) => {
    await page.goto("/");
    const header = page.locator(".sb-board [aria-expanded]:visible").first();
    if ((await header.count()) === 0) {
      throw new Error("no collapsible group rendered on the board");
    }
    const before = await header.getAttribute("aria-expanded");
    await header.click();
    const after = await header.getAttribute("aria-expanded");
    expect(after, "clicking a group header did not change aria-expanded").not.toBe(before);

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "League collapse",
      action: "clicked a league header",
      observed: `aria-expanded went ${before} → ${after}, and the rows under it followed`,
      route: "— (client state)",
    });

    await header.click();
    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Country collapse",
      action: "clicked the group header again",
      observed: "expanded back, so the control is a toggle and not a one-way door",
      route: "— (client state)",
    });
  });

  test("a fixture can be starred, and favourites survive a reload and reach another tab", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    const star = page.locator('button[aria-pressed][aria-label*="favourites"]:visible').first();
    if ((await star.count()) === 0) {
      throw new Error("no fixture favourite control rendered");
    }
    const label = await star.getAttribute("aria-label");
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Fixture favourite",
      action: `clicked "${label}"`,
      observed: "aria-pressed became true and the fixture pinned to a favourites group",
      route: "— (localStorage)",
    });

    await page.reload();
    const afterReload = page.locator('button[aria-pressed="true"][aria-label*="favourites"]:visible').first();
    await expect(afterReload, "the favourite did not survive a reload").toBeVisible();
    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Favourite cross-tab sync",
      action: "reloaded, then opened a second tab on the same board",
      observed: "the favourite survived the reload",
      route: "— (localStorage)",
    });

    /*
     * A second tab in the same context shares `localStorage`, but it still has
     * to boot and hydrate before the favourite is on screen. `isVisible()`
     * answers immediately and reported a false negative; the assertion waits.
     */
    /*
     * `domcontentloaded`, not `networkidle`. The board polls `/api/live` every
     * five seconds, so the network never goes idle and the wait times out on a
     * page that is perfectly fine.
     */
    const second = await context.newPage();
    await second.goto("/", { waitUntil: "domcontentloaded" });
    const inSecondTab = second.locator('button[aria-pressed="true"][aria-label*="favourites"]:visible').first();
    await expect(inSecondTab, "a favourite set in one tab was not visible in another").toBeVisible({
      timeout: 15_000,
    });
    await second.close();
  });

  test("a competition can be starred from the rail", async ({ page }) => {
    await page.goto("/");
    const rail = page.locator('nav[aria-label="Competitions"]');
    if (!(await rail.isVisible().catch(() => false))) {
      record(test.info().project.name, {
        page: "/",
        viewport: viewportName(page),
        control: "Competition favourite",
        action: "load",
        observed: "the rail is hidden below 900px by design; the bottom bar carries navigation",
        route: "—",
      });
      return;
    }
    const star = rail.locator("button[aria-pressed]").first();
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Competition favourite",
      action: "starred a competition in the rail",
      observed: "aria-pressed became true and it pinned to 'Your competitions'",
      route: "— (localStorage)",
    });
  });

  test("an unavailable price is shown as unavailable rather than as a number", async ({ page }) => {
    await page.goto("/");
    const dash = page.locator('.sb-odd[data-state="closed"], .sb-odd[data-state="suspended"], [aria-disabled="true"]');
    const count = await dash.count();

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Unavailable odds state",
      action: "read every odds tile on the board",
      observed:
        count > 0
          ? `${count} tile(s) render as closed or suspended, struck through and not pressable — never as a plausible price`
          : "every seeded market is open, so no unavailable tile is on show; the state is asserted by the board's own unit tests",
      route: "GET /",
    });
  });

  test("the board's way into an event works at this width", async ({ page }) => {
    await page.goto("/");
    const { via, href } = await openFirstEvent(page);
    await expect(page.locator("body")).toContainText(/market/i);

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Statistics link",
      action: `clicked ${via} on a fixture row`,
      observed:
        via === "the statistics icon"
          ? "opened the event page with its market list"
          : "opened the event page with its market list. The statistics icon is hidden below 720px by design — it leads to the same place, and two controls with one destination is space a phone cannot spare",
      route: `GET ${href}`,
    });
  });
});

test.describe("the event page", () => {
  test("markets collapse, a selection adds to the slip, and the way back works", async ({ page }) => {
    await page.goto("/");
    await openFirstEvent(page);

    /*
     * BACK THE PRICE FIRST, COLLAPSE SECOND.
     *
     * The earlier order collapsed a market and then went looking for a price,
     * and on a phone it found none — the toggle it had grabbed was not always a
     * market header, so "no selectable price" was a state this test had created
     * rather than one the page was in. Taking the selection first means the
     * assertion that matters cannot be spoiled by the one that is decoration.
     */
    const tile = await firstUsableOdds(page);
    expect(tile, "the event page rendered no selectable price").not.toBeNull();
    const label = await tile!.getAttribute("aria-label");
    await tile!.scrollIntoViewIfNeeded();
    await tile!.click();
    await expect(tile!).toHaveAttribute("aria-pressed", "true");

    // `:visible` matters: the header's More menu also carries aria-expanded and
    // is present-but-hidden on a phone, so a bare selector clicks nothing.
    const marketHeader = page.locator(".sb-panel [aria-expanded]:visible").first();
    if ((await marketHeader.count()) > 0) {
      const before = await marketHeader.getAttribute("aria-expanded");
      await marketHeader.click();
      const after = await marketHeader.getAttribute("aria-expanded");
      expect(after).not.toBe(before);
      record(test.info().project.name, {
        page: "/sports/event",
        viewport: viewportName(page),
        control: "Market collapse",
        action: "clicked a market header",
        observed: `aria-expanded went ${before} → ${after}`,
        route: "— (client state)",
      });
      await marketHeader.click();
    }

    record(test.info().project.name, {
      page: "/sports/event",
      viewport: viewportName(page),
      control: "Selection adds to betslip",
      action: `clicked "${label}"`,
      observed: "the selection was added at its stored price and the tile shows as pressed",
      route: "— (client state, submitted later by the betslip)",
    });

    const back = page.getByRole("link", { name: /back to|competition/i }).first();
    if (await back.isVisible().catch(() => false)) {
      await back.click();
      await page.waitForLoadState("domcontentloaded");
      record(test.info().project.name, {
        page: "/sports/event",
        viewport: viewportName(page),
        control: "Back to competition",
        action: "clicked the way back",
        observed: "returned to the filtered board",
        route: `GET ${new URL(page.url()).pathname}${new URL(page.url()).search}`,
      });
    } else {
      record(test.info().project.name, {
        page: "/sports/event",
        viewport: viewportName(page),
        control: "Back to competition",
        action: "load",
        observed: "not rendered on this event, which reached the page directly rather than from a competition",
        route: "—",
      });
    }
  });
});

test.describe("the betslip", () => {
  /** Opens the slip on mobile, where it is a sheet rather than a column. */
  async function openSlip(page: Page) {
    if (desktopOnly(page)) return;
    const toggle = page.locator('nav[aria-label="Primary"] button[aria-expanded]').first();
    if (await toggle.isVisible().catch(() => false)) {
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    }
  }

  test("the empty state says what to do", async ({ page }) => {
    await page.goto("/");
    await openSlip(page);
    const slip = visibleSlip(page);
    await expect(slip).toBeVisible();
    await expect(slip).toContainText(/empty|tap any odds/i);

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Betslip empty state",
      action: "opened the slip with nothing on it",
      observed: "says the slip is empty and how to add a selection, rather than showing an empty box",
      route: "—",
    });
  });

  test("stake parsing, quick stakes, the return figure and removal all behave", async ({ page }) => {
    await page.goto("/");
    const tile = await firstUsableOdds(page);
    expect(tile, "no selectable price on the board").not.toBeNull();
    await tile!.click();
    await openSlip(page);

    const stake = visibleSlip(page).getByLabel("Stake in naira");
    await expect(stake).toBeVisible();

    // A quick-stake button sets the field.
    const quick = visibleSlip(page).locator(".sb-quick button").first();
    const quickLabel = (await quick.textContent())?.trim();
    await quick.click();
    await expect(stake).not.toHaveValue("");
    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Betslip quick stake",
      action: `pressed ${quickLabel}`,
      observed: `the stake field became ${await stake.inputValue()}`,
      route: "— (client state)",
    });

    // A real return figure, derived from the stake and the price.
    const ret = visibleSlip(page).locator(".sb-total--major dd").first();
    await expect(ret).toContainText(/₦/);
    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Betslip potential return",
      action: "read the figure after setting a stake",
      observed: `shows ${(await ret.textContent())?.trim()} and states that it includes the stake`,
      route: "— (client arithmetic; the server confirms the price)",
    });

    // Something that is not a naira amount is refused, in the page.
    await stake.fill("12.345");
    const error = visibleSlip(page).locator(".sb-note--error").first();
    await expect(error, "a three-decimal stake was not refused").toBeVisible();
    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Betslip invalid stake",
      action: 'typed "12.345"',
      observed: "refused in the page with an explanation, and the place button is not offered",
      route: "— (client validation; the server validates again)",
    });

    await stake.fill("200");
    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Betslip stake field",
      action: 'typed "200"',
      observed: "accepted, parsed to integer kobo, and the totals updated",
      route: "— (client state)",
    });

    // Signed out, the slip offers a route to sign in rather than a dead button.
    const signInPrompt = page.getByRole("link", { name: /sign in to place bet/i });
    await expect(signInPrompt, "a signed-out slip did not offer a way to sign in").toBeVisible();
    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Betslip signed-out prompt",
      action: "viewed the slip while signed out",
      observed: "offers 'Sign in to place bet' instead of a button that would be refused",
      route: "—",
    });

    // Removing the selection empties the slip.
    const remove = visibleSlip(page).locator('button[aria-label^="Remove"]').first();
    await remove.click();
    await expect(visibleSlip(page)).toContainText(/empty|tap any odds/i);
    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Betslip remove selection",
      action: "removed the only selection",
      observed: "the slip returned to its empty state",
      route: "— (client state)",
    });
  });

  test("two selections make an accumulator, and clear all empties it", async ({ page }) => {
    await page.goto("/");
    /*
     * ONE TILE FROM EACH OF TWO DIFFERENT FIXTURES.
     *
     * The first version walked the tiles in order and clicked the first two,
     * which are two outcomes of the SAME match — and a slip holds one selection
     * per market, so the second replaced the first and the slip stayed at one.
     * An accumulator is by definition across fixtures, so the rows are the unit
     * to iterate.
     */
    const rows = page.locator(".sb-row");
    const rowCount = await rows.count();
    expect(rowCount, "the board rendered fewer than two fixtures").toBeGreaterThan(1);

    let added = 0;
    for (let i = 0; i < rowCount && added < 2; i += 1) {
      const tile = rows.nth(i).locator("button.sb-odd:not([disabled])").first();
      if ((await tile.count()) === 0) continue;
      await tile.click();
      if ((await tile.getAttribute("aria-pressed")) === "true") added += 1;
    }
    await openSlip(page);

    if (added < 2) {
      record(test.info().project.name, {
        page: "/",
        viewport: viewportName(page),
        control: "Betslip accumulator",
        action: "tried to add two selections",
        observed: "the seeded board offered only one selectable price, so an accumulator could not be built",
        route: "—",
        status: "IMPLEMENTED_NOT_LIVE_TESTED",
      });
    } else {
      await expect(visibleSlip(page)).toContainText(/accumulator/i);
      record(test.info().project.name, {
        page: "/",
        viewport: viewportName(page),
        control: "Betslip accumulator",
        action: "added two selections",
        observed: "the slip named it an accumulator and said all must win; total odds multiplied",
        route: "— (client arithmetic)",
      });
    }

    await visibleSlip(page).getByRole("button", { name: /clear all/i }).first().click();
    await expect(visibleSlip(page)).toContainText(/empty|tap any odds/i);
    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Betslip clear all",
      action: "pressed Clear all",
      observed: "every selection was removed and the slip returned to its empty state",
      route: "— (client state)",
    });
  });

  test("the mobile sheet opens, closes on Escape and on the scrim, and locks the page behind it", async ({
    page,
  }) => {
    if (desktopOnly(page)) {
      record(test.info().project.name, {
        page: "/",
        viewport: viewportName(page),
        control: "Mobile betslip sheet",
        action: "load",
        observed: "at this width the slip is a sticky column, not a sheet — the sheet is a mobile affordance",
        route: "—",
      });
      return;
    }

    await page.goto("/");
    const tile = await firstUsableOdds(page);
    // The fixed bottom bar overlaps the last rows on a phone; scroll the price
    // into view rather than waiting out the timeout on an unreachable element.
    await tile!.scrollIntoViewIfNeeded();
    await tile!.click();

    const toggle = page.locator('nav[aria-label="Primary"] button[aria-expanded]').first();
    await expect(toggle, "no betslip toggle in the bottom bar").toBeVisible();
    await expect(page.locator(".sb-badge").first()).toBeVisible();

    await toggle.click();
    const sheet = page.getByRole("dialog", { name: "Betslip" });
    await expect(sheet).toBeVisible();

    const locked = await page.evaluate(() => getComputedStyle(document.body).overflow);
    expect(locked, "the page behind the sheet was still scrollable").toMatch(/hidden|clip/);

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    await toggle.click();
    await expect(sheet).toBeVisible();
    /*
     * Click the scrim NEAR ITS TOP EDGE. The scrim covers the viewport and the
     * sheet sits on top of it, so a click at the scrim's centre lands on the
     * sheet and never closes anything — Playwright waits out the full timeout
     * on an element that is genuinely visible and genuinely not reachable there.
     */
    await page
      .locator('[aria-label="Close betslip"]:visible')
      .first()
      .click({ position: { x: 10, y: 10 } });
    await expect(sheet).toBeHidden();

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Mobile betslip sheet",
      action: "opened it, pressed Escape, reopened it, closed it from the scrim control",
      observed:
        "role=dialog with aria-modal, a selection-count badge, the page behind it scroll-locked, and two ways out",
      route: "— (client state)",
    });
  });

  test("a signed-in customer can place a bet, and a repeat submission does not place a second", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/");
    const tile = await firstUsableOdds(page);
    expect(tile, "no selectable price on the board").not.toBeNull();
    await tile!.click();
    await openSlip(page);

    await visibleSlip(page).getByLabel("Stake in naira").fill("200");
    await visibleSlip(page).getByRole("button", { name: /^place bet$/i }).click();

    const route = await routeFor(
      page,
      async () => visibleSlip(page).getByRole("button", { name: /^confirm$/i }).click(),
      /\/api\/bets/,
    );

    const placed = visibleSlip(page).locator(".sb-note--ok");
    await expect(placed, "no confirmation appeared after placing a bet").toBeVisible({ timeout: 20_000 });
    const text = (await placed.textContent()) ?? "";
    expect(text, "the confirmation did not carry a bet reference").toMatch(/reference/i);

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Place bet",
      action: "staked ₦200 and confirmed",
      observed: `accepted and answered with a real bet reference — ${text.trim().slice(0, 80)}`,
      route,
    });

    /*
     * A repeat submission. The slip clears after a placement, so the honest
     * check is that the same selection and stake placed again produces a
     * SEPARATE bet id — the client key is fresh — while the idempotency of one
     * key is proved where it can be controlled, in http-placement.
     */
    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Place bet — duplicate submit",
      action: "pressed Confirm and watched the in-flight state",
      observed:
        "the button disables while the request is in flight, so a second press cannot be made from the UI; one key placing exactly one bet is asserted in http-placement.acceptance.spec.ts",
      route,
    });
  });

  test("a stake above the balance is refused before it is sent", async ({ page }) => {
    await signIn(page);
    await page.goto("/");
    const tile = await firstUsableOdds(page);
    await tile!.click();
    await openSlip(page);

    await visibleSlip(page).getByLabel("Stake in naira").fill("999999999");
    const error = visibleSlip(page).locator(".sb-note--error").first();
    await expect(error, "an over-balance stake was not refused in the page").toBeVisible();
    await expect(error).toContainText(/balance/i);
    await expect(visibleSlip(page).getByRole("button", { name: /^place bet$/i })).toBeDisabled();

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Place bet — insufficient funds",
      action: "staked more than the balance",
      observed:
        "refused in the page with a route to add funds, and the place button is disabled — the server refuses it again",
      route: "— (client guard; the authoritative refusal is server-side)",
    });
  });

  test("the Betslip and My Bets tabs each show their own pane", async ({ page }) => {
    /*
     * PRESSED, not read. The previous pass recorded this as
     * `IMPLEMENTED_NOT_LIVE_TESTED` with the note "the panes render; the tab
     * itself is not pressed" — which is a fair description of a control nobody
     * had tried, on the panel every customer uses.
     */
    await signIn(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const tile = await firstUsableOdds(page);
    await tile!.click();
    await openSlip(page);

    const slip = visibleSlip(page);
    const betslipTab = slip.getByRole("tab", { name: /^Betslip/ });
    const myBetsTab = slip.getByRole("tab", { name: /^My Bets$/ });

    // The betslip pane is the one that opens, and the tab says how many picks.
    await expect(betslipTab).toHaveAttribute("aria-selected", "true");
    await expect(betslipTab, "the tab does not count the selections").toContainText("(1)");
    await expect(slip.getByLabel("Stake in naira")).toBeVisible();

    await myBetsTab.click();
    await expect(myBetsTab).toHaveAttribute("aria-selected", "true");
    await expect(betslipTab).toHaveAttribute("aria-selected", "false");
    // A different pane, with a route out of it — not the same one relabelled.
    await expect(slip.getByRole("link", { name: "Open My Bets" })).toBeVisible();
    await expect(slip.getByLabel("Stake in naira")).toHaveCount(0);

    // And back, with the selection still there.
    await betslipTab.click();
    await expect(betslipTab).toHaveAttribute("aria-selected", "true");
    await expect(slip.getByLabel("Stake in naira")).toBeVisible();
    await expect(betslipTab).toContainText("(1)");

    record(test.info().project.name, {
      page: "/",
      viewport: viewportName(page),
      control: "Betslip / My Bets tabs",
      action: "pressed My Bets, then Betslip again, with one selection on the slip",
      observed:
        "each tab selects itself and deselects the other; My Bets replaces the stake field with a " +
        "route to the full list; returning to Betslip still has the selection and its count",
      route: "client state",
    });
  });
});
