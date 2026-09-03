import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests against a REVIEW SERVER, never against production.
 *
 * The server is started by hand and pointed at a disposable local database
 * seeded with `npm run db:seed-demo` — deliberately not by `webServer` here.
 * Starting it from this config would make it easy to run the suite against
 * whatever `.env` happens to hold, and `.env` holds production credentials. A
 * base URL that has to be supplied is a base URL somebody thought about.
 *
 *   npx tsx scripts/dev-stack.ts                     # local Postgres + Redis
 *   npm run db:migrate && npm run db:seed-demo       # with the local URLs
 *   npx next build && npx next start -p 3100         # with the local URLs
 *   npx playwright test
 *
 * `PLAYWRIGHT_BASE_URL` overrides the default if the port differs.
 */

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./artifacts/playwright",
  /*
   * Serial. These tests place bets, cash them out and settle them against one
   * shared database; running them in parallel would make each one's balance
   * assertions depend on what another happened to be doing.
   */
  fullyParallel: false,
  workers: 1,
  /*
   * No retries. A flaky money test is a defect report, not something to paper
   * over — and a retry that passes hides exactly the race worth finding.
   */
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["json", { outputFile: "artifacts/playwright-report.json" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    // A real browser's default, so nothing here passes because of a permissive
    // automation setting a customer would not have.
    ignoreHTTPSErrors: false,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      // A real device profile: touch, a mobile user agent, and a device pixel
      // ratio. A desktop Chrome narrowed to 390px is not a phone, and the
      // difference is where mobile-only defects hide.
      use: { ...devices["Pixel 7"] },
    },
  ],
});
