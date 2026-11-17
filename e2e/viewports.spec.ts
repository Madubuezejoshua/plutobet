import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, expectNoProblems, watchForProblems } from "./support";

/**
 * The seven viewports the owner named, swept across every public page.
 *
 * The two Playwright projects cover 1440×900 and a Pixel 7 in depth — real
 * device emulation, interactions, the lot. This is the other axis: shallow, but
 * WIDE, because responsive defects are not evenly distributed. They cluster at
 * the boundaries where a layout changes its mind, and this product changes its
 * mind at 600px, 900px and 1100px.
 *
 * 768×1024 and 1024×768 are the same tablet held two ways, and they are here
 * for that reason: one lands just under a breakpoint and the other just over.
 * A layout that has only ever been seen on a phone and a laptop has never been
 * seen at the width where its rules swap.
 *
 * WHAT IT ASSERTS AND WHAT IT DOES NOT. Every page, at every size: it answers,
 * it does not scroll sideways, and it logs nothing. It does not check that the
 * result looks good — no automated check does, which is what the screenshots
 * and the contact sheet are for. It checks that nothing is broken, which is a
 * smaller claim and the one that can be made honestly.
 */

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844, note: "iPhone 12/13/14" },
  { name: "430x932", width: 430, height: 932, note: "iPhone Pro Max" },
  { name: "768x1024", width: 768, height: 1024, note: "tablet portrait" },
  { name: "1024x768", width: 1024, height: 768, note: "tablet landscape" },
  { name: "1366x768", width: 1366, height: 768, note: "the commonest laptop" },
  { name: "1440x900", width: 1440, height: 900, note: "large laptop" },
  { name: "1920x1080", width: 1920, height: 1080, note: "desktop" },
];

const PAGES = [
  "/",
  "/sports",
  "/live",
  "/results",
  "/livescore",
  "/jackpot",
  "/promotions",
  "/casino",
  "/virtuals",
  "/pluto",
  "/signin",
  "/register",
  "/fantasy",
];

test.describe("responsive sweep", () => {
  // Run once. The two projects differ by device emulation, and this suite
  // overrides the viewport anyway, so running it twice would double the time
  // to re-measure the same widths.
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name} (${viewport.note}) fits every page`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "swept once, on the desktop project");

      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      const failures: string[] = [];

      for (const path of PAGES) {
        const problems = watchForProblems(page);
        const response = await page.goto(path, { waitUntil: "networkidle" });

        if ((response?.status() ?? 0) >= 400) {
          failures.push(`${path} answered ${response?.status()}`);
          continue;
        }

        /*
         * Collected rather than thrown, so one run names EVERY page that fails
         * at this width. Failing on the first means fixing them one round trip
         * at a time, and at seven viewports across thirteen pages that is a
         * long afternoon of learning one fact at a time.
         */
        try {
          await expectNoHorizontalOverflow(page, `${path} at ${viewport.name}`);
          expectNoProblems(problems, `${path} at ${viewport.name}`);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }

      expect(failures, `${failures.length} page(s) broke at ${viewport.name}`).toEqual([]);
    });
  }
});
