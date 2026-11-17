import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Placing a bet through the visible interface, reused by every spec that needs
 * a real ticket rather than a row inserted behind the product's back.
 *
 * Extracted because six specs now need it and each had been about to grow its
 * own copy. A private copy of "find a price, stake, confirm" in six files is
 * six places for a selector to rot, and the first one to rot silently stops
 * testing placement while still passing.
 */

/** The betslip the customer can actually reach at this width. */
export function visibleSlip(page: Page): Locator {
  /*
   * The panel is rendered TWICE — sticky column and mobile sheet — and below
   * 1180px the column is hidden rather than unmounted. An id or a bare
   * `.first()` therefore finds the copy nobody can touch, which is how a mobile
   * test passes while filling in a field the customer cannot see.
   */
  return page.locator('[aria-label="Betslip"]:visible').first();
}

/** Opens the mobile betslip sheet when the sticky column is not on screen. */
export async function openSlipIfCollapsed(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) >= 1180) return;
  const toggle = page.locator('nav[aria-label="Primary"] button[aria-expanded]').first();
  if ((await toggle.count()) === 0) return;
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

/**
 * Backs the first available price on an event page.
 *
 * TAKES THE PROVIDER'S ID, NOT OURS. `/sports/event/[id]` looks the fixture up
 * by `provider_event_id` — `getEventView` names its parameter that and queries
 * that column. Passing our internal uuid gives a 404 and a test that reports
 * "the event page offered no price", which is a true statement about a page
 * that was never the right page.
 *
 * Returns the tile so a caller can assert against the exact selection it
 * pressed rather than against whatever happens to be first later on.
 */
export async function backFirstPrice(page: Page, providerEventId: string): Promise<Locator> {
  await page.goto(`/sports/event/${providerEventId}`, { waitUntil: "domcontentloaded" });
  const tile = page.locator("button.sb-odd:not([disabled])").first();
  await expect(tile, "the event page offered no price to back").toBeVisible();
  /*
   * ONLY IF IT IS NOT ALREADY ON THE SLIP. The tile TOGGLES, and the slip
   * survives navigation in session storage — so a test that backs the same
   * price twice in one run un-selects it the second time and then reports that
   * the price was never selected, which is true and completely misleading.
   */
  if ((await tile.getAttribute("aria-pressed")) !== "true") await tile.click();
  await expect(tile).toHaveAttribute("aria-pressed", "true");
  return tile;
}

/**
 * Puts the slip back to empty on the board.
 *
 * A placed slip stays on screen as a confirmation with a "New betslip" button,
 * and its picks are still in session storage. Anything that places a SECOND bet
 * in the same test has to press that button first, or it finds a confirmation
 * where the stake field should be.
 */
export async function startFreshSlip(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openSlipIfCollapsed(page);
  const slip = visibleSlip(page);

  const fresh = slip.getByRole("button", { name: /^new betslip$/i });
  if ((await fresh.count()) > 0 && (await fresh.first().isVisible())) {
    await fresh.first().click();
  }
  const clearAll = slip.getByRole("button", { name: /^clear all$/i });
  if ((await clearAll.count()) > 0 && (await clearAll.first().isVisible())) {
    await clearAll.first().click();
  }
}

export interface PlacementResult {
  ok: boolean;
  status: number;
  reference: string | null;
  message: string | null;
}

/**
 * Stakes and confirms, and reports what the customer was told.
 *
 * Deliberately does NOT assert success. Half the specs using this want a
 * refusal — a cool-off, a suspended market, a stale price — and a helper that
 * threw on anything but a placed bet would force each of them to reimplement
 * the flow just to watch it fail.
 */
export async function placeFromSlip(page: Page, stakeNaira: string): Promise<PlacementResult> {
  await openSlipIfCollapsed(page);
  const slip = visibleSlip(page);
  await slip.getByLabel("Stake in naira").fill(stakeNaira);
  await slip.getByRole("button", { name: /^place bet$/i }).click();

  const responding = page
    .waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/bets" && r.request().method() === "POST",
      { timeout: 30_000 },
    )
    .catch(() => null);
  await slip.getByRole("button", { name: /^confirm$/i }).click();
  const response = await responding;

  const ok = slip.locator(".sb-note--ok");
  const error = slip.locator(".sb-note--error, [role='alert']");

  // Whichever the product says first. Racing them rather than waiting for one
  // means a refusal does not have to time out before it can be read.
  await Promise.race([
    ok.first().waitFor({ state: "visible", timeout: 25_000 }).catch(() => null),
    error.first().waitFor({ state: "visible", timeout: 25_000 }).catch(() => null),
  ]);

  const placed = (await ok.count()) > 0 && (await ok.first().isVisible());
  const text = placed
    ? ((await ok.first().textContent()) ?? "")
    : (await error.count()) > 0
      ? ((await error.first().textContent()) ?? "")
      : "";

  return {
    ok: placed,
    status: response?.status() ?? 0,
    reference: placed ? (/[0-9a-f]{8}/i.exec(text)?.[0] ?? null) : null,
    message: placed ? null : text.trim() || null,
  };
}

/** The CASH figure the customer can see on /wallet, in kobo. */
export async function visibleCashMinor(page: Page): Promise<bigint> {
  await page.goto("/wallet", { waitUntil: "domcontentloaded" });
  const text = await page.locator("body").innerText();
  const match = /₦\s*([\d,]+)\.(\d{2})/.exec(text);
  if (!match) throw new Error(`no naira figure rendered on /wallet:\n${text.slice(0, 400)}`);
  return BigInt(match[1]!.replace(/,/g, "")) * 100n + BigInt(match[2]!);
}

export function naira(minor: bigint): string {
  return `₦${(Number(minor) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
}

/** The status pill My Bets shows for one bet reference, or null if absent. */
export async function betStatusOnPage(page: Page, reference: string): Promise<string | null> {
  await page.goto("/bets", { waitUntil: "domcontentloaded" });
  const row = page.locator("tr, li, article").filter({ hasText: reference }).first();
  if ((await row.count()) === 0) return null;
  const text = (await row.innerText()).toUpperCase();
  for (const status of ["CASHED OUT", "PENDING", "WON", "LOST", "VOID"]) {
    if (text.includes(status)) return status;
  }
  return null;
}
