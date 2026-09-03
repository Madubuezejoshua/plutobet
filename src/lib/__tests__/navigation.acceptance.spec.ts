import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NAV_ITEMS, UTILITY_ROUTES, liveProducts, navItemForPath } from "../navigation";

/**
 * The navigation registry is a set of promises.
 *
 * Every entry says "press this and something happens". These tests hold the
 * registry to that, and to two rules the redesign introduced:
 *
 *  1. No internal build-phase numbers. They meant nothing to a customer and
 *     read as a delivery commitment nobody had made.
 *  2. No emoji as the only identity of a destination. Emoji render differently
 *     on every platform, several are unreadable at 16px on a cheap Android
 *     screen, and screen readers announce their CLDR name, not the product's.
 */

const appDir = fileURLToPath(new URL("../../app", import.meta.url));

/** Does a route file exist for this path under the (site) group? */
function routeExists(href: string): boolean {
  const segment = href === "/" ? "" : href;
  return (
    existsSync(`${appDir}/(site)${segment}/page.tsx`) ||
    existsSync(`${appDir}${segment}/page.tsx`)
  );
}

describe("navigation registry", () => {
  it("routes every entry to a page that exists", () => {
    const missing = NAV_ITEMS.filter((item) => !routeExists(item.href)).map((i) => i.href);
    expect(missing).toEqual([]);
  });

  it("routes every utility destination to a page or an auth endpoint", () => {
    for (const [name, href] of Object.entries(UTILITY_ROUTES)) {
      const reachable = routeExists(href) || href.startsWith("/api/auth/");
      expect(reachable, `${name} -> ${href} is not reachable`).toBe(true);
    }
  });

  it("sends sign-in to the branded page rather than the framework default", () => {
    // NextAuth's own page is unbranded and is not configured as `pages.signIn`.
    // If this ever points back at /api/auth/signin, customers land on a page
    // that does not look like this product.
    expect(UTILITY_ROUTES.signIn).toBe("/signin");
  });

  it("carries no build-phase numbers", () => {
    for (const item of NAV_ITEMS) {
      expect(item, `${item.key} still carries a phase`).not.toHaveProperty("phase");
      expect(/phase\s*\d/i.test(item.blurb), `${item.key} blurb names a phase`).toBe(false);
    }
  });

  it("carries no emoji", () => {
    // Covers the pictographic and symbol blocks the previous icons came from.
    const emoji = /[\u{2190}-\u{2BFF}\u{1F000}-\u{1FAFF}\u{FE0F}]/u;
    for (const item of NAV_ITEMS) {
      expect(item, `${item.key} still carries an icon glyph`).not.toHaveProperty("icon");
      expect(emoji.test(item.label), `${item.key} label contains emoji`).toBe(false);
      expect(emoji.test(item.blurb), `${item.key} blurb contains emoji`).toBe(false);
    }
  });

  it("has unique keys and unique paths", () => {
    expect(new Set(NAV_ITEMS.map((i) => i.key)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((i) => i.href)).size).toBe(NAV_ITEMS.length);
  });

  it("never promotes a product that is not built", () => {
    for (const product of liveProducts()) {
      expect(product.status).toBe("LIVE");
    }
  });

  it("makes every planned product say what it is actually waiting on", () => {
    /*
     * The placeholder used to assert one blocker for all three planned
     * products — "it needs a provider we have not connected". That is true of a
     * streamed casino and a licensed draw, and false of Fantasy, which needs
     * building rather than connecting. A page that reads as honest while giving
     * a reason that is not the real one is a fabricated blocker, which is the
     * same defect as a fabricated feature.
     *
     * Required here rather than defaulted in the component, so that adding a
     * planned product forces somebody to say why it is not available.
     */
    for (const item of NAV_ITEMS.filter((candidate) => candidate.status === "PLANNED")) {
      expect(item.waitingOn, `${item.key} does not say why it is unavailable`).toBeTruthy();
      expect(item.waitingOn!.length, `${item.key}'s reason is too short to mean anything`)
        .toBeGreaterThan(20);
    }
  });

  it("does not put a reason on a product that is live", () => {
    for (const item of NAV_ITEMS.filter((candidate) => candidate.status === "LIVE")) {
      expect(item.waitingOn, `${item.key} is live but claims to be waiting`).toBeUndefined();
    }
  });

  it("resolves a path to its longest matching entry", () => {
    expect(navItemForPath("/")?.key).toBe("home");
    expect(navItemForPath("/sports")?.key).toBe("sports");
    expect(navItemForPath("/account/security")?.key).toBe("account");
    expect(navItemForPath("/nothing-here")).toBeUndefined();
  });
});
