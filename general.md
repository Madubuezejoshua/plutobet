# PlutoBet — general status

**This file is the single source of truth for the state of this project.**
Every other document in the repository is either a runbook, an owner checklist,
or historical evidence of one pass. Where any of them disagrees with this file,
this file is right.

**Last updated:** 2026-11-19
**Branch described:** `main`, which now carries the completed gap-closure pass
**Merged to `main`:** **yes**, in two steps and with no history rewritten. The
owner merged PR #1 on `plutobet-ai/plutobet_ai`, and the three commits made
after it were merged forward on top of that. Nothing was rebased or forced —
those commits were already published.
**Pushed:** the Next.js security patch was requested for `origin/main` and is
published there. `plutobet-ai/plutobet_ai` was not part of this request.
**Deployment:** the result of the platform build triggered by the push has not
been verified. A local production build passed; that is not evidence of a
remote deployment.
**The platform this project deploys to is RAILWAY**, stated by the owner on
2026-09-06. The previously observed Vercel integration on `origin` is described
as historical in §0. **Railway's live state cannot be seen from this
repository** and is not asserted here.
Commit count, branch and remote state are recorded in §0, read from git, and
checked by `npm run ci:docs` — never repeated from this header.

**No credential, connection string, one-time code, personal detail or other
secret value appears anywhere in this document, and none may be added to it.**
Environment variables are named and reported only as set / missing / blocked.

---

## §0 — Resume Here

**This section is the recovery point.** If a session ends for any reason, a
fresh one reads this, checks it against `git log` and `git status`, and
continues from "Current task checkpoint" without repeating finished work.

It is rewritten and committed after every completed unit of work. If it
disagrees with the repository, the repository is right and this section is
stale — say so and correct it.

### The assignment

The current workspace pass completed five local changes on top of the
repository state:

1. Added search and outcome filtering (`bets-filter.ts` + UI controls) to the
   customer `/bets` history page (5 unit tests in
   `src/app/(site)/bets/__tests__/bets-filter.test.ts` passed via `tsx --test`).
2. Stabilized local dependency install and dev server startup on port 3000.
3. Applied the `PLUTO-BET-DES` Midnight Stadium design across customer-facing
   `(site)` routes, tokens, left navigation sidebar, light/dark theme toggle,
   header, hero match banner, and sportsbook surfaces while leaving the
   `/admin` styles in `src/app/globals.css` isolated.
4. Wired `HeroMatchBanner` and `MatchBoard` to `pickHottestMatch`,
   `resolveMatchVisuals`, and `resolveBoardBadges`
   (`src/modules/odds/featured-match.ts`, 6 unit tests passed via `tsx --test`),
   which ranks live/marquee fixtures dynamically, indexes free 500px club
   crests across 25 ESPN soccer leagues plus NBA basketball and FlagCDN
   national flags across 75+ countries with a cached TheSportsDB team-search
   fallback for newly synced teams, and resolves verified star-player renders
   from TheSportsDB with 6-hour caching and `next.config.ts` image remote
   patterns. Also fixed header breakpoint overlap (`901px–1023px` and
   `1024px–1240px`), responsive hero wing occlusion, mobile betslip overlay
   dismissal across link navigation, stale confirming-state resets, and
   `Africa/Lagos` timezone hydration determinism across sportsbook views.
   Locally verified on 2026-11-17 with `tsc --noEmit`, Next.js build,
   `eslint .`, `npm run ci:docs` (13 docs, 15 rules), 11/11 unit tests, and live
   HTTP 200 checks on `/` (including player render proxies and all 20 EPL
   500px club crests), `/sports`, `/live`, `/livescore`, `/results`,
   `/jackpot`, `/promotions`, `/pluto`, and `/api/health`.
5. Hardened sportsbook interactivity and responsive layout:
   - `src/components/sportsbook/browser-store.ts`: wrapped `storage?.getItem`
     and `window.addEventListener("storage", ...)` in `try/catch` so restricted
     or cross-origin iframes blocking `sessionStorage`/`localStorage` with
     `SecurityError` fall back cleanly to in-memory store updates without
     crashing hydration (`src/components/sportsbook/__tests__/browser-store.test.ts`,
     1 unit test passed via `tsx --test`).
   - `src/components/sportsbook/betslip-panel.tsx`: added `safeIdempotencyKey()`
     with `crypto.getRandomValues` fallback when `crypto.randomUUID` is missing.
   - `src/components/sportsbook/match-board.tsx`, `src/app/(site)/sports/event/[id]/page.tsx`,
     and `src/styles/sportsbook.css`: converted fixture team names into
     `.sb-fixture__teamslink` navigation links to `/sports/event/[id]`, added
     the sticky desktop betslip column (`.sb-eventgrid`) to `/sports/event/[id]`,
     raised `.sb-hero__center` above `.sb-hero__badge`, adjusted `.sb-shellgrid`
     to collapse `.sb-railcol` at `max-width: 1420px` so standard `1280px`
     desktop viewports no longer squeeze `.sb-fixture__teamslink` to `0px`
     width, and added `@container (max-width: 580px)` safeguards on
     `.sb-board` scoped to `.sb-league`.
   - `VERIFIED_IN_REAL_BROWSER` (2026-11-17, headless Chromium against local
     disposable Postgres + Redis seeded via `scripts/seed-demo.ts` with
     `/api/health` returning healthy): verified hero 1/X/2 odds clicks,
     board odds clicks, betslip quick-stake/remove/clear controls, star
     toggles, league accordion expand/collapse, theme toggle, header `More`
     menu, header search, `+markets` navigation, team-link navigation, and
     `/sports/event/[id]` desktop betslip across `1280x800`, `1440x900`,
     `960x800`, mobile `390x844` (bottom betslip sheet + scrim close), an
     embedded `<iframe>`, and simulated `SecurityError` storage blocking with
     zero uncaught `pageerror` exceptions.
6. Completed mobile-first responsive overhaul across the `(site)` sportsbook
   surface while keeping desktop Midnight Stadium layouts and `/admin` rules in
   `src/app/globals.css` isolated:
   - `src/styles/tokens.css`, `src/components/sportsbook/header.tsx`, and
     `src/styles/sportsbook.css`: decoupled `.sb-subnav` outside sticky
     `<header className="sb-header">` so `.sb-subnav` stays sticky only at
     `@media (min-width: 901px)` (reducing mobile sticky chrome to `107px`,
     `11.5%–13.2%` across `375x812`, `390x844`, `430x932`, and `768x1024`),
     and compressed the mobile topbar (`<= 480px`, `<= 420px`, `<= 380px`) with
     hidden auth button icons on narrow viewports and capped `.sb-walletchip`
     truncation so `320px` fits both signed-out and signed-in without overflow.
   - `src/components/sportsbook/board-page.tsx`, `src/styles/sportsbook.css`:
     added `.sb-mobileleagues` horizontal competition filter strip below
     `DateStrip` (shown when `.sb-railcol` hides at `<= 1420px`), converted
     `.sb-board` and `.sb-board--3` match rows below `640px` to a 2-tier
     stacked grid (tier 1: full-width fixture/teams/time/star; tier 2: `44px`
     `1`, `X`, `2`, and `+N` tiles), stacked mobile hero controls/CTA at `44px`,
     moved `@media` overrides below base hero/board/auth declarations so CSS
     cascade applies cleanly, hid `.sb-auth__aside` below `860px` so auth
     forms appear immediately above the fold, enlarged mobile touch targets
     (drawer close, chip links, quick stakes, betslip remove/tab controls),
     and added a close button (`onClose` / `.sb-slip__close`) in
     `src/components/sportsbook/betslip-panel.tsx` and
     `src/components/sportsbook/mobile-bar.tsx`.
   - `src/components/sportsbook/footer.tsx`, `src/styles/surfaces.css`,
     `src/app/(site)/account/page.tsx`, `src/app/(site)/livescore/livescore-board.tsx`,
     and `src/app/(site)/rewards/page.tsx`: replaced inline footer styles with
     responsive `.sb-footer*` grid rules, wrapped remaining `.sb-table`
     elements in `.sb-tablewrap`, added `.sb-table__val` wrapping, and bounded
     card/stat/tile grid minimum track widths via `min(..., 100%)`.
   - `VERIFIED_IN_REAL_BROWSER` (2026-11-18, headless Chromium against local
     disposable Postgres + Redis): verified `0` horizontal overflows (`scrollWidth <= innerWidth`)
     and `0` uncaught `pageerror` exceptions across all `7` viewports
     (`320x568`, `375x812`, `390x844`, `430x932`, `768x1024`, `1280x800`,
     `1440x900`) for signed-out routes (`/`, `/sports`, `/live`, `/livescore`,
     `/results`, `/jackpot`, `/promotions`, `/pluto`, `/signin`, `/register`,
     `/forgot-password`) and signed-in routes (`/`, `/sports`, `/wallet`,
     `/bets`, `/account`, `/account/security`, `/account/preferences`,
     `/deposit`, `/withdraw`, `/kyc`, `/rewards`, `/referrals`, `/responsible`,
     `/sports/event/[id]`); confirmed `formTop: 67px` (`asideDisplay: none`)
     on `/signin`, `teamsLinkWidth: 247px` and `44px` hero/board odds & CTA
     touch targets at `375x812`, drawer open/close, `.sb-mobileleagues`
     responsive visibility (`<= 1420px`), mobile betslip drawer quick-stake +
     `.sb-slip__close`, and light/dark theme toggle.
7. Restored minimized player cutout visuals inside `HeroMatchBanner` across
   mobile and narrow tablet viewports (`src/styles/sportsbook.css`,
   `src/components/sportsbook/hero-match-banner.tsx`):
   - Removed `display: none` from `@container (max-width: 520px)` and
     `@media (max-width: 720px)` on `.sb-hero__player` so left/right player
     cutouts remain visible on phones instead of blank side space.
   - Added compact upper-stage mobile sizing (`112px × 144px` at `<= 600px`,
     `96px × 128px` at `<= 380px`, `136px` width at `<= 720px`), stronger
     inward fade masks, text-shadow legibility on `.sb-hero__league`/`.sb-hero__team`,
     and responsive `<Image sizes="(max-width: 600px) 116px, 220px" />`.
   - `VERIFIED_IN_REAL_BROWSER` (2026-11-18, headless Chromium against local
     disposable Postgres + Redis): verified both `.sb-hero__player--left` and
     `.sb-hero__player--right` render with `display: block`, `imgComplete: true`,
     `imgNaturalWidth > 0`, and `0` horizontal overflow across `320x568`
     (`96×128`), `375x812` (`96×128`), `390x844` (`112×144`), `430x932`
     (`112×144`), `768x1024` (`224×242`), and `1280x800` (`224×252`). Also
     verified with `tsc --noEmit`, `eslint .`, Next.js production build,
     `npm run ci:secrets` (506 files, clean), and `npm run ci:docs` (13 docs,
     15 rules).
8. Added `allowedDevOrigins` in `next.config.ts` (`**.run.app`, `127.0.0.1`,
   `localhost`, `**.localhost`, plus parsed `NEXTAUTH_URL` /
   `NEXTAUTH_URL_INTERNAL` hostnames when configured) so Next.js dev server
   does not block `/_next/static/*` chunk requests coming from the AI Studio
   Cloud Run preview origins (`ais-dev-*.europe-west3.run.app`,
   `ais-pre-*.europe-west3.run.app`) or `127.0.0.1`.
   - `VERIFIED_END_TO_END` (2026-11-18, live dev server on port 3000):
     confirmed `/_next/static/chunks/...js` returns HTTP `200` with
     `Origin: https://ais-dev-5m6yv22v3xftxqsqgmf7hk-587644012021.europe-west3.run.app`,
     with `sec-fetch-mode: no-cors` + `sec-fetch-site: cross-site` + Cloud Run
     `Referer`, and with `Origin: http://127.0.0.1:3000`.
   - Note on the reported `TypeError: Cannot set property fetch of #<Window> which has only a getter`:
     verified via repository search that `src/` never assigns `window.fetch`;
     that stack trace originates inside a user-installed Chrome extension
     (`chrome-extension://pphgdbgldlmicfdkhondlafkiomnelnk/libs/requests.js`).
9. Refined hero match presentation, match-result market scope, mobile floating
   betslip badge, and multi-sport sync/navigation:
   - `src/components/sportsbook/hero-match-banner.tsx`,
     `src/components/sportsbook/board-page.tsx`,
     `src/modules/odds/featured-match.ts`, and `src/styles/sportsbook.css`:
     removed `.sb-hero__playerfade` and replaced it with intersected
     horizontal and vertical alpha dissolve masks directly on
     `.sb-hero__playerimg` and `.sb-hero__crestfallback` across desktop and
     mobile breakpoints; added `pickHotMatches(shown, 5)` and upgraded
     `HeroMatchBanner` to an auto-swapping (`5,000ms`) animated carousel
     (`motion/react` + touch swipe + `.sb-hero__dots` tabs).
   - `src/app/(site)/sports/event/[id]/event-markets.tsx`,
     `src/app/(site)/sports/event/[id]/page.tsx`, and
     `src/components/sportsbook/match-board.tsx`: filtered the match detail
     view strictly to canonical `1x2` (`home`, `draw`, `away`) selections so
     Handicap, Double Chance, Over/Under, and secondary markets are not shown,
     and replaced `+N` board market counters with `Match Odds` chevron links.
   - `src/components/sportsbook/mobile-bar.tsx` and `src/styles/sportsbook.css`:
     added a floating bottom-right circular betslip button (`.sb-slipfab`) on
     `<= 900px` viewports displaying the live pick badge count (`.sb-slipfab__count`)
     when ≥1 pick is selected and opening the `.sb-sheet` betslip dialog on click.
   - `src/inngest/functions/odds-sync.ts`, `src/modules/odds/sync.service.ts`,
     `src/modules/odds/odds-api-io.ts`, `src/modules/odds/canonical.ts`, and
     `src/components/sportsbook/header.tsx`: extended Inngest fixture and delta
     odds sync loops across `SYNC_SPORTS` (`football`, `basketball`, `tennis`,
     `table-tennis`, `esports`) with `events.sport` filtering in
     `fullRefreshWatchlist()`, `"winner"` / `"matchodds"` `1x2` aliases, and
     Suspense-wrapped URL `?sport=` highlighting and board titles. Live
     upstream ingestion for non-football sports remains `IMPLEMENTED_NOT_LIVE_TESTED`
     until triggered with an active `ODDS_API_KEY` and Inngest scheduler.
   - `VERIFIED_IN_REAL_BROWSER` (2026-11-18, headless Chromium against local
     disposable Postgres + Redis across `375x812`, `390x844`, and `1280x800`):
     confirmed `0` `.sb-hero__playerfade` boxes, active player dissolve masks,
     `5` carousel dots auto-advancing slide `0` -> `1` after `5s`, floating
     `.sb-slipfab` circle updating `1` -> `2` and opening `.sb-sheet` with both
     selections, `/sports/event/[id]` showing strictly `Match result (Home / Draw / Away)`,
     `/sports?sport=...` returning HTTP `200` with matching tab highlight and
     headings across `basketball`, `tennis`, `table-tennis`, and `esports`,
     `0` horizontal overflow, and `0` `pageerror` exceptions. Verified unit tests
     in `src/modules/odds/__tests__/featured-match.test.ts` (7/7 passed via
     `tsx --test`), `tsc --noEmit`, `eslint .`, Next.js build, `npm run ci:secrets`,
     and `npm run ci:docs`.
10. Added Public Trust Pack, re-enabled full fixture markets with category tabs,
    and added installable Progressive Web App (PWA) support:
    - Public Trust Pack (`src/app/(site)/responsible/page.tsx`,
      `src/app/(site)/payments/page.tsx`, `src/app/(site)/about/page.tsx`,
      `src/app/(site)/terms/page.tsx`, `src/app/(site)/privacy/page.tsx`,
      `src/app/(site)/support/page.tsx`, `src/components/sportsbook/footer.tsx`,
      `src/components/sportsbook/sidebar.tsx`, `src/lib/navigation.ts`):
      removed the guest login redirect on `/responsible` so safer-gambling
      policy, self-exclusion, reality checks, and help resources are publicly
      readable while signed-in users keep live database-backed limit controls;
      published public `/payments` (pulling real Naira limits directly from
      `DEFAULT_WITHDRAWAL_LIMITS` and `DEFAULT_PLACEMENT_CONFIG`), `/about`
      (explicitly omitting any unissued gambling licence claim), `/terms`,
      `/privacy`, and `/support`; expanded footer to 4 columns with Company &
      Legal links and registered all routes in `UTILITY_ROUTES`.
    - Full fixture markets (`src/app/(site)/sports/event/[id]/event-markets.tsx`,
      `src/app/(site)/sports/event/[id]/page.tsx`,
      `src/components/sportsbook/match-board.tsx`): restored all open canonical
      markets (`1x2`, `double_chance`, `btts`, `over_under`, `handicap`,
      `ht_ft`, `correct_score`) behind category tabs (`All Markets`,
      `Main (1X2 & DC)`, `Goals & BTTS`, `Handicaps`, `Specials`) with `1x2`
      pinned first, line-paired Over/Under rows, and `+{N}` extra-market counts
      on match board rows.
    - Installable PWA (`src/app/manifest.ts`, `src/app/layout.tsx`,
      `public/sw.js`, `src/app/offline/page.tsx`,
      `src/components/pwa/use-pwa-install.ts`,
      `src/components/pwa/pwa-install-button.tsx`,
      `src/components/pwa/pwa-runtime.tsx`, `public/icon.svg`,
      `public/pwa-192x192.png`, `public/pwa-512x512.png`,
      `public/pwa-maskable-512x512.png`, `public/apple-touch-icon.png`):
      configured Next.js App Router Web App Manifest (`display: "standalone"`,
      separate `any` and padded `maskable` PNG icons, `apple-touch-icon.png`),
      network-first service worker with `/offline` fallback and strict bypass on
      `/api/*`, `/admin`, and money/account routes, offline connectivity banner,
      and in-app `PWAInstallButton` (Chromium `beforeinstallprompt` + iOS Safari
      home-screen guide) mounted in header, sidebar, and `/about`.
    - Evidence status: `IMPLEMENTED_NOT_LIVE_TESTED` for mobile device
      home-screen install prompts; local compilation, ESLint, secret scan, docs
      check, and live HTTP 200 verification on the local dev server recorded on
      2026-11-19.
11. Wired Booking Codes UI, Cut-1 / System bets UI, Sportsbook UX upgrades, and
    nav cleanup while preserving the Midnight Stadium theme:
    - Booking Codes & Cut-1/System Bets (`src/components/sportsbook/betslip-store.tsx`,
      `src/components/sportsbook/slip-math.ts`, `src/components/sportsbook/betslip-panel.tsx`):
      added `replacePicks()`, `systemSlipMath()`, live **Load Booking Code**
      (`GET /api/bookings?code=...`) and **Book Bet / Copy / Share** (`POST /api/bookings`),
      plus **Acca / Cut 1 / System** bet mode tabs with Banker (`B`) toggles and
      explicit unit-stake × combinations = total-stake pricing wired directly to
      `POST /api/bets` (`systemSize`, `bankerIndices`).
    - Sportsbook UX (`src/components/sportsbook/match-board.tsx`,
      `src/app/(site)/live/page.tsx`, `src/app/(site)/live/live-board.tsx`,
      `src/app/(site)/bets/bets-filter.ts`, `src/app/(site)/bets/page.tsx`,
      `src/app/(site)/bets/bets-list.tsx`): added **All / Starred** match view
      filter on `MatchBoard`, multi-sport `?sport=` tabs (`football`,
      `basketball`, `tennis`, `table-tennis`, `esports`) and green/red live
      odds-movement flashes on `/live`, and 1-tap **Re-Bet** for open legs on
      `/bets`.
    - Nav cleanup (`src/components/sportsbook/header.tsx`,
      `src/components/sportsbook/sidebar.tsx`): hid `PLANNED` and uncontracted
      verticals (`Live Casino`, `Fantasy`, `Lucky Numbers`, `Casino`, `Virtuals`)
      from primary header `More` and sidebar navigation while preserving all
      routes and `NAV_ITEMS` registry tests.
    - Evidence status: verified via Next.js production compile, ESLint, and
      existing unit tests on 2026-11-19; live multi-bet placement and live
      odds-movement flashing remain `IMPLEMENTED_NOT_LIVE_TESTED` until run
      against live real-time provider ticks.
12. Fixed stale Turbopack client chunk error (`Gamepad2` missing module factory
    from cached `sidebar.tsx`) and local `[board] fixtures unavailable` DB
    query failure:
    - Service worker & cache headers (`public/sw.js`,
      `src/components/pwa/pwa-runtime.tsx`, `next.config.ts`): bumped
      `CACHE_NAME` to `"plutobet-shell-v2"` so `activate` evicts stale `v1`
      caches, added `"/_next/"` to `BYPASS_PREFIXES` and restricted cache-first
      serving strictly to static icon/offline shell assets (never caching
      `/_next/static/` JS chunks), updated `navigator.serviceWorker.register`
      with `updateViaCache: "none"` plus `registration.update()`, and added
      `Cache-Control: no-cache, no-store, must-revalidate` and
      `Service-Worker-Allowed: /` headers for `/sw.js` in `next.config.ts`.
    - Local disposable Postgres (`127.0.0.1:5432`) & Redis (`127.0.0.1:6379`):
      resolved missing `libicu*.so.60` symlinks in
      `@embedded-postgres/linux-x64/native/lib`, started `scripts/dev-stack.ts`
      against `.pgdata-dev`, seeded 5 demo fixtures via `npm run db:seed-demo`,
      attached an `"error"` listener to the shared `ioredis` client in
      `src/db/redis.ts` (suppressing `[ioredis] Unhandled error event` noise
      while preserving command rejections and health checks), and started local
      `redis-server` (7.0.15) on `127.0.0.1:6379`. `VERIFIED_END_TO_END` on
      2026-11-19 against the local dev server: `/api/health` returned
      `{"status":"healthy","summary":"all checks passed"}` (`database: ok`,
      `redis: ok`), `/sw.js` served `plutobet-shell-v2` with
      `Cache-Control: no-cache, no-store, must-revalidate`, and `/`, `/sports`,
      `/live`, and `/api/live` returned HTTP `200` with seeded fixtures and zero
      board load errors.
13. Enabled multi-sport fixture ingestion, pricing, and 2-way board rendering
    for Basketball, Tennis, Table Tennis, and Esports:
    - Provider & sync pipeline (`src/modules/odds/provider.ts`,
      `src/modules/odds/odds-api-io.ts`, `src/modules/odds/sync.service.ts`,
      `src/modules/odds/odds.service.ts`, `src/inngest/functions/odds-sync.ts`,
      `src/components/sportsbook/shell.tsx`, `scripts/qa-odds-sync.ts`,
      `scripts/seed-demo.ts`): added optional `from` bound to `listEvents()`
      (`now - 3h`) so `/v3/events` does not waste its 500-row limit on settled
      history (restoring `table-tennis` from `0` to `390` upcoming/live
      fixtures), widened watchlist pricing to `-3h..+72h`, ordered default
      bookmakers as `["1xbet", "Betway"]` for broader multi-sport coverage,
      included active `LIVE` fixtures (started within `4h`) in `listUpcoming()`,
      invalidated live caches across all `SYNC_SPORTS` in `syncLiveOdds`, and
      summed header live counts across all 5 sports.
    - Multi-sport board UX (`src/components/sportsbook/board-page.tsx`,
      `src/components/sportsbook/match-board.tsx`, `src/styles/sportsbook.css`):
      surfaced priced fixtures and leagues first, added responsive
      `.sb-board--2way` layout (omitting the unused `X` draw column on 2-way
      sports), and dynamically selected the balanced primary Over/Under line
      with explicit line labels (`O <line>` / `U <line>`) for non-football
      totals while keeping football pinned to `2.5`.
    - `VERIFIED_AGAINST_REAL_PROVIDER_DATA` (2026-11-19, local disposable
      Postgres + Redis via `npx tsx scripts/qa-odds-sync.ts` against live
      `api.odds-api.io` with `1xbet, Betway`): synced `1,815` events across 5
      sports (`football`: 478 / 33 priced / 19 live; `basketball`: 452 / 12
      priced / 63 live; `tennis`: 289 / 35 priced / 17 live; `esports`: 181 /
      25 priced / 4 live; `table-tennis`: 384 / 0 priced in the 40-event
      watchlist slice / 10 live), `205` markets, `1,406` priced selections,
      zero `[object Object]` rows. Verified Next.js build, ESLint, and live
      HTTP `200` on all 5 `/sports?sport=...` and `/live?sport=...` routes.

The developer-completion and sportsbook verification pass described later in
this file is prior work, not the current assignment. Its evidence is retained
without presenting its old deployment or remote states as current.

Standing constraints for this pass, in short form — the full list is in the
owner's instruction and none of it is negotiable:

- No assumption presented as fact. Evidence levels only (§0.1).
- No fake external success: QA credit is not a deposit, a fixture is not a
  provider, a sandbox is not a casino, a keyword router is not a model.
- No manual money manipulation. Balances, ledger rows, bet outcomes, event
  results, outbox status and exposure move only through application services,
  public routes, registered jobs, migrations, or QA-gated utilities against a
  disposable database.
- Real production money and customer data are not touched. All development,
  browser testing, screenshots, seeding and load testing run against a local
  disposable database.
- The 400 synthetic production fixtures are **not** deleted. The ₦630 historical
  exposure repair is **not** applied. Both need owner approval on a dry-run
  fingerprint.
- No secret printed, logged, committed, screenshotted or written into Markdown.
- No weakening of tests or security to obtain green results.
- No force push, destructive reset, history rewrite, or branch-protection
  bypass.
- No Railway deployment and no live provider activation.

### §0.1 Evidence levels used in this file

`VERIFIED_IN_REAL_BROWSER` · `VERIFIED_END_TO_END` ·
`VERIFIED_AGAINST_REAL_PROVIDER_DATA` · `VERIFIED_BY_INTEGRATION_TEST` ·
`VERIFIED_BY_UNIT_TEST_ONLY` · `IMPLEMENTED_NOT_LIVE_TESTED` ·
`BLOCKED_BY_KEY` · `BLOCKED_BY_CONTRACT` · `BLOCKED_BY_OWNER_CONFIGURATION` ·
`BLOCKED_BY_PRODUCT_DECISION` · `BLOCKED_BY_REGULATION` · `NOT_IMPLEMENTED` ·
`FAILED`

A status is never upgraded without the evidence its level names.
`VERIFIED_IN_REAL_BROWSER` means the control was clicked or submitted in a
browser during this pass — not that it looks right in the source.

### Repository state at this checkpoint


| | |
|---|---|
| Branch | **`main`** — the gap-closure branch has been merged into it; the Next.js security patch is the current change. `npm run ci:docs` compares this row against `git rev-parse --abbrev-ref HEAD` |
| Branched from | `main` at `299d4b9`, after the redesign was merged |
| HEAD | read it with `git rev-parse HEAD`. No hash is written here — see the note below for why one cannot be |
| Commits ahead of `plutobet/main` | The security patch is published to `origin/main`; this request did not publish to `plutobet`. Verify current refs with the commands below |
| Anything unpublished | No uncommitted changes are intended. The requested publication target was `origin/main`; the separate `plutobet` remote was not part of this request |
| Working tree | Verify with `git status --short` |
| `main` | The Next.js security patch is published to `origin/main` at the owner's request. `plutobet/main` was not updated by this task |
| Pushed | To `origin/main` only, as requested. The resulting external deployment has not been verified |
| Default push remote | `remote.pushDefault = plutobet`, set earlier at the owner's instruction. This task explicitly targeted `origin` |
| **Production mutations performed** | This session did not directly modify a production database, provider or dashboard. The deployment effects, if any, of the GitHub push were not verified |
| `origin/main` vs `plutobet/main` | `origin/main` received this security patch. `plutobet/main` was not updated by this request; compare the remote refs to verify |
| The merge commit | `84aab07` — the commit that carried the merge into `main`; historical |
| Redesign branch pushed | **yes**, to both remotes, at `84aab07`; historical |
| Merged to `main` | **yes** — fast-forward, no conflict, no history rewritten, no force |
| Local validation | `npm run typecheck`, `npm run lint`, `npm test` (80 files; 1,034 passed, 1 skipped), `npm run ci:secrets` (496 files, clean), and a Next.js production build with database URLs isolated all passed for this patch |
| Remote CI / deployed | Not verified. A local build does not prove a remote build or deployment succeeded |

> A previous version of this file said "seven commits". It was wrong, and a
> later version said `23b595d`/21 after two more commits had landed. Commit
> counts and HEAD are read from git at every checkpoint, never repeated from a
> document.
>
> **A checkpoint cannot contain its own hash.** Verify the current commit and
> publication state from Git rather than copying hashes into this document:
>
> ```
> git rev-parse HEAD                          # what is checked out
> git ls-remote origin refs/heads/main        # expected to match HEAD after publication
> git ls-remote plutobet refs/heads/main      # separate remote, not updated by this request
> git log --oneline origin/main..HEAD         # expect empty after publication
> ```
>
> The November security patch was explicitly requested on `origin`; this task
> did not update `plutobet`.
>
> If anything in this document disagrees with git, **git is right.**

### Historical deployment evidence (checked 2026-09-06)

The following Vercel observations are historical. The owner requested a push to
`origin/main` for the November 16 Next.js security patch; the deployment result
from that push has not been verified here.

**THE OWNER DEPLOYS THIS PROJECT ON RAILWAY.** Stated 2026-09-06. Everything
below about Vercel therefore describes **an integration nobody intended**, and
that makes it more urgent rather than less — a Vercel project has been building
and publishing this betting platform **thirty times** without being part of the
deployment story anybody was maintaining.

**A previous push of `main` triggered a Vercel PRODUCTION deployment of
`Madubuezejoshua/plutobet`, and it succeeded.** This is recorded prominently
because the task that authorised the push explicitly did not authorise a
deployment — and because it turns out not to have been the intended platform at
all.

**What is actually verifiable from here**, and what is not:

| Claim | Evidence |
|---|---|
| `Madubuezejoshua/plutobet` had **30** deployments, environment `Production`, creator `vercel[bot]`, the most recent for `299d4b9` | Read from `GET /repos/Madubuezejoshua/plutobet/deployments` on 2026-09-06. Not a current count |
| The repository contains **no** `vercel.json` and **no** `.vercel` directory | Searched |
| The repository **does** carry Railway tooling — `scripts/push-env-railway.ts`, and `scripts/deploy-build.mjs` detects `RAILWAY_ENVIRONMENT_NAME` to enable migrations | Read from the files |
| `plutobet-ai/plutobet_ai` had **0** deployments | Read from the same API on 2026-09-06 |
| **Whether Railway is currently running, and against which database** | **Cannot be seen from this repository.** No Railway credential is present and none was used. Not asserted |

So the Vercel project was connected to that GitHub repository at some point and
has been deploying ever since, independently of the platform the owner is
actually using. `deploy-build.mjs` supports both targets, which is why nothing
in the build ever complained.

| | |
|---|---|
| What fired it | A pre-existing Vercel ↔ GitHub integration on that repository that deploys on every push to `main`. It was not invoked by hand and no deployment command was run |
| Deployments created | One **Production** deployment by `vercel[bot]` **per push to `main`**, plus a Preview on the first. Every one so far reports `state=success` |
| How many so far | Every `main` push in this pass deployed. Do not read a count from this document — it goes stale on the next push. Read it from Vercel, or from `GET /repos/Madubuezejoshua/plutobet/deployments` |
| The other remote | `plutobet-ai/plutobet_ai` created **no** deployment — it has no such integration |
| Railway | **Not touched by this pass**, and its live state is **not visible from here** — no Railway credential is present and none was used. The owner states Railway is the platform this project deploys on, which makes the Vercel deployments above an unintended integration rather than this product's hosting |

**What this meant on 2026-09-06.** The redesigned sportsbook was live on a
**Vercel** project that is not the platform this product is meant to run on,
against whatever environment variables that Vercel project holds. This document
cannot say what those are — they live in an owner dashboard, not in the
repository. Two questions follow, and the first is not the one this section
originally asked:

1. **Does that Vercel project exist on purpose?** If the answer is no — and the
   owner using Railway suggests it is — then the fix is to disconnect it, not to
   tune it. An unintended public deployment of a gambling product is a problem
   whatever database it points at.
2. **Which database does it point at?** Still worth knowing before it is
   removed, because if it has been serving against the production database then
   it has been reachable by strangers.

**What it does not mean.** No provider was activated, no credential was rotated
or created, and nothing in this repository points at production: the review
server is pinned to loopback and refuses otherwise (findings 31 and 32), and all
testing in this pass ran on a disposable local database.

**Owner actions, in order:**

1. Open the Vercel project and confirm which environment variables Production
   holds, and whether that is intended for this release.
2. If it is not, **roll back to the previous production deployment in Vercel**,
   which is a one-click action and does not require a git revert.
3. Decide whether `main` should auto-deploy at all. If not, disconnect the
   integration or set Vercel's production branch to something other than `main`
   before the next push.

The deployment behavior documented above was observed in September. The
November push's remote deployment result has not been checked.

### Historical evidence that pushes triggered Vercel deployments

The September deployment records showed that pushes then triggered deployments:

| Deployment | Environment | Created | Triggered by |
|---|---|---|---|
| `6281910541` | **Preview** | 14:12:10Z | the **feature branch** push |
| `6281959437` | **Production** | 14:17:21Z | the **`main`** push, five minutes later |

**Historical consequence.** Publishing
`finish/developer-verification-and-truth` to `origin` would create a Vercel
Preview deployment. That branch was held back at the time; the November 16
security patch was separately authorized for `origin/main`.

The September deployments API returned none for `plutobet-ai/plutobet_ai` and
five for `origin`. `remote.pushDefault` remains `plutobet`; the November request
explicitly targeted `origin` rather than using a bare push.

**The asymmetry is now the safety mechanism, and it is worth stating plainly:**
one remote deploys and one does not. Anyone pushing to `origin` should expect a
deployment; anyone pushing to `plutobet` should not.

**Read-only checks the owner can run** (none of these change anything):

```
gh api repos/Madubuezejoshua/plutobet/deployments --jq '.[] | {id,environment,ref,created_at}'
gh api repos/Madubuezejoshua/plutobet/deployments/<id>/statuses --jq '.[0] | {state,environment_url}'
```

Or open the Vercel dashboard → the project → Deployments.

**Safe dashboard actions available to the owner**, none performed here:
promote a previous deployment back to Production (a rollback, one click, no git
revert); change the production branch away from `main`; disconnect the Git
integration; or inspect Settings → Environment Variables to answer the question
this repository cannot — *which database does Production point at?*

### Environment prerequisite on the current development machine

**This is a machine fact, not a repository defect.** It is kept here because the
symptom names the wrong cause and would otherwise cost the next session an hour.

**RESOLVED 2026-09-05.** The owner installed the redistributable and it is
verified: `Microsoft.VCRedist.2015+.x64` **v14.51.36247.0**, registry
`Installed=1`, and `vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140.dll` and
`concrt140.dll` are present in `System32`. Proof that it is the real fix rather
than the workaround still doing the work: with the scratch directory **removed
from `PATH`**, `initdb.exe --version` and `postgres.exe --version` both answer
`(PostgreSQL) 16.14` and exit 0. **The `vcruntime140.dll` workaround is no
longer needed and should not be recreated.**

What the failure looked like, for whoever meets it again: the suite starts a real
PostgreSQL through `embedded-postgres`; without the redistributable
`initdb.exe` and `postgres.exe` cannot load `vcruntime140.dll` and exit
`3221225781` (`0xC0000135`, STATUS_DLL_NOT_FOUND), and **vitest reports it as
"No test files found"** alongside a Postgres init error. The glob is fine; the
database never started. Checked against the binaries' PE import tables they need
`vcruntime140.dll` only — `msvcp140.dll` is not imported, the `api-ms-win-crt-*`
API sets ship with Windows 11, and `ucrtbase.dll` was already present.

**Still true on this machine:** `node` and `git` are installed but **absent from
the system `PATH`**, so commands must prepend `C:\Program Files\nodejs` and
`C:\Program Files\Git\cmd`. Node is v24.20.0, matching the `node-version: '24'`
pinned in CI.

### Stages


| # | Stage | Status |
|---|---|---|
| 1 | Read every instruction, report and runbook; inspect git state | **DONE** |
| 2 | Repository audit + task matrix | **DONE** |
| 3 | Redesign verification in a real browser | **DONE** — desktop + Pixel 7 in depth, a 7-viewport sweep that ran and passed, and an accessibility pass at 0 critical/serious |
| 4 | Interaction audit of every enabled control | **DONE** — generated from the run; Pluto and cash-out added after an audit of the audit found them missing |
| 5a | Cash-out: repair partial cash-out and exposure | **DONE** |
| 5b | Cash-out: eligibility gate, replay, concurrency | **DONE** |
| 5c | Cash-out: authenticated route, UI, audit, admin visibility | **DONE** |
| 5d | **Date-of-birth backfill** | **DONE** |
| 5e | **Live-version Redis cache** | **DONE** |
| 5f | **Withdrawal bank list** | **DONE** |
| 5g | **Edit bet** | **BLOCKED_BY_PRODUCT_DECISION** |
| 5h | **Legacy style bridge removal** | **DONE** — bridge deleted |
| 5i | **Prompt-injection corpus** | **DONE** — 53 attacks, 59 tests, 3 defects found |
| 5j | **Personalisation / Admin AI** | **BLOCKED_BY_PRODUCT_DECISION** (+ `BLOCKED_BY_KEY` for Admin AI) |
| 5k | **Fantasy / Lucky Numbers** | **DONE** — honest unavailable pages; a fabricated blocker fixed |
| 6 | **Load and reliability testing** | **DONE** for the read paths; casino callbacks have no route to load |
| 7 | **Full E2E journey** | **DONE** — 14 steps, one account, one run; 2 defects found |
| 8 | **Security re-verification** | **DONE** for what this pass changed |
| 9 | Complete gates, twice | **DONE** — vitest and playwright each run twice after the final code change, identical results |
| 10 | Truthful `general.md` rewrite + changelog | **DONE** — 5 off-vocabulary labels retired, §15 rewritten, `NEXT_WORK_REPORT.md` §37 |
| 11 | Merge and push, only if every gate passes | **DONE** — the redesign merged at `84aab07` by fast-forward, and at that moment both remotes carried identical trees with CI green on both. **That was 2026-09-05 and is history**: `plutobet/main` has since advanced through every later pass and `origin/main` has not moved, deliberately, because a Vercel production deploy fires on every `main` push there. Current state is in the table above |

### Completed this pass, with evidence


### Stage 2 — automated repository audits

`TODO`/`FIXME`/`HACK`/`XXX`: **0** in source. `href="#"` and empty handlers:
**0**. Skipped or `.only` tests: **0** (the one `describe.skipIf` is the opt-in
live provider contract). Suppressed lint/TS rules: **3**, each documented.
Internal links to routes that do not exist: **0 of 25**, against 46 pages and 26
API routes. `wallets` queries missing a bucket: **0 real** — two pattern hits
read and cleared (a primary-key lookup that verifies ownership after, and a
reconciliation sweep that must scan every bucket to find drift).

### Stage 5a–5c — cash-out, from broken to exposed

Was `IMPLEMENTED_NOT_LIVE_TESTED`; now `VERIFIED_BY_INTEGRATION_TEST` end to end
through its HTTP route, 35 tests across three files. Not yet
`VERIFIED_IN_REAL_BROWSER` — stage 4 does that.

**Two defects, one worse than previously reported.**

1. `FAILED` → fixed. **Partial cash-out could never have succeeded.** 0007's
   `bets_cashout_matches_status` requires `cashout_value_minor IS NULL` unless
   the bet is `CASHED_OUT`; 0016 added partial cash-out, which leaves the bet
   `PENDING` while recording value, and never revisited the constraint. Every
   call raised Postgres `23514`. Unnoticed because **nothing called it** — no
   route, no UI, no test. §15 previously called it well constructed with only an
   exposure defect; that was wrong.
2. `FAILED` → fixed. **Exposure would have been released twice.** `GREATEST`
   floors a double release at zero rather than raising, so a market would report
   less liability than it holds — the direction that lets a ceiling admit risk it
   exists to refuse.

`cashout-exposure.acceptance.spec.ts` was written first and **failed 5 of 7**
against the unmodified code.

`0027_cashout_partial_repair.sql` replaces the constraint and adds
`released_liability_minor`, bounded at or below the claim so a double release is
a loud error. Every release returns `claim − released` and records what it gave
back; division truncates deliberately and the final instalment returns the
remainder.

**Boundary** (11 tests): only `ACTIVE` may cash out, with `SUSPENDED`,
`RESTRICTED`, `SELF_EXCLUDED` and `CLOSED` each asserted and the balance checked
unchanged after refusal; identity-level exclusion runs in the same transaction;
ownership is checked first and refused with the same reason an ineligible account
gets; a retry returns the **original** result; two full cash-outs racing pay once;
two partials racing cannot buy back more stake than the bet carries.

**Route** — `GET`/`POST /api/bets/[id]/cashout` (17 tests). `GET` prices without
taking; a refusal to quote answers 200 with `available: false` because a
suspended market is a market condition, not an error — except an ineligible
account, which stays 403. Each reason maps to its own status. The price the
customer saw is sent back and the server pays that or more, never less.

**UI** inside the ticket, priced on demand. **Audit rows on the same transaction
as the ledger entries.**

### Stage 5d — date of birth

`VERIFIED_BY_INTEGRATION_TEST`, `date-of-birth.acceptance.spec.ts`, 12 tests.

Accounts created before the column was collected have `date_of_birth IS NULL`,
and the `users_minimum_age` trigger only fires when it is NOT NULL — so those
accounts sat outside the age control entirely. Not underage; unverified, which
is the same thing to a regulator asking how you know.

| Piece | What it does |
|---|---|
| `date-of-birth.service.ts` | `isMissing`, and a write-once `complete` that validates through `assertOldEnough`, locks the row so two submissions cannot both write, and appends an audit row **recording that a date was supplied, not what it was** |
| `POST /api/account/date-of-birth` | Write-once; no PUT. Underage is **403, not 422** — the request was understood and the holder is not permitted, and calling it a validation error would have the UI say "check the date" to someone who typed it correctly. The date is not echoed back |
| `/account/date-of-birth` | A real page, not a modal, so it can be linked, bookmarked by support, and read without a focus trap |
| Banner in the shell | Every authenticated page, not dismissible, and it names what is blocked rather than only what is needed |
| Placement + withdrawal | Refuse inside their own transactions, so enforcement does not depend on the customer having seen the banner |
| Admin compliance page | Corrected — it said these accounts were "**not blocked**", which is no longer true |

**No date is ever invented.** A fabricated date of birth is worse than a missing
one: it turns "we do not know" into a false record that looks like diligence.

**The column stays nullable.** `SET NOT NULL` fails while any row is empty, and
the only way to force it through is to write a date nobody gave us. The
procedure for tightening it — including that accounts which never return are a
compliance decision, not a code change — is at the bottom of the service file.

### Two further defects found while testing stage 5d

1. `FAILED` → fixed. **The age gate meant different things in two places.**
   `enforce_minimum_age` compared against `CURRENT_DATE` — today in the *database
   server's* timezone — while `assertOldEnough` computes in UTC. Wherever the
   database is not UTC they disagree for part of every day, and a person exactly
   eighteen falls in the gap: the service accepts, the trigger raises, the
   customer gets a 500. Found by a test on a PDT machine. Production Neon runs
   UTC so it has almost certainly never fired for a real customer, but an age
   control whose answer depends on where the database is deployed is not one
   anybody can attest to. `0028_age_gate_utc.sql` makes the trigger use
   `(now() AT TIME ZONE 'UTC')::date`.
2. `FAILED` → fixed. **Every betting test fixture was a legacy account.**
   `createFundedUser` never set a date of birth, so all of them sat in the
   pre-collection state. It went unnoticed until the new gate started refusing
   them. A test whose subject is accidentally in an edge state proves something
   other than what it claims; the fixture now sets one, and the date-of-birth
   tests clear it explicitly when that is the state under test.

### One existing test was objectively wrong and was replaced

`cashout.acceptance.spec.ts` asserted a second cash-out **throws**. That returned
an error to a customer who had already been paid. The property it protected —
paid exactly once — is kept and strengthened by also requiring the original
figure back. The reason is recorded inline.

### Lint reached zero warnings

Sixteen of seventeen were dead imports. The seventeenth was not:
`ASSUMED_FINISHED_AFTER_MS` documented the assumed-finish policy while the query
restated it as a literal `interval '3 hours'`, so the two could drift apart. The
query uses the constant now.

### Stage 5e — the live-version cache

`VERIFIED_BY_INTEGRATION_TEST`, `live-version-cache.acceptance.spec.ts`, 8 tests
against real Postgres and real Redis.

`/api/live` computed the version digest on **every** poll so an unchanged board
could answer 304 without building a snapshot. Right shape, wrong cost: the digest
is a three-table aggregate and the board polls every five seconds per viewer, so
a hundred people watching one match meant twenty aggregates a second to answer
"nothing has changed" a hundred times.

**Why this is safe to cache.** The digest is a change detector, not a price and
not an authorisation. Nothing prices a bet from it — placement re-reads every
selection under a row lock and compares against the odds the customer was shown.
That separation is what makes caching defensible, and the module says so: if
anything ever prices from this value, delete the cache rather than reason about
it.

**Two layers, in this order:**

1. A **2-second TTL**, shorter than the 5-second poll. This is the correctness
   bound and it holds whether or not any invalidation fires — including for a
   write path nobody remembered to hook up.
2. **Explicit invalidation** after repricing and after suspending an event's
   markets. This is a latency improvement on top, not the guarantee.

Putting the TTL first is the point: an invalidation-only cache is correct exactly
until someone adds a write path and forgets, and the symptom is stale odds.

**Redis down is not an outage.** Every path falls back to the direct query and
answers correctly, just more expensively. A suspension — the safety control —
is never rolled back because a cache key could not be deleted, and that is
asserted. Failures are logged once per process rather than once per poll, so an
outage does not bury its own cause.

Tested: cached value equals the uncached query; a warm key never touches the
database; **staleness is bounded by the TTL with no invalidation at all**; a
suspension drops the key immediately; twenty concurrent readers agree on one
digest; Redis failure degrades to the query; a malformed cached value is ignored
rather than handed to a client as an ETag it could never match.

### Stage 5f — the withdrawal bank list

`VERIFIED_BY_INTEGRATION_TEST` for the caching, validation and failure
behaviour (12 tests). Real provider communication is **`BLOCKED_BY_KEY`** and
nothing here claims otherwise.

The withdrawal form asked the customer to type a NIP bank code from memory. A
wrong code does not bounce — it sends real money to a real account at a different
institution, and the first anyone hears of it is a support ticket about a
missing withdrawal.

| Piece | What it does |
|---|---|
| `PaymentProvider.listBanks()` | New on the interface, so no part of the codebase holds a bank list of its own |
| Paystack adapter | Follows `next_page` rather than taking the first 100 and calling it the list — a truncated list is a customer whose bank is missing, with nothing in the logs to say why. Bounded at 30 pages so a provider bug cannot loop |
| Sandbox adapter | Two banks named **"NOT REAL"** with codes that collide with nothing. A development adapter returning plausible NIP codes is the exact failure the interface exists to prevent |
| `BankListService` | 12-hour freshness, 7-day stale window, serves the cached list when the provider is down and **says it is stale** |
| `GET /api/payments/banks` | Authenticated on the `wallet` budget. The list is not secret, but it costs a provider call and does not belong on an open path |
| `POST /api/withdrawals` | Validates the submitted code against the list **before taking a hold** — a form is a suggestion; the request is what arrives |
| The form | A real picker, with loading, stale and failed states. When the list cannot be fetched it falls back to a typed code and explains why, rather than showing an empty select |

**Two deliberate directions, both recorded because they look like bugs.** An
empty provider response is treated as a failure rather than as "no banks", so a
provider having a bad minute cannot empty a good list and leave every customer
unable to withdraw. And `isPayableBankCode` **passes** when no list can be
established: refusing every withdrawal because a bank list could not be fetched
would turn a provider outage into an inability to take money out. The transfer
re-validates, and the provider refuses an unknown code.

### Stage 5g — edit bet is BLOCKED_BY_PRODUCT_DECISION

Searched the whole repository. **Every reference is a backlog entry saying it is
not implemented** — `docs/who-does-what.md` D6, `NEXT_WORK_REPORT.md`, three
files under `docs/history/`, and §12 here. There is no specification anywhere.

The repository does not define **eligibility** (which bets, how long after
placement, before or after kick-off), **fees**, **odds-change consent** (a
rebooked bet is priced again — does the customer agree, and to what), or the
**treatment of promotional stakes** (a bonus-funded bet edited into a different
one is a wagering-requirement question, not a betting one).

Building a cancel/rebook without those means inventing the financial rules of a
money feature, which the owner's instruction explicitly forbids. It is recorded
as blocked, with the exact decisions needed, rather than shipped to look
complete.

### Stage 5h — the legacy style bridge is gone

`src/styles/legacy-bridge.css` is **deleted**. It re-pointed the old dark
system's variables at the new tokens so pages still carrying legacy classes
rendered in the new palette during the migration. Seven files still depended on
it — `kyc-form`, `responsible/controls`, `account/preferences`,
`account/security`, `account/verify-email`, `pluto-chat` and one stray class in
`results` — and all seven had their classes converted.

> **This section previously said the conversion was complete. It was not.** The
> stage 5h audit looked for legacy *classes* and did not look for legacy
> *variables* inside inline `style` props, and two survived in
> `account/preferences`: `color: var(--ink)`, which without the bridge resolves
> to the legacy dark theme's near-white `#e9edf5` and rendered as roughly 1.1:1
> on a white card — text a customer could not read. It was found by the axe run
> in this pass, not by the audit that declared the work done. Both are fixed,
> and a repository-wide search now confirms **zero** legacy `var(--…)`
> references in any `.tsx` file. Finding 38.

The structural part was `.field`, whose label text was a bare child and now
carries the `sb-field__label` span the new form language expects. Two
components were also reusing the **odds tile** for cool-off and self-exclusion
choosers; they use the board's chip now, because an odds tile carries betting
meaning and a self-exclusion button is not a bet.

The legacy rules further down `globals.css` stay: they serve the **admin
console**, which renders outside the `.sb` shell and keeps the dark system on
purpose. Re-skinning the screens that approve withdrawals is not a side effect
to accept from a customer-facing pass.

`stylesheet-imports.acceptance.spec.ts` was updated so it no longer requires the
deleted file.

### Stage 3 — Playwright, and two defects it found immediately

`playwright.config.ts` plus `e2e/`. The config deliberately does **not** start
the server: doing so would make it easy to run the suite against whatever
`.env` holds, and `.env` holds production credentials. A base URL that has to be
supplied is one somebody thought about. Two projects — desktop 1440×900 and a
real **Pixel 7** device profile, because desktop Chrome narrowed to 390px is not
a phone and the difference is where mobile-only defects hide.

Every page test asserts: status under 400, **no console error, no uncaught
exception, no failed request**, no horizontal overflow (measured, and the
failure names the widest element), and that the sportsbook stylesheet actually
reached the browser — the check that would have caught the `@import` ordering
defect where every other gate passed.

First run: **28 passed, 12 failed**, and both causes were real.

1. `FAILED` → fixed. **The password field's accessible name was wrong.** The
   "Forgot password?" link sat *inside* the `<label>`, so the field was
   announced as "Password Forgot password?, edit text" — and a link nested in a
   label has ambiguous click behaviour, since the browser may focus the input
   instead of following it. Found because a browser could not locate a field
   labelled exactly "Password". The link is now a sibling.
2. `FAILED` → fixed. **There was no 404 page.** Next.js served its built-in
   one: black text on white, no branding, and no way out. A customer who
   mistypes a URL or follows a stale link got something that does not look like
   this product and offers them nothing. `src/app/not-found.tsx` is branded and
   carries three routes back. It sits at the app root deliberately, so it renders
   without a session — a 404 that reads the database turns an unreachable
   database into a 500 on every wrong URL.

### Stage 3 finished — and the page container had been deleted with the bridge

The desktop and Pixel 7 projects both passed **at that point in the pass**: 118
passed, 6 skipped (the six skips are the column check below, which is meaningless
on a phone). *That figure is a waypoint, not the current one — the suite later
grew to 139 passed / 13 skipped when the accessibility and responsive files were
added. §4 carries the current totals.* Two defects beyond the ones already
recorded:

3. `FAILED` → fixed. **The mobile header overflowed.** The signed-in header
   measured 446px inside a 412px viewport, so every authenticated page scrolled
   sideways on a phone. Below 900px the deposit label is hidden (the icon keeps
   its `aria-label`) and the account icon is dropped, because the bottom bar
   already carries it.
4. `FAILED` → fixed. **Competition favouriting was unreachable.** With eight or
   fewer leagues the "Popular" group is hidden, and the country groups had no
   star — so on a normal seeded database there was no way to favourite anything.
   Country rows use `leagueRow` now.

And one the browser suite did **not** catch, which matters more than the two it
did:

5. `FAILED` → fixed. **Deleting `legacy-bridge.css` deleted `.sb-page`.** The
   page container — the measured 1040px column every non-board page sits in —
   was defined in the bridge file, and stage 5h removed the file. Headings went
   hard against the left edge and tables spanned the full 1440px.

   **Every gate passed.** Typecheck, lint, `next build`, 913 unit tests, and the
   40-per-project browser suite. The browser suite measures horizontal
   *overflow*, and a full-bleed page does not overflow. It was found by looking
   at a screenshot, which is not a control.

   The rules now live in `surfaces.css`, and `e2e/pages.spec.ts` asserts the
   container directly: `.sb-page` must have a real `max-width` and must measure
   narrower than the viewport at 1440px. **That test was proved to fail**: the
   rules were removed, the app rebuilt, and all six checks failed before the
   rules were restored and they passed again. A regression test that has never
   failed is not evidence.

### Stage 4 — the interaction audit, generated rather than written

`artifacts/ui-review/INTERACTION_AUDIT.md`: **38 rows**, 19 controls in each of
two projects, every one clicked or submitted in a real browser against a
disposable local database. `artifacts/ui-review/00-contact-sheet.png`: **28
labelled thumbnails**, desktop and 390px mobile, visually inspected.

It was 32 rows when this stage was first written. The six added since are Pluto's
chat and mode disclosure, and cash-out — found missing by an audit of the audit —
and both artefacts were **re-generated after the final fix** rather than left
showing an earlier state of the interface.

Both are produced by `scripts/build-ui-review.mjs` from what the run actually
did. Nothing in that table is written from reading the source — if a control is
missing from it, it was not tested.

Three defects in the reporting machinery itself, all of which made the evidence
quietly wrong rather than absent:

- `beforeAll` truncated a single shared audit file **once per project**, so only
  the last browser's rows survived. Per-project files, merged afterwards.
- `capture-ui-screenshots.mjs` deleted the whole output directory, taking the
  audit rows written moments earlier. It removes only PNGs now.
- The merge glued the project into the page cell, leaving every row one column
  short of its header — which Markdown renders as a quietly shifted table, not
  an error.

### The review server no longer inherits production secrets

`scripts/review-server.mjs`. `next start` loads `.env`, and in this repository
`.env` holds **production** credentials. The review server was started by
exporting a local `DATABASE_URL` in front of the command, which works and is one
forgotten export away from pointing a browser — and the destructive interaction
tests — at the real database. The app comes up perfectly either way.

The script sets every connection string explicitly, **refuses to start** if any
of them names a host that is not loopback, and generates review-only
`AUTH_SECRET` and `IDENTITY_PEPPER` values into a gitignored file. Previously
the review process inherited the production pair from `.env`: local browser
sessions were signed with the production secret and local identity numbers
hashed into the production keyspace. Neither is needed to photograph a screen.

`playwright.config.ts` still does not spawn it. Pointing the suite at a base URL
stays a deliberate act.

### Stage 5i — the adversarial corpus, and what it found

`src/modules/ai/__tests__/injection-corpus.ts` holds **53 attacks** across the
sixteen categories the owner named, entering by four vectors: a user message, a
tool argument, a tool **name**, and retrieved text. It is data, separate from
the tests that run it, so that adding an attack does not mean writing a test and
so the same corpus can be replayed against a live model when a key exists.

`prompt-injection.acceptance.spec.ts` runs it against the real layer —
`authoriseToolCall`, `findTool`, `runTool`, `vetAnswer`, `RulesBasedProvider`,
nothing mocked. **59 tests, all passing.**

**What this does and does not establish.** The threat model is the pessimistic
one: assume the model is fully compromised and the attacker wrote its output.
Every assertion is about what happens when a hostile tool call *arrives*. That
covers the layer, which is the part that has to hold. It says nothing about how
a live model would answer these prompts — no key is configured, so that remains
`BLOCKED_BY_KEY` and the corpus header says so at the top, because this is
exactly the result somebody would otherwise quote as "Pluto resists prompt
injection".

Three defects, all found by the corpus rather than by reading the code:

23. `FAILED` → fixed. **`setDepositLimit` required no confirmation.** It sits at
    `ACCOUNT` level, and the four levels are about money — so a tool that
    changes a *protection* was, by level alone, callable on the strength of a
    sentence in a chat. Under the stated threat model that is precisely the
    failure rule 16 exists to prevent. A new `alwaysConfirm` flag carries it,
    rather than promoting the tool to `FINANCIAL`, which would put a misleading
    word in front of the customer. The existing test that checks money tools
    need confirmation matched on `/^(place|prepare|cashout|deposit|withdraw)/`
    and `setDepositLimit` begins with "set", so it was never covered.

24. `FAILED` → fixed. **Two registered tools had no handler.**
    `setOddsFormat` and `setDepositLimit` were both advertised to the model by
    `toolsFor`, and both fell through to a `default` branch whose comment
    claimed it was unreachable. A customer asking for either was told it "is not
    implemented" by an assistant that had just offered it. Both are wired now,
    to services that already existed — and the deposit-limit handler calls
    `responsibleService.setLimit` rather than restating its policy, so the rule
    that a *decrease* applies at once and an *increase* waits 24 hours has one
    home and cannot drift. A new test calls every registered tool and fails if
    any reports itself unimplemented, so a tool added tomorrow is covered.

25. `FAILED` → fixed. **`getHeadToHead` crashed on a malformed id.** The
    argument went straight into a `::uuid` cast, so an empty or malformed value
    returned a raw `PostgresError` — a 500 from the chat route, and a disclosure
    of the column type. Tool arguments are chosen by the model, which makes them
    untrusted input in exactly the way a query string is. Guarded, with the
    malformed cases tested explicitly.

One of my own assertions was wrong and is recorded rather than quietly changed:
the fabricated-odds test required `ok: false` for an unknown fixture. `ok`
reports whether the tool *ran*, not whether it found something, and conflating
those would make a normal answer look like a fault. The assertion now checks
what the attack is actually about — that no price is returned and the answer
says it cannot find the fixture.

### Stage 5j — personalisation and Admin AI are blocked, and by what

Searched the repository. **There is no specification for either.** The only
reference is one backlog line, `docs/who-does-what.md` D9, saying both are
greenfield. Every historical report agrees and puts the source-match count at
zero: `PROJECT_STATUS.md`, `PLUTOBET_STATUS.md` C6/C7, `GPT.md`. "Phase 19" and
"Phase 23" are named; the phase document itself is not in the repository.

**Personalisation is `BLOCKED_BY_PRODUCT_DECISION`** — and specifically *not*
`BLOCKED_BY_KEY`. It needs no model. The data exists and the arithmetic is
ordinary. What does not exist is the part that matters on a gambling product:
**what is recommended, to whom, and when it is withheld.** Undecided, and not a
developer's to decide:

- What is surfaced — a fixture, a market, a stake size? A recommended *stake* is
  a different product, and a different regulatory object, from a recommended
  fixture.
- On what signal. Betting history is the obvious one and it is also the signal
  that most reliably identifies somebody losing.
- **When it is suppressed.** For a customer under a deposit limit, in cool-off,
  showing loss-chasing behaviour, or flagged by the risk console. A recommender
  with no suppression rule is a system that pushes hardest at the customer it
  should be pushing at least.
- Whether it is **marketing**. `user_preferences.marketing_emails` already
  records a consent this product would have to respect, and Nigerian rules on
  gambling advertising bear on the answer.

Building it without those means writing the responsible-gambling policy of a
money feature into a recommender, which the owner's instruction forbids. Recorded
as blocked with the decisions named, rather than shipped to look complete.

The parts of personalisation that are *not* promotional already work: the "Your
competitions" rail (favourites, whose reachability was fixed in stage 3) and the
stored display preferences.

**Admin AI is `BLOCKED_BY_KEY` and `BLOCKED_BY_PRODUCT_DECISION`, both.** No
model is connected. Separately, nobody has decided which admin actions an
assistant may take — the admin console approves withdrawals, adjusts exposure
and settles bets, and an assistant over those needs its own tool registry and
permission model before a line of it is worth writing.

### Stage 5k — the unavailable pages were honest, and one reason was not

Fantasy, Lucky Numbers and Live Casino all render `ComingSoon`: the product
name, what it is, a plain "Not available yet", and two routes to something that
works. No fake tiles, no dummy fixtures, no dead buttons. That is the outcome
the owner asked for and it was already in place.

One defect. `FAILED` → fixed. **The placeholder told every visitor the same
reason** — "It needs a provider we have not connected." That is true of a
streamed casino and true of a licensed draw. It is **false of Fantasy**, which
needs building; it is our own work, not a provider's. A page that reads as
honest while giving a reason that is not the real one is a fabricated blocker,
and that is the same defect as a fabricated feature — it just flatters us
instead of the product.

Each planned product now carries its own reason in the navigation registry, and
`navigation.acceptance.spec.ts` asserts that every `PLANNED` item has one and
that no `LIVE` item does — so adding a planned product forces somebody to say
why it is unavailable. Verified in the browser: all three pages served their own
sentence.

### Stage 6 — load and reliability, measured

`scripts/bench-http.mjs`, against the review server on a disposable local
database. Report at `artifacts/load/HTTP_LOAD.md`. It covers the paths D8 lists
as untested — the board, the live-feed poll at scale, and Pluto concurrency.

**Zero failures and zero 5xx across every scenario.** 300 requests each at
concurrency 25, plus a 30-request single-customer baseline.

| Scenario | alone p50 | loaded p50 | p95 | p99 | txn/req |
|---|---|---|---|---|---|
| Board `GET /` | 23ms | 528ms | 886ms | 1350ms | 2.0 |
| Market list `GET /sports` | 16ms | 453ms | 603ms | 719ms | 2.1 |
| Live poll `GET /api/live` | 6ms | 97ms | 121ms | 132ms | **0.8** |
| Odds `GET /api/odds` | 6ms | 125ms | 172ms | 183ms | 1.9 |
| Pluto `POST /api/ai` | 6ms | 53ms | 82ms | 102ms | 1.6 |

**Read the last column, not the first.** Latency here is one laptop running
Postgres, Next and the harness at once; it describes the weather. Transactions
per request is machine-independent, and it is what moves when somebody adds a
query inside a loop.

The board at 23ms alone and 528ms at concurrency 25 is **queueing on a single
Node process**, not an expensive page — which is why the baseline column exists.
Without it the obvious next move would have been to optimise a page that renders
in 23 milliseconds.

`GET /api/live` at **0.8 transactions per request** is the stage 5e cache
working: fewer than one database transaction per poll means most polls are
served from Redis inside the 2-second TTL. That is the first measurement of it;
5e was `VERIFIED_BY_INTEGRATION_TEST` and this is the load evidence.

**The rate limiter is measured, not assumed.** Each simulated customer sends its
own `x-forwarded-for` — the key the limiter uses, and what a crowd behind a proxy
looks like — so the control runs on every request rather than being disabled to
get a number. Then one client fires 200 requests at a 120-per-minute budget:
**120 answered, 80 refused with 429, 0 failures.** A limiter that sheds load by
refusing is working; one that sheds it by falling over is not.

**Not measured, and why.** Casino callbacks: there is no callback route in the
repository to load. The casino is a sandbox adapter with no aggregator
connected, so there is nothing to measure and a figure would be an invention.
Bet placement under contention already has correctness tests under concurrency.
And the Pluto figure is the route, guardrails and dispatch — **not** model
latency, which does not exist yet and will dominate the moment it does.

### Stage 7 — one customer, all the way through

`customer-journey.acceptance.spec.ts`. Registration, funding, a bet, a win, a
replayed result, a loss, a void, a corrected result, a cash-out and two refusals — **14 steps, one
account, one run**, on a clean disposable database. All pass.

Seventy-five test files already covered these modules in isolation and covered
them well. What none of them could see is the **seam**: an account that
registers and then cannot bet, a deposit that credits a bucket placement will
not spend from, exposure claimed by one module and released by another. Each of
those is a passing-test, broken-product failure living between two files that
each pass. So the assertions are about **continuity** — the balance after step
six is the balance step five left behind — and nothing is re-seeded between
steps.

Money moves only by the ordinary routes: the real registration handler with a
real one-time code, `applyDepositWebhook` (what the payment webhook calls), the
placement HTTP route, `ingestResult` and `settleBet`, and the cash-out route.
**No balance, ledger row, bet status or exposure value is written by the test.**
The session is the only substitution, because a test cannot hold a cookie.

Two defects, and one of them was mine:

29. `FAILED` → fixed. **A refused bet did not say why.** The slip service works
    out the exact reason a combination failed — no funds, price moved, market
    full — collects them, and the route **dropped them**. A customer with an
    empty wallet was told "none of the combinations on this slip could be
    placed": true, useless, and indistinguishable from a suspended market. On a
    single bet, which is most of them, there is exactly one reason and it was
    already known.

    The reasons now travel with the response, through a new `details` field on
    `ApiError`. They are a **hand-written mapping**, never `error.message` —
    the domain messages are written for a log and three of them leak:
    `InsufficientFundsError` carries a wallet UUID, `AccountNotEligibleError` a
    user UUID, and `ExposureLimitError` states how much more liability a market
    will absorb, which tells a bettor exactly how much the book will take
    before it stops. Anything unrecognised collapses to one generic line,
    because an unexpected error is precisely the one whose message was never
    written with a customer in mind. The journey asserts the reason arrives
    **and** that no UUID comes with it.

30. **My own helper made the mistake `AGENTS.md` exists to prevent.** The first
    version of `cashMinor` was `WHERE user_id = ? AND kind = 'CASH' AND
    currency = 'NGN'` — wrong twice: `kind` is USER or SYSTEM, and CASH is a
    **bucket**. It is exactly the bucket-blind predicate that matches three rows
    and takes whichever the planner returns first. It failed loudly only because
    I also guessed the column name wrong; had `cached_balance_minor` been right,
    the query would have run, returned a plausible number, and the journey would
    have asserted against the wrong wallet all the way through. It now calls
    `balancesForUser`, so the test and the product read a balance the same way.

One assertion was also tightened after it passed. Step 10 began as `if
(!quote.available) return`, which would have gone on passing if cash-out stopped
pricing anything at all. A PENDING bet placed moments ago on an OPEN market for
an ACTIVE account **must** be priceable; it is asserted, not tolerated.

### Stage 8 — security re-verified against what this pass changed

`docs/security-review.md` 24.1 is re-checked rather than assumed still true.
Four things this pass introduced needed review, and all four are recorded there
as deliberate decisions with a re-review trigger:

- **`ApiError.details`**, new, so a refused bet can say why. It is a curated
  field, not a passthrough — one call site, hand-written pairs, and the check
  that no domain message reaches it. **Verified**: 17 `new ApiError(...)` call
  sites in the repository, exactly **one** passes `details`, and it passes
  `SlipError.failures`, which is built by `customerReason` and contains no
  identifier. The journey test asserts no UUID appears in that response.
- **`alwaysConfirm`** on responsible-gambling tools, and why it is not a
  promotion to `FINANCIAL`.
- **The review server's generated secrets**, replacing the production
  `AUTH_SECRET` and `IDENTITY_PEPPER` it used to inherit from `.env`.
  **Verified**: `.env.review.local` is untracked and `secret-scan` is clean
  across 447 files.
- **The AI tool registry**, now with a 53-attack corpus behind it.

Also re-checked and unchanged: every new route added this pass —
`/api/payments/banks`, `/api/account/date-of-birth`, `/api/bets/[id]/cashout` —
uses `authedRoute`, and no `dangerouslySetInnerHTML` exists anywhere in the
application.

**What was not re-done.** The areas this pass did not touch — argon2id, session
revocation, RBAC separation of duties, webhook HMAC, the money-path locks — are
unchanged and their existing evidence stands. Re-running a review of code that
did not change would produce a fresher date and no new information, and a date
is not evidence.

### Current task checkpoint — 2026-11-16

The Next.js security patch is published to `origin/main`. The following Pxxl
attempt cloned that commit but failed while preparing dependencies: it had no
restored package cache, started `npm install`, and ended about 16 minutes later
with a generic preparation failure. No package-level error was present in the
provided log, so its root cause is not established.

The project now restricts Node to `24.x`, matching `.github/workflows/ci.yml`
and the local Node `24.20.0` used for verification; the deployment log selected
Node 26 before this pin. This aligns runtime selection with the tested CI major,
but the next remote run is still required to establish whether Pxxl now
completes installation and deployment.

| Check | Evidence |
|---|---|
| Installed dependency versions | `npm ls next eslint-config-next --depth=0`: both 16.3.3 |
| Node runtime | `node --version`: `v24.20.0`; project engine and lockfile require `24.x` |
| TypeScript | `npm run typecheck`: exit 0 |
| Lint | `npm run lint`: exit 0 |
| Unit tests | `npm test` on the preceding Next.js patch: 80 files passed; 1,034 tests passed, 1 skipped |
| Production build | Next.js 16.3.3 build passed on Node 24 with database URLs overridden to loopback port 1; the deployment migration wrapper was not run |
| Secret scan | `npm run ci:secrets`: 496 files scanned; clean |
| Documentation consistency | `npm run ci:docs`: 13 documents, 15 rules, clean |
| Install audit summary | npm reported 37 dependency vulnerabilities (22 moderate, 9 high, 6 critical); this patch did not apply unrelated audit fixes |
| Remote install/deployment | The supplied attempt failed before the build with a generic Pxxl preparation error and no package-level failure detail. Retry after pushing the Node pin; remote success remains unverified |

**Next action:** check the deployment provider for the result of the requested
push. No further local code change is indicated by the supplied build log.

### Previous gap-closure pass (historical)

The following work is retained as evidence from the prior developer-completion
pass; it is not the current assignment.

**Two gap-closure passes ran on `finish/developer-verification-and-truth`.**
The first reconciled this document and built the manifest, the coverage gate and
the first browser suites. The second closed the flows the first one had
classified as untestable, added the settlement journey and the rest of the
security matrix, and found six more defects doing it.

What was done:

| Unit | State |
|---|---|
| Documentation consistency checker (`scripts/check-docs.mjs`) + CI wiring | **DONE** — 7 rules, **proved to fail** on an injected wrong migration total and clean when restored |
| Reconcile the contradictions it found | **DONE** for the 20 it detected: migration totals, readiness counts, the finished-work-in-active-backlog table, a deleted file described as live, a second document claiming to be the source of truth, a retired status label |
| Expected-control manifest + coverage gate | **DONE** — `e2e/control-manifest.mjs` and `scripts/check-control-coverage.mjs`, which fails when a declared browser control has no audit row *and* when a non-browser row carries no reason |
| Board, betslip and global-chrome coverage | **DONE** — `e2e/board-and-betslip.spec.ts` |
| Account, safer gambling, wallet and KYC coverage | **DONE** — `e2e/account-and-wallet.spec.ts` |
| Admin browser verification | **DONE** — `e2e/admin.spec.ts`, including a support agent refused at the URL **and** at the route |
| Browser-level customer journey | **DONE** — `e2e/journey.spec.ts`: sign in, bet ₦200, balance moves exactly ₦200, admin sees it, cash out taken, sign out |
| `INTERNAL_SECURITY_VERIFICATION` | **DONE** — `e2e/security.spec.ts` (12 probes; found finding 41) and `e2e/security-extended.spec.ts` (14 more, covering every attack class the brief named; found findings 51 and 52) |
| Dependency audit | **DONE** — 0 in shipped dependencies; 4 moderate dev-only, recorded with exploitability |
| Review-only delivery and storage adapters | **DONE** — a local mailbox for one-time codes and a disposable local KYC store, both refusing on four independent environment conditions, each asserted on its own |
| The flows the first pass called untestable | **DONE** — registration, "change details", the duplicate refusal, password reset, a successful password change, session revocation from a second browser, KYC upload and admin review, the withdrawal caps, cool-off, self-exclusion and its survival into a new account, suspended and closed markets, a repriced price, duplicate placement, partial cash-out, a stale cash-out offer, and the Betslip/My Bets tabs |
| Browser-to-worker settlement journey | **DONE** — `e2e/settlement-journey.spec.ts`: a bet placed in the visible betslip reaches WON, LOST and VOID through `dispatchSettlementOutbox` → `settleEvent` → `settleBet`, paid exactly once, replayed with no second payment |
| A successful sensitive admin action | **DONE** — `e2e/admin-actions.spec.ts`: a payout approval refused without step-up, then completed with it, then found in the audit log |
| Internal security matrix completed | **DONE** — `e2e/security-extended.spec.ts` adds CSRF, session fixation, stored and reflected XSS, upload abuse, SSRF shapes, mass assignment, forwarding-header spoofing, webhook replay, per-flow idempotency conflicts and the three cross-user surfaces |
| Coverage gate rebuilt on a closed reason list | **DONE** — a non-browser row must now carry one of seven codes, and a reason that reads as an inconvenience is refused outright |
| Documentation checker strengthened | **DONE** — 13 rules; the six new ones each **proved to fail** on the contradictions this pass was asked to correct, and clean once corrected |
| Money-invariant gate | **DONE** — `npm run ci:money`, nine read-only invariants that must all be zero |
| Final gates, twice | **DONE** — see §4. Both runs on a freshly recreated disposable database and a flushed disposable Redis: **355 passed / 13 skipped / 0 failed / 0 flaky**, twice, and **1034 unit tests passed / 1 skipped**, twice |
| Defects found by the final runs | **THREE, all fixed** — finding 56 (the cash-out confirmation was destroyed by the refresh that caused it), finding 57 (the diagnostic written to explain failures blocked every successful run), finding 58 (a readiness check silently counted migrations on the production database and is disclosed in §22) |
| **Withdrawal account resolution** | **DONE** — `PaymentProvider.resolveBankAccount`, the Paystack adapter against its documented `/bank/resolve` endpoint, an authenticated rate-limited route, a read-only name in the form with stale-response protection and an explicit confirmation, and a server-side re-resolve that overwrites whatever the browser sent. 8 fixture tests, 3 browser tests. Findings 59, 60 and 61 |
| **CSRF guard, reproduced and widened** | **DONE** — the reported `Origin: https://evil.example.com` acceptance was **reproduced first** and found already fixed (403). Two shapes that were NOT fixed were found by the same probe and answered 201: cross-site fetch metadata, and a hostile `Referer` with the Origin stripped. Both refused now, and the guard was applied to `publicRoute`, where `/api/ai` and `/api/bookings` read the session cookie with no origin check at all. 15 unit cases, 3 browser probes |
| **Documentation checker, rule 14** | **DONE** — a security result may no longer record an attack as accepted without saying it was fixed. **Proved to fire on the exact sentence** this document carried for a pass: "The last one was accepted with 201 — finding 51" |

The prior pass classified the remaining developer backlog as empty; its owner,
key, contract, product, regulator and human dependencies remain documented in
§23 and in the owner-decision table.

### Current publication status

The security patch was published to `origin/main` at the owner's request.
`plutobet/main` was not updated by this task. The result of any automatic
deployment after the push is not verified.

Verify the refs and tree instead of recording a hash here:

```bash
git rev-parse HEAD
git ls-remote origin refs/heads/main
git ls-remote plutobet refs/heads/main
git status --short
```

### Historical publication checkpoint — 2026-09-06

At that checkpoint, work was published to `plutobet` only and `origin` had not
been pushed.

**How it got there, in two steps and with no history rewritten.** The owner
merged **PR #1** on GitHub, which put the first six commits onto
`plutobet/main` as merge commit — and that merge changed nothing: its tree is
byte-identical to the branch tip it merged. The three commits made afterwards
were then merged forward locally. Nothing was rebased and nothing was forced,
because those commits were already published and rewriting published history is
not on the table.

The September deployments API check reported 0 deployments for
`plutobet-ai/plutobet_ai` and 30 for `Madubuezejoshua/plutobet`. Those are
historical counts, not current deployment status.

**THE TWO REMOTES' `main` BRANCHES NOW DIFFER, DELIBERATELY.**

| ref | state |
|---|---|
| `origin/main` | **unchanged at `299d4b9`** — the redesign only. Pushing it deploys, so it was left alone |
| `plutobet/main` | **ahead** — PR #1 plus the merge of the three commits after it |

This was briefly recorded as an unexplained divergence, because a commit
appeared on `plutobet/main` that this clone did not have and no push from here
had created it. Fetching answered it: the owner had merged **PR #1** on GitHub.
That is worth leaving in the record — a status file noticing that a branch moved
under it, and saying so before explaining it, is the behaviour that keeps the
file trustworthy.

```bash
git fetch plutobet
git log --oneline origin/main..plutobet/main   # what main carries and origin does not
```

**There is nothing left to publish.** The gap-closure branch was merged into
`main` and `main` was pushed to `plutobet`; `git log --oneline
plutobet/main..HEAD` is empty and the working tree is clean.

An earlier version of this section carried commands to push that branch. They
are gone rather than kept for reference: an instruction to publish something
already published is not harmless documentation, it is an invitation to run a
push against a remote while believing it is the safe one.

**Verify the current state instead of pushing anything:**

```bash
git rev-parse HEAD                          # what is checked out
git ls-remote plutobet refs/heads/main      # expect the SAME hash: published
git ls-remote origin  refs/heads/main       # expect an OLDER hash, deliberately
git log --oneline plutobet/main..HEAD       # expect empty
git status --short                          # expect empty
```

**These two remain the only dangerous commands in this repository, and neither
should be run without deciding about a deployment first:**

```bash
git push origin <any-branch>   # creates a Vercel PREVIEW deployment
git push origin main           # creates a Vercel PRODUCTION deployment
```

Note that the Vercel project is on a platform this product does not deploy to —
the owner uses Railway — so the first question is whether that integration
should exist at all, not which branch feeds it. §24 action 1.

**Also urgent and unchanged: check the Vercel production deployment** that the
earlier `main` push triggered. See "A production deployment happened" below.

**HISTORICAL FROM HERE TO THE END OF THIS SECTION.** Everything below describes
a blocker that was resolved on 2026-09-05: the owner authenticated git, the
redesign branch was pushed to both remotes, the fast-forward merge into `main`
was completed, and CI passed on that commit on both repositories. **None of it
describes the current state** — `origin` has had nothing pushed to it since, and
the sentence "pushed to both remotes" is true only of the redesign. The text is
kept because it records how the blocker was resolved.

---

**RESOLVED 2026-09-05 — everything below is a record of a blocker that no longer
exists. Nothing here describes the current state.**

For part of this pass the push **was** stopped at its first step, because the
machine held **no GitHub credential**: no entry in Windows Credential Manager, no
`~/.ssh` key, no `GITHUB_TOKEN`/`GH_TOKEN`, no `gh` CLI, and no
`~/.git-credentials`. `git fetch` succeeded because both repositories are public
and read anonymously; `git push` failed with *"could not read Username for
'https://github.com'"*.

The brief's instruction for exactly that case was followed: **nothing was
forced, and the merge into `main` was deliberately not performed** while it could
not be published. The owner then authenticated, and the sequence below was run
and completed.

There was also a transient failure worth remembering because it looks like an
auth problem and is not: `fatal: unable to access … Could not resolve host:
github.com` is **DNS**, not credentials. It never reaches the sign-in step. The
fix is `ipconfig /flushdns`, or setting a working DNS server on the adapter.

**The sequence that was run** (Git Credential Manager was already configured as
the helper, so the first push opened its browser sign-in):

```
git fetch origin --prune && git fetch plutobet --prune
git log --oneline origin/main..main          # expect: empty
git push origin   ui/plutobet-sportsbook-redesign
git push plutobet ui/plutobet-sportsbook-redesign
git switch main && git merge --ff-only ui/plutobet-sportsbook-redesign
git push origin main && git push plutobet main
git rev-parse origin/main plutobet/main      # expect: identical
```

It ran as a **fast-forward**: `main` was 0 commits behind the branch and both
remotes were still at `83cb633`, so nothing had to be resolved and no history was
rewritten. `tsc`, `eslint` and the secret scan were re-run on `main` before it
was pushed; the merged tree was byte-identical to the branch tree already covered
by the full suites, so re-running those would have re-measured the same content.

**Railway was not deployed**, and no live provider was activated. A **Vercel**
production deployment did fire on the `main` push — see the deployment section
above, which is the current statement on it.

### Files being modified right now


**Nothing. The working tree is clean.**

**HISTORICAL — the gap-closure branch, since merged into `main` and published.**
These commits are on `plutobet/main`; the branch itself no longer has anything
that `main` does not:

| Commit | What it carries |
|---|---|
| `9b770d8` | `scripts/check-docs.mjs` + CI, and the twenty real contradictions it found |
| `e2b7b43` | The control manifest and coverage gate; board, betslip and admin browser coverage; findings 40 and the four test defects |
| `83d15a0` | `INTERNAL_SECURITY_VERIFICATION`, the browser customer journey, account/wallet coverage, and findings 41–44 |
| `85a19ef` | Findings 45–47, the reset database, and the final gates run twice |

**Already on `main` at both remotes** — the earlier passes:

| Commit | What it carries |
|---|---|
| `b2f6878` | The accessibility pass (axe + keyboard), the 7-viewport sweep, the review server's credential neutralisation, and findings 31–38 |
| `0ab5ae4` | The footer layout fix (finding 39), re-captured screenshots and contact sheet, and the stage 9 gate results |
| `84aab07` | The MSVC redistributable confirmed installed and the DLL workaround retired. **This is the commit the merge fast-forwarded to** |
| after it | Documentation-only commits recording the merge, the green CI, and the Vercel deployment |

### Decisions and assumptions made


- Commit counts, branch state and remote heads are read from git on every
  checkpoint rather than carried forward in prose.
- The standing reporting instruction lives in `AGENTS.md` **outside** the
  BEGIN/END markers `next dev` regenerates.
- Exposure is made exact with a recorded `released_liability_minor` rather than
  by releasing a proportion of the remaining stake at settlement. The
  proportional approach truncates at every step and leaves a residue permanently
  claimed; recording what was released is exact and auditable.
- A full cash-out sets `cashed_out_stake_minor = stake_minor`, so one
  database-checked invariant covers both routes into `CASHED_OUT`. Verified not
  to affect `product-reconciliation.service.ts`.
- Cash-out is refused for every non-`ACTIVE` status including `SELF_EXCLUDED`,
  per the owner's explicit instruction. It **differs from withdrawal**, which
  permits a self-excluded customer so as not to trap their money. Deliberate:
  cash-out is a wagering decision and nothing is trapped, because the bet still
  settles and still pays.
- The cash-out money key is derived from the bet, not supplied by the client. A
  client key protects only against that client's retries.
- A quote is ownership-checked: what a bet is worth also reveals that it exists.
- Date of birth is **write-once** through the customer-facing path. The age gate
  rests on it, and an editable value would turn a refused registration into an
  accepted one on the second attempt. Correcting a genuine mistake is an admin
  action with a reason attached — not built here, and not needed until someone
  asks for it.
- Deposits are **not** blocked for a missing date of birth, and this is
  deliberate. The deposit rail is a dedicated NUBAN: money arrives by bank
  transfer with no application action to refuse. Blocking the webhook would
  strand a customer's money, which is worse than the gap it closes. Betting and
  withdrawal — both of which the application does control — are blocked.
- Playwright is a dev dependency: the browser, interaction and accessibility
  audits need a real driver, and the previous pass proved a one-shot headless
  capture reports a viewport it did not use.
- Two review artefacts are **committed** — the contact sheet and the interaction
  audit — and the 27 full-page screenshots behind them are not. The two are the
  evidence that the interface was checked in a browser; the rest is ~4MB that
  `scripts/capture-ui-screenshots.mjs` regenerates. `artifacts/` is excluded as
  `artifacts/*` rather than `artifacts/`, because a trailing slash makes git skip
  the directory and no negation can re-include what git never descended into.
- The review server refuses to start against a non-loopback host rather than
  documenting that it should only be pointed at one. The failure being prevented
  is silent — the application comes up perfectly against production — so a
  convention would not have caught it.

### Latest gate results


Run on **2026-09-05**, on a **freshly reset disposable database** — the previous
one had been seeded eight times (finding 45) and carried limits set by an
earlier test run (finding 47), and neither is a state a gate should be measured
against. Every one is a full run, not a subset.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0**, 0 errors |
| `npx eslint .` | **exit 0**, 0 errors, **0 warnings** |
| `node scripts/secret-scan.mjs` | **clean**, 15 rules |
| `node scripts/check-docs.mjs` | **clean**, 13 documents, **15 rules** |
| `git diff --check` | **exit 0**, no whitespace or conflict markers |
| `npx vitest run` | **80 files, 1034 passed, 1 skipped, 0 failed** — **run twice after the final code change, identical both times** |
| `npm run build` | **exit 0**, `deploy: target=local (no migrations)` |
| `npx playwright test` | **368 tests: 355 passed, 13 skipped, 0 failed, 0 flaky** (desktop 1440×900 + Pixel 7) — **run twice on a freshly recreated database, identical** |
| `node scripts/check-control-coverage.mjs` | **exit 0** — **165 controls declared, 152 browser-covered**, every one with an audit row **in both projects**; 9 blocked and **4** integration-boundary, each carrying one of seven accepted reason codes |
| Screenshots + contact sheet | **28 screenshots** re-captured on the clean database; `artifacts/ui-review/00-contact-sheet.png` regenerated and inspected |
| Interaction audit | **352 rows**, generated from the run, `artifacts/ui-review/INTERACTION_AUDIT.md` |
| `node scripts/check-migrations.mjs` | **29 of 29** apply to a clean database, 62 tables, exit 0 |
| `npm audit --omit=dev` | **0 vulnerabilities** in what ships |
| `npx tsx scripts/smoke-admin.ts` | **18 of 18** admin queries clean, exit 0 |
| `npx tsx scripts/audit-db-roles.ts` | **exit 0** — the runtime role owns nothing and cannot `DROP`, `ALTER` or `TRUNCATE` the ledger. **Local stack only** |
| `readiness:demo` | **NOT DEMO READY**, 1 blocking item — correct, see below |
| `readiness:real-money` | **NOT REAL_MONEY_READY**, 13 blocking items — correct, see below |
| `INTERNAL_SECURITY_VERIFICATION` | **26 of 26** probes pass across the two files, §20 |

**The vitest total is 1,034**, and the single skip is the opt-in live-provider
contract, which runs only when `ODDS_API_KEY` is set. It is deliberately unset,
so the skip is by design and **is recorded as external, not as passing**. There
are no `.only`, no `test.todo`, and no other skips.

Three numbers here used to be written as prose and each went stale on its own
schedule. Each quoted a figure that was true at the time it was written —
while §4 said something else. They are now stated once, and `ci:docs` compares
any figure written beside the word vitest against the run that produced it.

**The browser suite stands at 368 tests, 355 of them passing.** All 13 skips are by design:
six measured-column checks that `test.skip` on the mobile project because a
phone viewport is narrower than the column they measure, and seven responsive
sweeps that override the viewport themselves and so run once rather than twice.

**The two readiness scripts are red and that is the right answer.** Every
blocker they name is an owner, key, contract or regulatory item: no payment
provider, no SMS or email provider, no KYC provider, no error reporting, no
licence, no settlement bank account, no rotated credentials, no restore drill,
and no real deposit or payout on record. **None is a developer defect and none
was removed to obtain a green result.** The single demo blocker — `NEXTAUTH_URL`
points at localhost — is an artefact of running the check against the local
stack; it is owner configuration at deployment time, not code.

**One honest limit on the role audit.** It proves the *runtime* role `bet_app`
owns nothing and cannot alter the ledger, which is the property that matters.
The owner role in this local stack is the embedded cluster's superuser, so this
run does **not** demonstrate the production owner role is correctly restricted.
Per the owner's instruction, runtime privilege is not marked complete until it
is tested with the actual restricted production credential, which does not exist
yet — `BLOCKED_BY_OWNER_CONFIGURATION`.

The single skip is `provider-contract.acceptance.spec.ts`, a `describe.skipIf`
that runs only when `ODDS_API_KEY` is set; it is deliberately unset, so the skip
is by design and not a failure being hidden. There are **no** `.only`, no
`test.todo` and no other skips.

The browser suite has grown across four passes — it stood at 118, then at 152
when the 7-viewport responsive sweep and the accessibility file were added, then
again with registration, password reset, session revocation, KYC, the withdrawal
caps, cool-off, self-exclusion, market states, partial cash-out, the
browser-to-worker settlement journey and the successful admin action, and again
with the extended security matrix and bank-account resolution. **Every one of
those figures is a waypoint. The current total is the one in §4, which is read
from `artifacts/playwright-report.json` and checked by `npm run ci:docs`; no
other figure in this document may disagree with it.**

**Every skip is by design and none hides a failure**: the measured-column check
`test.skip`s on the mobile project because a phone viewport is narrower than the
column it measures, and the responsive sweep overrides the viewport itself and
so runs once on the desktop project rather than twice. The live-provider odds
contract runs only when `ODDS_API_KEY` is set; it is deliberately unset, so that
skip is a **blocked external check and is not counted as a pass**.

**The accessibility bar is met**: 0 critical and 0 serious violations across 25
pages in both projects, and axe's advisory (moderate/minor) set is empty too.
Both keyboard tests pass — every focusable control shows a focus indicator, and
60 tab presses reach far more than a handful of distinct controls, so there is no
trap. Getting there took five defects; they are findings 33, 34, 35 and 38.

### Known failures and blockers


| # | Finding | Status |
|---|---|---|
| 1 | Partial cash-out refused by a constraint on every call, untested | **FIXED**, 5a |
| 2 | Partial cash-out's exposure slice released twice | **FIXED**, 5a |
| 3 | `CashOutService` did not check account status | **FIXED**, 5b |
| 4 | A retried cash-out returned an error for money already paid | **FIXED**, 5b |
| 5 | `ASSUMED_FINISHED_AFTER_MS` duplicated a policy the SQL restated as a literal | **FIXED** |
| 6 | Cash-out had no API route and no UI | **FIXED**, 5c |
| 7 | Accounts with no date of birth were outside the age control entirely | **FIXED**, 5d |
| 8 | The age gate used the database's local date, the service used UTC | **FIXED**, `0028` |
| 9 | Every betting fixture was accidentally a legacy account | **FIXED** |
| 10 | The admin compliance page said missing-DOB accounts were "not blocked" | **FIXED** — they are |

| 11 | `/api/live` recomputed a three-table aggregate on every poll | **FIXED**, 5e |

| 12 | The withdrawal form asked for a hand-typed NIP bank code | **FIXED**, 5f |

| 13 | The sign-in password field's accessible name included the "Forgot password?" link | **FIXED**, stage 3 |
| 14 | No `not-found.tsx` — Next served an unbranded 404 with no way out | **FIXED**, stage 3 |
| 15 | Edit bet has no product rules anywhere in the repository | **BLOCKED_BY_PRODUCT_DECISION** — not built, by instruction |
| 16 | The signed-in mobile header measured 446px in a 412px viewport | **FIXED**, stage 3 |
| 17 | Competition favouriting was unreachable with ≤8 leagues | **FIXED**, stage 3 |
| 18 | `.sb-page` was deleted with the style bridge; every non-board page went full-bleed | **FIXED**, stage 3 — and now has a regression test proved to fail without it |
| 19 | The audit file was truncated once per project, keeping only the last browser's rows | **FIXED**, stage 4 |
| 20 | The screenshot capture deleted the audit it was meant to sit beside | **FIXED**, stage 4 |
| 21 | The merged audit table was one column short of its header | **FIXED**, stage 4 |
| 22 | The review server inherited production `AUTH_SECRET` and `IDENTITY_PEPPER` from `.env` | **FIXED** — review-only values, and a loopback check that refuses to start otherwise |
| 23 | `setDepositLimit` changed a protection with no confirmation required | **FIXED**, 5i |
| 24 | `setOddsFormat` and `setDepositLimit` were advertised to the model with no handler | **FIXED**, 5i |
| 25 | `getHeadToHead` returned a raw `PostgresError` for a malformed id | **FIXED**, 5i |
| 26 | The unavailable-product page gave a blocking reason that was false for Fantasy | **FIXED**, 5k |
| 27 | Personalisation has no rules for what to recommend, or when to withhold it | **BLOCKED_BY_PRODUCT_DECISION** — not built, by instruction |
| 28 | Admin AI has no model and no decision on which admin actions it may take | **BLOCKED_BY_KEY** and **BLOCKED_BY_PRODUCT_DECISION** |
| 29 | A refused bet dropped the reason; the customer could not tell no-funds from a closed market | **FIXED**, 7 |
| 30 | My own journey helper used a bucket-blind `wallets` predicate | **FIXED** before it could mislead — recorded because it is the mistake the rules name |
| 31 | **The review server reached real providers.** It neutralised the database and auth secrets but inherited every other credential from `.env`: `ODDS_API_KEY` (live, metered), the `B2_*` pair that is the **KYC document bucket**, `INNGEST_*` (the production job queue) and `UPSTASH_*` (production Redis). The interaction suite uploads a KYC document, so a review run was writing test files into the production store of customers' identity documents | **FIXED** — blanked explicitly, and **verified**: `/api/health` reported `ODDS_API_KEY` as `set` before and `missing` after, with the local database and Redis still connected |
| 32 | **The review server's loopback check could not see the URLs the app actually reads.** `db-direct.ts` resolves `DATABASE_URL_UNPOOLED` and `POSTGRES_URL_NON_POOLING` **before** `DIRECT_DATABASE_URL`; `pooled.ts` reads `POSTGRES_URL` before `DATABASE_URL`; `redis.ts` reads `KV_URL` before `REDIS_URL`. The check only ever examined the four names the script sets, so had `.env` gained one alias, the money path would have opened against production and the safety check would still have passed. `.env` does not define any of them — luck, not design | **FIXED** — the aliases are blanked, and a guard refuses to start if `.env` holds a credential this script does not neutralise |
| 33 | **Links in prose were marked by colour alone** on every page (`link-in-text-block`, serious). Includes "take control of your betting" and "Set a limit" — the safer-gambling routes, the worst place in the product for a link to be missable | **FIXED** — prose links underlined |
| 34 | **Secondary text failed contrast site-wide** (`color-contrast`, serious). `--sb-muted` and `--sb-faint` were chosen against white, but the page ground is `--sb-canvas`; muted measured 4.28:1 there. Worse, a **suspended or closed odds price** rendered at **1.9:1** — a number the customer cannot read | **FIXED** — tokens re-based on the worst ground they are used on |
| 35 | **An orphan `role="row"` on `/live`** (`aria-required-parent`, **critical**). The column strip claimed table semantics its rows did not carry, promising a structure a screen reader would fail to find | **FIXED** — presentational, matching `match-board.tsx` |
| 36 | `@axe-core/playwright` was installed in `node_modules` but recorded in **neither** `package.json` nor `package-lock.json`, so CI's `npm ci` would not have had it and the accessibility gate would have failed on a clean checkout | **FIXED** — added to `devDependencies` and the lockfile |
| 37 | The new Pluto interaction test located the chat field by `input[type='text']`, which cannot match an input that sets no `type`. The app was right and the test was wrong | **FIXED** — located by accessible name, which also fails if the field loses its label |
| 39 | **On a short page the footer stopped mid-screen.** `.sb` is `min-height: 100dvh`, but nothing made the middle grow, so on any page with an empty state — results, livescore, promotions with nothing running — the dark footer sat wherever the content ended and left a band of pale canvas beneath it, which reads as a page that failed to finish loading. Found by looking at a screenshot; no automated check measures it, because the page does not overflow and nothing errors | **FIXED** — the shell lays out as a column with a growing middle, scoped to `.sb-app` so the session-free 404 page is untouched. Re-verified in the browser and by the full suite |
| 38 | **Two labels on `/account/preferences` were near-invisible.** They set `color: var(--ink)` — the LEGACY dark theme's near-white `#e9edf5` — on a white card, about 1.1:1. Stage 5h deleted the bridge that used to re-point `--ink` at a readable colour, and these two inline styles were missed, so the page shipped with unreadable text. **Stage 5h's claim that all seven dependent files were converted was wrong**: it audited classes and did not catch legacy variables in inline `style` props | **FIXED** — both use `var(--sb-ink)`, and a repository-wide search now confirms **zero** legacy `var(--…)` references in any `.tsx` file |

| 40 | **The demo seed created a customer who could not bet, and every test passed anyway.** `player@demo.local` was inserted with no `date_of_birth`, which is exactly the legacy state stage 5d closed — so the account carried the "Confirm your date of birth" banner and every placement was refused with the generic "none of the combinations on this slip could be placed". **The browser suite had therefore never once placed a bet**, and nothing said so, because a correct refusal is indistinguishable from a passing test when no test asserts the success | **FIXED** — the seed sets a date of birth for the demo player. Found the moment a test tried to place a bet and read the confirmation |
| 41 | **The password-reset route was an account-enumeration oracle.** Its whole design goal is to answer identically whether or not an address has an account — the comment in the route says so. But the OTP service's refusal to use its console fallback in production threw a **plain `Error`**, which fell past the route's `OtpError` catch and became a **500**, while an address with *no* account short-circuited before any provider was touched and returned **200**. So in exactly the configuration this is deployed in — a production build with no Resend key — **a customer's address answered 500 and a stranger's answered 200.** For a gambling site that is a privacy problem before it is a security one | **FIXED** — a typed `OtpProviderUnavailableError`, and the route now checks `otpDeliveryAvailable()` **before** looking the address up, so the answer cannot depend on the address. Both cases return the same 503. Found by the browser security pass, not by reading the route |
| 42 | The same misconfiguration surfaced on the registration OTP route as an **opaque 500**. A deployment that cannot send anything is not a server fault to be swallowed, and it is not a rate limit either | **FIXED** — 503 with a message that says codes cannot be sent, without naming which variable is missing to an anonymous caller |
| 46 | **A customer stopped by their own safer-gambling limit was not told so.** Placement runs the responsible-gambling checks, which raise `RgViolationError`; the slip catches each combination's error and maps it through `customerReason`, **which had no case for it** — so the refusal collapsed to the generic "This could not be placed", indistinguishable from a full market or a technical fault. `handler.ts` already states the rule at the route boundary — *"the player needs to know a limit or exclusion stopped them, not just that something failed"* — but a slip catches its combinations one at a time and the error never reached it. On a gambling product this is the one refusal where telling the customer **is** the feature: a limit that stops somebody silently has done half its job | **FIXED** — mapped by `limitType` to curated wording for self-exclusion, cool-off, stake, loss, deposit and session. **Mapped, not echoed**: `assertNotExcluded` has an "unknown user" branch whose message carries a user UUID, and this is the boundary where a domain message becomes something a stranger can read |
| 47 | **My own browser test made a money test flaky.** `account-and-wallet.spec.ts` set a ₦4,000 daily *wager* limit on the shared demo account, and it runs before the journey — so once the day's staked total crossed that, every later placement was refused. The mobile journey passed in one run and failed in the next. Running the suite twice is what exposed it; a single green run would have shipped it | **FIXED** — the limits are set high enough not to bite. A limit can only be *lowered* immediately (raising waits 24 hours), so a run cannot undo a low one it has set, which makes choosing a high value the only fix that does not poison the suite. The refusal itself is asserted in `responsible.acceptance.spec.ts`, where the account is disposable |
| 45 | **The demo seed multiplied the board every time it ran.** Fixtures were inserted with a fresh `demo-${randomUUID()}` on every run, with no check for one already there — so seeding eight times during this pass produced **eight copies of every match**, and the board rendered a wall of repeated fixtures. Because the review screenshots are a **committed deliverable**, anyone reading them would reasonably conclude the *board* duplicates fixtures. It does not; the seed did. Found by looking at the regenerated contact sheet | **FIXED** — the seed skips a fixture that already exists as a PENDING demo event. It *skips* rather than deletes: some of those events carry bets from earlier runs, and removing an event a bet points at is data loss, not tidying |
| 44 | **Two internal build-phase labels were rendered in the admin console.** `/admin/risk` and `/admin/users` each told the operator that missing tooling "arrives with the compliance tooling in **phase 20**". A phase number is an internal roadmap reference and means nothing to the person reading it; the redesign removed these from the customer-facing side and missed the admin pages, which were deliberately excluded from that pass | **FIXED** — both now say what is missing and why (its own permission, a written reason, an audit row) without a phase number |
| 43 | **Duplicate DOM ids on every board page.** `BetslipPanel` is rendered twice — as the sticky column and inside the mobile sheet — and below 1180px the column is *hidden by CSS, not unmounted*. So `id="sb-stake"`, `id="sb-stake-err"` and the `<label htmlFor>` pointing at them existed twice. `htmlFor` and `aria-describedby` both resolve to the **first** match in document order, which on a phone is the hidden desktop copy — so the stake field a customer actually types into had its label and its error message bound to a different element. axe missed it: `duplicate-id` is retired for non-ARIA ids, and the error paragraph only exists while an error is showing, which it was not during the scan | **FIXED** — `useId()` gives each panel its own ids. Found by Playwright refusing to guess between two matches, on the mobile project |
| 51 | **A withdrawal declaring a foreign `Origin` was accepted with 201.** No cross-site request could have produced that call — the session cookie is SameSite — so it was not exploitable, but "the only thing stopping this is a cookie attribute" is a poor place for a money route to be | **FIXED**, and **re-verified by reproduction in this pass**: the same probe now answers **403**. The security matrix carried the words "accepted with 201" inside a passing result for a whole pass after the guard was written, which `ci:docs` rule 14 now refuses |
| 59 | **The withdrawal route took the account name from the browser.** `POST /api/withdrawals` accepted `accountName` from the request body and passed it to the transfer recipient. A live probe posted `"ATTACKER SUPPLIED NAME"` and was answered **201**. The number and bank code decide where money lands, so nothing was misdirected — which is exactly why it survived, because the field looked cosmetic. It is the only signal that would tell a customer they had typed a stranger's account | **FIXED** — the route **re-resolves against the provider** and stores the provider's answer. The body now carries `confirmedAccountName`, which exists only to be compared: a screen that went stale between confirming and submitting is refused `409 ACCOUNT_NAME_CHANGED` |
| 60 | **`Sec-Fetch-Site: cross-site` and a hostile `Referer` both walked past the origin guard**, answering **201** on a withdrawal. The guard read `Origin` alone: a request whose Origin was stripped, or one where the browser itself declared the request cross-site, was accepted. `Sec-Fetch-Site` is a forbidden header name that page script cannot forge, so it was the strongest available signal and it was being ignored | **FIXED** — the guard refuses `cross-site` fetch metadata outright, then falls back from `Origin` to `Referer`. Applied to `publicRoute` as well, because `/api/ai` and `/api/bookings` read the session cookie and had no origin check at all. 15 unit cases and three browser probes, each asserting the balance and the money invariants are unchanged |
| 61 | **On the review server the bank list could not be fetched at all.** `[payments] bank list unavailable` appeared in the log on every load and the picker was empty, because the review server is a production build and `createPaymentProvider()` correctly refuses the sandbox there. The withdrawal path only kept working because `isPayableBankCode` deliberately passes when no list can be established — so a made-up bank code went through a check that had nothing to check against, and the tier-1 cap test was passing while posting a bank code the server could not validate | **FIXED** — `paymentProviderForReads()` opens the seam for `listBanks` and `resolveBankAccount` only. `parseWebhook` and `initiateTransfer` still refuse, and the webhook-signature probe passing is what proves the control was not weakened |
| 62 | **The whole browser suite shared one one-time-code budget, and the eleventh registration in fifteen minutes was refused.** `RATE_RULES.otp` is 10 per IP per 15 minutes — deliberately tight, because issuing a code costs SMS money and registration is the surface a bot uses to mass-create accounts. The suite runs from ONE address, both browser projects issue codes, and the suite takes longer than the window. So a late test asked for a code, was refused, and failed with *"no one-time code was delivered"* — a failure about the mailbox, in a test about self-exclusion. **It passed in one run and failed in the next**, which is the signature of a shared budget rather than a defect | **FIXED IN THE TESTS, NOT THE CONTROL.** Each test that needs a code now presents its own forwarded address, because a test that registers an account IS a different customer and different customers do not share a connection. The limiter still runs, still counts and still refuses. **Flushing Redis between tests was the obvious fix and is the wrong one** — it would have disabled the limiter for the whole run and hidden precisely what `security.spec.ts`'s burst probe exists to find. That probe still fires from a single address and still requires the burst to be shed by refusing |
| 63 | **The secret scanner could not see a new file, and a pass reported itself complete over a RED CI run.** `secret-scan.mjs` enumerated `git ls-files` — tracked files only — so a brand-new test fixture assigning a Paystack-shaped literal was invisible locally at 491 files and clean, right up to the commit that made it permanent. CI, whose checkout has everything tracked, refused it at 496 files. Two failures in one: a gate reporting on a different file set from the one being published, and a completion claim made from *the push succeeding* rather than from the run passing | **BOTH FIXED.** The literal is assembled rather than written out, so the shape of a credential assignment is not in the repository at all. The scanner now also reads `git ls-files --others --exclude-standard`, catching untracked files while still honouring `.gitignore` — `.env` and `.env.review.local` stay excluded on purpose, because a finding there would print the path of a secret file into a public CI log. No real credential was ever exposed: the value was invented and matches nothing |

**Cash-out is now priced *and taken* in a real browser**, and that is an upgrade
with a limit. The browser now **quotes the offer, sees the partial choice, accepts the
offer through the authenticated route, watches the balance rise by exactly the
quoted figure, and re-reads the ticket** — one run, recorded in the audit:

```
Cash out                      quoted "Accept ₦190.00"      GET  /api/bets/<id>/cashout
Cash out — partial option     "Take half and leave the rest running" offered
Cash out — accept full        Cashed out for ₦190.00       POST /api/bets/<id>/cashout
                              CASH ₦48,200.00 → ₦48,390.00
Cash out — ticket updated     the ticket shows it cashed out
```

**The limit**: *taking the partial* is not browser-driven. The choice is
asserted as offered; the half that keeps running, and the exposure released
exactly once, are arithmetic a browser cannot see and are covered by
`cashout-exposure.acceptance.spec.ts`.

A correction worth recording: the control manifest first claimed no partial
control was rendered at all. That was wrong, and reading the component is what
found it — not the test, which had happily agreed.

Blockers inherited from the previous pass are in §23.

### Deliberately not performed

| Not done | Why |
|---|---|
| Deleting the 400 synthetic production fixtures | Needs owner approval on a dry-run fingerprint |
| Applying the ₦630 exposure repair | Same |
| Any Railway deployment | Not authorised by this task. Railway is the owner's actual platform, and nothing here deployed to it or read its state |
| Any live provider activation | Not authorised, and no credentials exist |
| Reading Railway's live state | **No Railway credential is present**, so nothing in this document describes what Railway is currently running. **Note that a Vercel deployment did occur on a platform this project does not use — see §0** |
| Any force push, reset or history rewrite | Not needed. Both pushes were fast-forwards onto remotes that had not moved |
| Edit bet, personalisation, Admin AI | The rules that define them do not exist, and are not a developer's to invent. Questions listed in `OWNER_LAUNCH_CHECKLIST.md` |
| A screen-reader pass | **Not done.** axe is a static rule engine over the accessibility tree, and a clean run means no rule fired — not that the product is usable with NVDA, JAWS or VoiceOver. Keyboard navigation and the automated rule set are covered; an actual assistive-technology walkthrough is not, and no automated check substitutes for it |
| Replaying the injection corpus through a live model | `BLOCKED_BY_KEY`. The corpus runs against the layer today; how a model answers it cannot be known without one |
| Load-testing casino callbacks | There is no callback route to load |

---

## Contents

| § | Section |
|---|---|
| **0** | [**Resume Here**](#0--resume-here) — the recovery point |
| 1 | [What this document is, and the rules it follows](#1-what-this-document-is-and-the-rules-it-follows) |
| 2 | [How to read the status labels](#2-how-to-read-the-status-labels) |
| 3 | [Where the project stands, in one page](#3-where-the-project-stands-in-one-page) |
| 4 | [Verification gates and their last results](#4-verification-gates-and-their-last-results) |
| 5 | [The customer-facing interface](#5-the-customer-facing-interface) |
| 6 | [Complete interaction inventory](#6-complete-interaction-inventory) |
| 7 | [Design system](#7-design-system) |
| 8 | [Accessibility and mobile](#8-accessibility-and-mobile) |
| 9 | [Authentication and account](#9-authentication-and-account) |
| 10 | [The money core](#10-the-money-core) |
| 11 | [Deposits and withdrawals](#11-deposits-and-withdrawals) |
| 12 | [Betting: pricing, placement, exposure](#12-betting-pricing-placement-exposure) |
| 13 | [Settlement](#13-settlement) |
| 14 | [The real bet that proved the pipeline](#14-the-real-bet-that-proved-the-pipeline) |
| 15 | [Cash-out: repaired, reachable, and tested](#15-cash-out-repaired-reachable-and-tested) |
| 16 | [Responsible gambling, KYC and compliance](#16-responsible-gambling-kyc-and-compliance) |
| 17 | [Admin console](#17-admin-console) |
| 18 | [Background jobs and scheduling](#18-background-jobs-and-scheduling) |
| 19 | [Database, migrations and roles](#19-database-migrations-and-roles) |
| 20 | [Security posture and known exposure](#20-security-posture-and-known-exposure) |
| 21 | [Performance](#21-performance) |
| 22 | [Known contamination and pending destructive operations](#22-known-contamination-and-pending-destructive-operations) |
| 23 | [Blocked work, by what blocks it](#23-blocked-work-by-what-blocks-it) |
| 24 | [What the owner should do next, in order](#24-what-the-owner-should-do-next-in-order) |
| 25 | [Document map](#25-document-map) |
| 26 | [Changelog](#26-changelog) |

---

## 1. What this document is, and the rules it follows

It is the report that gets updated after every piece of work, so that "what is
the state of PlutoBet" has exactly one answer instead of six documents that
each answered it on a different day.

Rules it follows, and which the reports it replaced did not always follow:

1. **A claim carries its evidence, or it is not made.** "Tested" means a named
   test; "works" means an observed run.
2. **Passing tests are never presented as proof that an external service
   works.** Every payments test uses fixtures. Nothing here has contacted
   Paystack, Termii or Resend.
3. **A single completion percentage is not used.** It averaged "a screen is
   missing" against "no casino provider exists" and could not express that a
   customer cannot place a bet.
4. **Nothing is described as automatic that was invoked by hand.**
5. **Secrets, personal data and one-time codes are never written here.**
6. **A finding that was later fixed keeps its trail.** The detail lives in
   `docs/history/`; §25 says where.

**Standing instruction:** after every implementation, test, repair, deployment
or audit task, update this file with evidence-backed current status before
reporting completion. That instruction is also recorded in `AGENTS.md`.

---

## 2. How to read the status labels

**This is the whole vocabulary.** Nothing outside this table appears as a status
anywhere in this document, and a label is never raised without the evidence its
name states.

| Label | Means |
|---|---|
| `VERIFIED_IN_REAL_BROWSER` | Clicked or submitted in a browser, and the result observed. The record is `artifacts/ui-review/INTERACTION_AUDIT.md`, generated by the run |
| `VERIFIED_END_TO_END` | A whole journey completed in one run, across module boundaries, with the money and the ledger agreeing at the end |
| `VERIFIED_AGAINST_REAL_PROVIDER_DATA` | Exercised against a real provider response, not a fixture |
| `VERIFIED_BY_INTEGRATION_TEST` | Driven by tests against a real database. **Not** the same as having watched it happen |
| `VERIFIED_BY_UNIT_TEST_ONLY` | Tested in isolation, with its collaborators substituted |
| `IMPLEMENTED_NOT_LIVE_TESTED` | Written and typechecked; never exercised against production-like conditions. Also covers logic that is finished but that nothing in the product calls, and code waiting on a real-world event nobody can hurry — both are stated in prose where they apply |
| `BLOCKED_BY_KEY` | Needs a paid or approved third-party credential |
| `BLOCKED_BY_CONTRACT` | Needs a commercial agreement with a provider |
| `BLOCKED_BY_OWNER_CONFIGURATION` | Needs an account or a console the developer does not have |
| `BLOCKED_BY_PRODUCT_DECISION` | The rules that would define it have not been decided, and are not a developer's to decide |
| `BLOCKED_BY_REGULATION` | Needs a licence or certification |
| `NOT_IMPLEMENTED` | Not built |
| `FAILED` | Found broken. Kept visible until fixed, with what it was |

### What changed here, and why it is a downgrade

Five labels used here are not in the vocabulary above and are gone. Written
without backticks so that a future search-and-replace over this file does not
rewrite the sentence explaining them, which is exactly what happened while this
paragraph was being written:

| Retired | Replaced by | Count |
|---|---|---|
| VERIFIED_FUNCTIONAL | `VERIFIED_IN_REAL_BROWSER` where the audit covers it, `IMPLEMENTED_NOT_LIVE_TESTED` otherwise | 57 |
| VERIFIED_WORKING | `VERIFIED_BY_INTEGRATION_TEST` | 44 |
| VERIFIED_AUTOMATED_BY_ACCEPTANCE_TEST | `VERIFIED_BY_INTEGRATION_TEST` | 4 |
| IMPLEMENTED_NOT_REACHABLE | `IMPLEMENTED_NOT_LIVE_TESTED`, with the unreachability said in prose | 4 |
| WAITING_ON_REAL_EVENT | `IMPLEMENTED_NOT_LIVE_TESTED`, with the awaited event said in prose | 1 |

**The important one was VERIFIED_FUNCTIONAL**, which §6 defined as "the control
reaches real behaviour — a route that exists, a request that is answered, or
state that persists." That is a claim from **reading the code**, and it was
applied to fifty-five customer-facing controls, where it reads exactly like a
claim that somebody used them.

**That gap is now closed.** When the label was first retired, seven of those
controls could say `VERIFIED_IN_REAL_BROWSER` and fifty said
`IMPLEMENTED_NOT_LIVE_TESTED`. The pass after it took the number of
browser-verified controls into three figures, and THIS pass took the remainder:
registration, password reset, a successful password change, session revocation,
KYC upload and review, the withdrawal caps, cool-off, self-exclusion, suspended
and closed and repriced markets, partial and stale cash-out, settlement through
the registered workers, and a completed sensitive admin action. The current
split is in §5 and is checked against the generated audit by
`npm run ci:controls`; **no customer-facing control that a browser can reach
still says `IMPLEMENTED_NOT_LIVE_TESTED`.**

VERIFIED_WORKING was defined as "exercised against a real database or real
provider data, with a test or a recorded observation behind it."
`VERIFIED_BY_INTEGRATION_TEST` is the conservative reading of that; a few rows
have stronger evidence and say so individually.

**Every one of these is a downgrade or a like-for-like rename.** Nothing was
raised.

**The platform as a whole is not finished.** The core sportsbook flow —
register, browse, price, place, settle, pay — works. That is one flow out of a
product that also promises casino, virtuals, in-play, fantasy and more.

---

## 3. Where the project stands, in one page

| Question | Answer |
|---|---|
| Can a test account complete a bet end to end? | **Yes, twice over.** `VERIFIED_END_TO_END` through the services — 14 steps, one account, one run, ending with the ledger agreeing. **And `VERIFIED_IN_REAL_BROWSER`** — sign in, back a price, stake ₦200, watch CASH fall by exactly ₦200.00, find it in My Bets, see the administrator holding the same bet, take a ₦190.00 cash-out and watch the balance rise by exactly that, then sign out. The two cover different halves: the first controls the clock and drives settlement; the second holds a cookie |
| Can a stranger's real money enter or leave? | **No.** No payment credentials exist |
| Does a winning bet get paid without a human? | **Yes** — proven once on a real fixture, §14 |
| Is the customer interface finished? | **Redesigned and verified in a real browser** — 355 Playwright tests passing, **352 audited interactions**, 28 screenshots, **all seven owner-named viewports swept**, and an accessibility pass at **0 critical / 0 serious** (§5, §6, §8). The redesign and the gap-closure work are both **merged to `main` on `plutobet`**; `origin/main` still carries the redesign alone, §0 |
| Is the deployment usable? | **Not for real customers.** `NEXTAUTH_URL` and the runtime database role remain, §23. Note a Vercel production deployment now exists — see §0 for what it does and does not mean |
| Is it legal to operate? | **No.** No licence, §16 |

Two readiness questions, and they are different:

```bash
npm run readiness:demo          # can this serve a test account, end to end?
npm run readiness:real-money    # may this take a stranger's money?
```

**The counts below are from the run recorded in §4, against the local disposable
stack.** An earlier version of this section said 2 and 14 while §0 said 1 and
13; neither was lying, and that is exactly why the disagreement survived. The
difference is the runtime database role, which the local stack already gets
right and a production deployment does not — see the note under the list.

- **`DEMO_READY` — not satisfied**, 1 blocking item: `NEXTAUTH_URL` points at
  localhost, so sign-in callbacks would send real users to their own machine.
- **`REAL_MONEY_READY` — not satisfied**, 13 blocking items: the one above plus
  Paystack deposits, Paystack payouts, Termii SMS, Resend email, a KYC
  provider, `SENTRY_DSN`, a real deposit proof, a real withdrawal proof,
  credential rotation, a verified restore drill, a gaming licence and a
  settlement bank account.

**One item is invisible to a local run and must not be forgotten.** The runtime
database role is correct on the local stack — `bet_app` owns nothing and cannot
alter the ledger, proved by `npm run db:audit-roles` — but the production
connection string still uses an owner-privileged role (§20). It does not appear
in the counts above because the check reports what it can see from where it
runs, and where it ran the role was already right. Against production
configuration it is an additional blocker for both modes.

**QA ledger credit is not a deposit**, and neither count may be reduced by
treating one as the other. It is never presented as one anywhere in this product
or its reporting — not on a wallet page, not in an admin total, and not in this
document.

---

## 4. Verification gates and their last results

Run from the repository root. Every figure below is from the run on the branch
described at the top of this file.

**Run on 2026-09-06. Both suites were run TWICE after the final code change,
each time on a freshly recreated disposable database and a flushed local Redis,
with identical results both times**, to catch order dependence and flakiness.

Running twice is not ceremony here, and this pass is the clearest evidence yet.
It caught findings 45, 46 and 47 in an earlier pass and confirmed 56 and 57 in
the last one. In THIS one it caught **finding 62** — a test that passed in the
first run and failed in the second because the whole suite was sharing a single
one-time-code budget, which no single green run could have revealed. It also
caught an error of my own: a `npm run build` started while the suite was live
regenerated `.next` underneath the running server and produced a `ChunkLoadError`
on `/responsible`. That run was **discarded and repeated**, not explained away —
a gate result measured against a server whose code changed mid-run is not a gate
result.

| Gate | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | **exit 0** |
| Lint | `npm run lint` | **exit 0** — 0 errors, **0 warnings** |
| Tests | `npx vitest run` | **80 files, 1034 passed, 1 skipped, 0 failed** — ×2, identical |
| The 1 skip | — | the opt-in live provider contract (`ODDS_LIVE_CONTRACT`) — **not counted as passing** |
| Browser | `npx playwright test` | **368 tests: 355 passed, 13 skipped, 0 failed, 0 flaky** — ×2, identical |
| The 13 skips | — | 6 measured-column checks, meaningless on a viewport narrower than the column; 7 responsive sweeps, which override the viewport themselves and so run once on the desktop project rather than twice |
| Accessibility | `npx playwright test e2e/accessibility.spec.ts` | **0 critical, 0 serious** across 25 pages in both projects; the advisory set is empty too. Keyboard focus and keyboard-trap tests pass |
| Responsive | `npx playwright test e2e/viewports.spec.ts` | **7 viewports × 13 pages**, all pass |
| Build | `npm run build` | **exit 0** |
| Secret scan | `node scripts/secret-scan.mjs` | clean — **491 files**, 15 rules |
| Whitespace | `git diff --check` | clean |
| Migrations | `node scripts/check-migrations.mjs` | **29 of 29** applied to a clean database, 62 tables |
| Control coverage | `npm run ci:controls` | **exit 0** — **165 declared: 152 browser, 9 blocked, 4 integration-boundary, 0 hidden**; every browser control has an audit row **in both projects**, and every exclusion carries one of seven accepted reason codes |
| Interaction audit | `node scripts/build-ui-review.mjs` | **352 rows**, **28 screenshots** — regenerated from the run, not hand-edited |
| Money invariants | `npm run ci:money` | **exit 0** — all **9** are zero: no unbalanced transaction, no negative wallet, no duplicate payout, no residual exposure, no abandoned outbox item |
| Documentation | `npm run ci:docs` | **clean** — 13 documents, **15 rules**. Every rule added across these passes was proved to fail on a controlled stale value and clean once corrected; rule 14 against the exact sentence this file carried, *"The last one was accepted with 201"*, and rule 15 caught two stale unit totals the moment it was switched on |
| Admin queries | `npm run admin:smoke` | **18 of 18** clean, exit 0 |
| Database roles | `npm run db:audit-roles` | **exit 0** — the runtime role owns nothing and cannot `DROP`, `ALTER` or `TRUNCATE` the ledger. **Local stack only**; see the limit below |
| Demo readiness | `npm run readiness:demo` | **exit 1**, correctly — **1 blocking item** (`NEXTAUTH_URL` points at localhost), §3 |
| Real-money readiness | `npm run readiness:real-money` | **exit 1**, correctly — **13 blocking items**, every one an owner, key, contract or regulatory matter, §3 |
| CI | GitHub Actions on `plutobet` | **checked against the Actions API for the exact commit on `plutobet/main`**, not assumed from a previous run. The result is recorded below this table. `origin` has no new run because nothing new was pushed to it |

### CI on `plutobet`, checked against the run rather than assumed

**The previous pass reported itself complete while its CI run was RED.** Commit
`56c4a11` was pushed, verified by reading the remote hash back, and reported as
finished. Its GitHub Actions run then failed, and nothing in the reporting
noticed, because "the push succeeded" had been treated as the end of the job.
Pushing is not the gate; the run is.

| | |
|---|---|
| What failed | **Secret scan**, step 8. Everything after it was skipped, and the "test totals" step then failed too because the suite it reads had never written a results file — one cause, two red steps |
| Why | A test fixture assigned a Paystack-shaped literal: `PAYSTACK_SECRET_KEY = "sk_test_…"`. The rule that flags that shape is `hardcoded-secret-assignment`, and it was right to |
| Was a real credential exposed | **No.** The value was invented for a fixture and matches nothing. What was committed is the *shape* of a credential assignment, which is the pattern somebody later edits when they want a test to hit the real API "just once" |

**The interesting half is why the LOCAL scan passed.** `secret-scan.mjs`
enumerated files with `git ls-files` — **tracked files only**. A brand-new file
is untracked until it is committed, so it was invisible to every local run right
up to the commit that made it permanent, and then visible to CI, where a fresh
checkout has everything tracked. The local run reported **491 files, clean**; the
same scan after the commit reported **496 files and the finding**. The gate was
reporting on a different set of files from the one being published, which is the
one thing a pre-commit gate must never do.

Both halves are fixed: the literal is assembled rather than written out, and the
scanner now also reads `git ls-files --others --exclude-standard`, so untracked
files are scanned while `.gitignore` is still honoured — `.env` and
`.env.review.local` hold real credentials and must stay out, or a finding would
print the path of the secret file into a public log.

**Verify the current run yourself rather than trusting this paragraph:**

```bash
gh api repos/plutobet-ai/plutobet_ai/actions/runs --jq \
  '.workflow_runs[0] | {head_sha, status, conclusion, head_branch}'
```

Expect `head_sha` to equal `git rev-parse HEAD` and `conclusion` to be
`success`. If it is not, this file is wrong and the run is right.

**Read the exit code, not the last line.** `npm run readiness:demo | tail -6`
reports the exit status of `tail`, which is always 0. Both readiness commands
above were re-run **unpiped** to obtain the exit codes quoted. The same mistake
with `Tee-Object` produced a false "VITEST EXIT: 0" earlier in this project's
history, and it is the reason the rule is written down rather than remembered.

**The browser suite is not in CI.** It needs the review stack — a local
PostgreSQL, a local Redis, a production build and `scripts/review-server.mjs` —
and CI runs none of them. `ci:controls` and `ci:money` are in the same position:
they read what a browser run produced. That is a real limit and it is stated
rather than implied; the CI job covers lint, typecheck, secret scan,
documentation consistency, migration validation, the unit suite and the build.

**Not re-run in this pass, and therefore not re-asserted**: `db:verify-restore`
and `bench:sync`. Their previous results stand where they are recorded (§21), but
a figure from an earlier run is not evidence about this tree and is not presented
as one.

**The limit on the role audit.** It proves the *runtime* role owns nothing, which
is the property that matters. The owner role in the local stack is the embedded
cluster's superuser, so it does **not** demonstrate that the production owner
role is correctly restricted. Runtime privilege stays unmarked until it is tested
with the real restricted credential — `BLOCKED_BY_OWNER_CONFIGURATION`.

Test count is **1,034**. The browser and
accessibility rows are the only gates here that open a browser, and they earn
their place: **nine** defects in this pass were invisible to every other gate —
an accessible name, a missing 404, a mobile overflow, an unreachable control, a
deleted page container, prose links marked by colour alone, secondary text
failing contrast, an orphan ARIA row, and a footer that stopped mid-screen. The
last of those was found by looking at a screenshot, which is not a gate at all.

---

## 5. The customer-facing interface

Status: **redesigned, verified in a real browser, and merged to `main` on
`plutobet`.** `origin/main` still carries the redesign alone and is held there
deliberately, because pushing it deploys — §0.

Evidence: **355 passing Playwright tests** across desktop 1440×900 and a Pixel 7
profile, **352 audited interactions** in `artifacts/ui-review/INTERACTION_AUDIT.md`, 28
screenshots on the contact sheet, a **7-viewport responsive sweep** covering
every size the owner named (390×844, 430×932, 768×1024, 1024×768, 1366×768,
1440×900, 1920×1080), and an **accessibility pass at 0 critical / 0 serious**
with keyboard focus and keyboard-trap tests passing.

**What is still not claimed**, and must not be lost in the good news: this is not
a screen-reader pass. axe is a static rule engine over the accessibility tree,
so a clean run means no rule fired — not that the product is usable with NVDA,
JAWS or VoiceOver. No assistive-technology walkthrough has been done.

### What changed and why

| Before | Now |
|---|---|
| Homepage opened with a marketing hero and a grid of product tiles, most linking to products that do not exist | **The homepage is the odds board.** Prices are in the first viewport |
| One dark palette everywhere, including the match list | **Dark chrome over a light, dense canvas** — the grammar every sportsbook uses, because a wall of white rows is what makes odds scannable |
| Sign-in was NextAuth's built-in unbranded page | A branded `/signin` with the same credentials provider underneath |
| Registration was one narrow column on a wide empty page | A balanced two-panel layout that collapses to one column on a phone |
| Navigation carried emoji icons and "arrives in phase 13" | Icons are drawn glyphs; no internal build-phase number is shown to a customer |
| The footer claimed "Nigeria · Licensed operator" | **Removed.** A licence claim is a regulatory assertion, not decoration |
| Seventeen products in one header row, overflowing below desktop | Two rows: destinations, then sports |
| Two controls per board row led to `/sports/event/<id>`, which did not exist | The event page exists, listing every open market |

### The shape of it

```
┌───────────────────────────────────────────────────────────────┐
│  header: brand · destinations · search · balance · deposit    │  dark
│  sub-header: sports                                           │  dark
├───────────┬───────────────────────────────────┬───────────────┤
│ league    │  date/filters                     │  betslip      │
│ rail      │  league-grouped match board       │  (sticky)     │
│ (sticky)  │  1 X 2 · O/U 2.5 · +N markets     │               │
└───────────┴───────────────────────────────────┴───────────────┘
   <1180px: the betslip becomes a bottom sheet
   <900px:  the rail collapses; a bottom bar appears
```

### Files

| Area | Files |
|---|---|
| Tokens and surfaces | `src/styles/tokens.css`, `src/styles/sportsbook.css`, `src/styles/surfaces.css` |
| Shell | `src/components/sportsbook/shell.tsx`, `header.tsx`, `footer.tsx`, `mobile-bar.tsx`, `page-shell.tsx` |
| Board | `board-page.tsx`, `match-board.tsx`, `odds-button.tsx`, `league-rail.tsx`, `date-strip.tsx` |
| Betslip | `betslip-store.tsx`, `betslip-panel.tsx`, `slip-math.ts`, `browser-store.ts` |
| Event page | `src/app/(site)/sports/event/[id]/page.tsx`, `event-markets.tsx` |
| Auth | `src/app/(site)/signin/`, `register/`, `forgot-password/` |

### What was deliberately NOT changed

Wallet accounting, the ledger, bet placement, settlement, locked odds,
exposure, provider ingestion, the database schema, payment logic, RBAC,
authentication validation, API response contracts, idempotency and the existing
security controls. This was a frontend pass. The one server-side addition is a
read-only query, `getEventView`, which the new event page needs and which
touches none of the above.

### The legacy bridge is gone

`src/styles/legacy-bridge.css` is **deleted**. It re-pointed the old design
system's variables at the new tokens so pages still carrying legacy classes
rendered in the new palette during the migration, and it had a stated end date:
delete it when no page inside `.sb` uses a legacy class. Seven files still did —
`kyc-form`, `responsible/controls`, `account/preferences`, `account/security`,
`account/verify-email`, `pluto-chat`, and one stray class in `results` — and all
seven were converted before it went.

The legacy rules further down `globals.css` **stay**. They serve the admin
console, which renders outside the `.sb` shell and keeps the dark system on
purpose. Re-skinning the screens that approve withdrawals is not a side effect
to accept from a customer-facing pass.

One thing came out with it that should not have. `.sb-page`, the measured column
every non-board page sits in, was defined in the bridge file rather than
alongside the rest of the layout, and deleting the file made every one of those
pages full-bleed. No gate caught it. The rules live in `surfaces.css` now, and
`e2e/pages.spec.ts` asserts the container directly — see §0. Layout the whole
site depends on does not belong in a file whose stated purpose is to be
deleted.

---

## 6. Complete interaction inventory

Every visible control on a customer-facing page, what it does, and its status.

**Read the status column carefully.** `VERIFIED_IN_REAL_BROWSER` means the
control appears in `artifacts/ui-review/INTERACTION_AUDIT.md` — it was clicked
or submitted in a real browser during the run that generated that file.
`IMPLEMENTED_NOT_LIVE_TESTED` means it is wired to real behaviour in the code
and was **not** exercised in a browser.

The distinction is not pedantry. Every one of these rows previously said
`IMPLEMENTED_NOT_LIVE_TESTED`, which the document defined as "a route that exists" — a
claim from reading the source that reads like a claim from using the product.
For most of the rows below, the destination page *is* browser-verified by the
Playwright suite even where the control itself was never clicked; that is worth
something, and it is not the same thing.

### This table is no longer the authority, and that is deliberate

**A hand-maintained inventory drifts.** This one did: it carried
`IMPLEMENTED_NOT_LIVE_TESTED` against controls that had been browser-tested for
two passes, and it could not have told anybody about a control that was never
tested at all, because a missing row looks like a table that is simply shorter.

Two generated artefacts replaced its job:

| Artefact | Answers |
|---|---|
| `artifacts/ui-review/INTERACTION_AUDIT.md` | **what the browser did** — every row is written by the run that did it |
| `e2e/control-manifest.mjs` | **what must be accounted for** — every control declared as browser-covered, blocked by a named dependency, or deferred to an integration boundary *with a reason* |

`scripts/check-control-coverage.mjs` compares them and **fails the build** when a
control declared browser-covered has no audit row, and separately when a
non-browser row carries no reason — because otherwise the cheapest way to pass
is to reclassify a control as blocked and move on.

The table below is kept as a readable description of the interface. **Where it
disagrees with the generated audit, the audit is right.**

### Header and global chrome

| Control | Does | Status |
|---|---|---|
| Brand mark | Navigates to `/` | `VERIFIED_IN_REAL_BROWSER` |
| Sports / Live / Jackpot / Promotions | Navigate to those pages | `VERIFIED_IN_REAL_BROWSER` — every destination followed, all answered under 400 |
| More ▾ | Opens a menu built from the navigation registry; entries not yet built are labelled "Not yet". Closes on outside click and on Escape | `VERIFIED_IN_REAL_BROWSER` — opened, closed with Escape, closed with an outside click |
| Pluto AI | Navigates to `/pluto` | `VERIFIED_IN_REAL_BROWSER` |
| Search | Expands in place; submitting navigates to `/sports?q=…`, which filters the board by team or competition. An empty query is a no-op rather than a pointless navigation | `VERIFIED_IN_REAL_BROWSER` |
| Balance | Navigates to `/wallet`; shows the server-resolved balance, or `—` if it could not be read | `VERIFIED_IN_REAL_BROWSER` |
| Deposit | Navigates to `/deposit` | `VERIFIED_IN_REAL_BROWSER` |
| Account icon | Navigates to `/account` | `VERIFIED_IN_REAL_BROWSER` |
| Sign in / Register | Navigate to `/signin`, `/register` | `VERIFIED_IN_REAL_BROWSER` |
| Sports tabs (second row) | Navigate to `/sports?sport=…` | `VERIFIED_IN_REAL_BROWSER` |
| Footer links | 13 links to real pages | `VERIFIED_IN_REAL_BROWSER` |
| Mobile bottom bar | Navigates; hidden above 900px by design | `VERIFIED_IN_REAL_BROWSER` |
| Branded 404 | Answers 404, carries the brand, and its actions lead back | `VERIFIED_IN_REAL_BROWSER` |

### League rail (desktop)

| Control | Does | Status |
|---|---|---|
| Competition search | Filters the rail as you type | `VERIFIED_IN_REAL_BROWSER` |
| Today / Upcoming / Live now | Navigate with the matching query | `VERIFIED_IN_REAL_BROWSER` |
| League link | Filters the board to that competition | `VERIFIED_IN_REAL_BROWSER` |
| Favourite star | Persists to `localStorage` and pins that competition to a "Your competitions" group at the top. Survives reload; syncs across tabs | `VERIFIED_IN_REAL_BROWSER` — starred, reloaded, and seen in a second tab |
| Country group | Expands and collapses | `VERIFIED_IN_REAL_BROWSER` |

### Match board

| Control | Does | Status |
|---|---|---|
| League header | Collapses and expands that league | `VERIFIED_IN_REAL_BROWSER` — `aria-expanded` toggles both ways |
| Fixture star | Persists to `localStorage` and pins the match to a "Your matches" group at the top of the board | `VERIFIED_IN_REAL_BROWSER` — starred, survived a reload, visible in a second tab |
| Odds tile (1 / X / 2 / O2.5 / U2.5) | Adds or removes the selection from the betslip. Disabled when suspended, closed or unavailable, and renders `—` rather than inventing a price | `VERIFIED_IN_REAL_BROWSER` |
| Statistics icon | Opens `/sports/event/<providerEventId>` | `VERIFIED_IN_REAL_BROWSER` — the route was created in this pass |
| "+N" more markets | Same destination | `VERIFIED_IN_REAL_BROWSER` — same |
| Filter chips (All upcoming / Today / Live / Jackpot / Clear) | Real links with real query parameters, so a filter can be bookmarked and shared | `VERIFIED_IN_REAL_BROWSER` — clicked, and the landed URL equals the chip's own href |
| Unavailable price | Rendered struck through and not pressable, never as a plausible number | `VERIFIED_IN_REAL_BROWSER` |

### Event page

| Control | Does | Status |
|---|---|---|
| Market header | Collapses and expands that market | `VERIFIED_IN_REAL_BROWSER` |
| Every selection tile | Adds to the betslip at the stored price | `VERIFIED_IN_REAL_BROWSER` |
| Back to competition | Returns to the filtered board | `VERIFIED_IN_REAL_BROWSER` |

### Betslip

| Control | Does | Status |
|---|---|---|
| Empty state | Says the slip is empty and how to add a selection | `VERIFIED_IN_REAL_BROWSER` |
| Betslip / My Bets tabs | Switch panes | `VERIFIED_IN_REAL_BROWSER` — both pressed, with a selection on the slip: each tab selects itself and deselects the other, My Bets replaces the stake field with a route to the full list, and returning keeps the selection and its count |
| Remove selection | Removes it | `VERIFIED_IN_REAL_BROWSER` — slip returned to its empty state |
| Stake field | Parsed to integer kobo; rejects anything that is not a plain naira amount | `VERIFIED_IN_REAL_BROWSER` — "12.345" refused in the page, "200" accepted; 11 unit tests behind it |
| Quick stakes (₦100/500/1,000/5,000) | Set the stake | `VERIFIED_IN_REAL_BROWSER` |
| Accumulator | Two selections across different fixtures; total odds multiply | `VERIFIED_IN_REAL_BROWSER` |
| Potential return | Derived from stake and price, and states that it includes the stake | `VERIFIED_IN_REAL_BROWSER` |
| Place bet → Confirm | `POST /api/bets` with a fresh idempotency key; disabled while in flight; a success is only claimed for a response carrying a real bet id | `VERIFIED_IN_REAL_BROWSER` — ₦200 placed, a real reference returned, CASH moved by exactly ₦200.00 |
| Insufficient funds | Refused in the page with a route to add funds; the button disables | `VERIFIED_IN_REAL_BROWSER` |
| Clear all | Empties the slip | `VERIFIED_IN_REAL_BROWSER` |
| Sign in to place bet | Shown instead of the submit when signed out | `VERIFIED_IN_REAL_BROWSER` |
| Odds-moved warning | Compares the price now against the price when added | `VERIFIED_BY_INTEGRATION_TEST` — needs the price to move between two moments a browser cannot separate |
| Open My Bets / View in My Bets | Navigate to `/bets` | `VERIFIED_IN_REAL_BROWSER` |
| Set a limit | Navigates to `/responsible` | `VERIFIED_IN_REAL_BROWSER` |

The slip persists in `sessionStorage` and is the single source of truth for
picks and stake — there is no second copy in component state to drift from it.

### Mobile bar and sheet (under 900px)

| Control | Does | Status |
|---|---|---|
| Home / Sports / Live / Account | Navigate | `VERIFIED_IN_REAL_BROWSER` |
| Betslip | Opens the bottom sheet; badge shows the selection count; Escape and the scrim close it; the page behind does not scroll | `VERIFIED_IN_REAL_BROWSER` — opened, Escape closed it, reopened, closed from the scrim control, and `overflow` on the body measured as locked while open |

### Authentication

| Control | Does | Status |
|---|---|---|
| Sign-in form | `signIn("credentials", { redirect: false })`, then routes to a validated same-site callback | `VERIFIED_IN_REAL_BROWSER` — correct and wrong passwords, and an httpOnly session cookie observed |
| Show / hide password | Toggles the field type | `VERIFIED_IN_REAL_BROWSER` |
| Forgot password | Navigates to `/forgot-password` | `VERIFIED_IN_REAL_BROWSER` |
| Sign out | Ends the session | `VERIFIED_IN_REAL_BROWSER` — a protected page no longer opens afterwards |
| Callback guard | Refuses a callback pointing off this site | `VERIFIED_IN_REAL_BROWSER` — 4 hostile forms, including protocol-relative and backslash |
| Register step 1 → Send code | `POST /api/auth/otp` | `VERIFIED_IN_REAL_BROWSER` — a code is issued and delivered to the review server's local mailbox, and **the response body carries no six-digit number and no `devCode` field**, which is asserted on the network rather than inferred from the screen. Termii delivery to a real handset stays `BLOCKED_BY_KEY` and is never claimed |
| Register step 2 → Create account | `POST /api/auth/register`, then signs in through the ordinary credentials flow | `VERIFIED_IN_REAL_BROWSER` — the whole two-step flow completed in a browser: fill, read the delivered code out of band, submit, land signed in, and `/api/wallet` answers 200. The duplicate-address refusal is asserted too |
| Change details | Returns to step 1 and clears the code | `VERIFIED_IN_REAL_BROWSER` — pressed with a code entered: step 1 comes back with the details intact and the code field empty, so a code cannot be carried onto a different number |
| Reset: send code | `POST /api/auth/password-reset` — always advances, so the page cannot be used to discover which addresses have accounts | `VERIFIED_IN_REAL_BROWSER` — a known and an unknown address now answer **identically**. They did not before; see finding 41. Delivery still needs Resend |
| Reset: set new password | `PUT /api/auth/password-reset` | `VERIFIED_IN_REAL_BROWSER` — completed on an isolated account: the code is read from the mailbox, the password is set, and then **both** passwords are tried at the sign-in form. The old one is refused and the new one signs in |
| Sign in with your new password | A link to `/signin`. **Fixed in an earlier pass**: it used to call `signIn` with no password, which can only fail | `VERIFIED_IN_REAL_BROWSER` — it is a link, and the sign-in form it points at is exercised |

### Account, wallet and money

| Control | Does | Status |
|---|---|---|
| Wallet: buckets and statement | Cash is the headline and is labelled "yours to withdraw"; bonus and locked appear separately when held, never folded in | `VERIFIED_IN_REAL_BROWSER` |
| Wallet: Deposit / Withdraw / My bets | Navigate | `VERIFIED_IN_REAL_BROWSER` |
| Deposit: account number panel | Displays the dedicated NUBAN. There is deliberately no amount field — the customer transfers what they like and the webhook attributes it | `BLOCKED_BY_KEY` — needs Paystack. **Asserted**: with no provider the page renders no ten-digit account number rather than a plausible one |
| Withdraw: minimum and over-balance | Named in the page, and the submit disabled, before anything is sent | `VERIFIED_IN_REAL_BROWSER` |
| Withdraw: bank field | A picker from the provider abstraction, falling back to a typed code only when the list cannot be fetched — and saying so | `VERIFIED_IN_REAL_BROWSER` for the field's behaviour; the payout leg stays `BLOCKED_BY_KEY` |
| Withdraw: daily cap and KYC restriction | Refused by tier | `VERIFIED_IN_REAL_BROWSER` on two isolated accounts. Tier 0 with ₦200,000 in it is refused outright. Tier 1 is refused above ₦50,000, accepted at ₦40,000, and then refused at a further ₦20,000 — proving the cap is a **rolling daily total**, not a per-request ceiling |
| Verify identity | Navigates to `/kyc`; states the tier and what it permits | `VERIFIED_IN_REAL_BROWSER` — **and asserted not to claim** an identity was checked against any registry, because none is connected |
| KYC upload | Writes to object storage | `VERIFIED_IN_REAL_BROWSER` against **disposable local storage**. The review server still blanks the B2 credentials (finding 31); what changed is that there is now a local backend for the bytes to land in. It is a backend swap and not a bypass — the content-type allow-list, the 10MB cap, the server-generated object key and the short-lived signed URL are the same code — and the admin's review link is fetched as issued (200) and again with one character of its signature changed (403) |
| Account: 9 manage tiles | Navigate to real pages | `VERIFIED_IN_REAL_BROWSER` — every link followed, all answered under 400 |
| Account: verify email | `POST /api/account/email-verify` | `BLOCKED_BY_KEY` — needs Resend |
| Security: change password | `POST /api/account/password` | `VERIFIED_IN_REAL_BROWSER`, both ways. A wrong current password is refused, and a **successful** change is driven on an isolated account: the device that made it keeps its session, and the new password signs in from a cleared browser context. Rotating the SHARED demo password would break every later sign-in, which is a reason to use a different account, not a reason not to test it |
| Security: sign out a device / all devices | `DELETE /api/account/sessions` — a revoked session is downgraded on its next request | `VERIFIED_IN_REAL_BROWSER` end to end. The same account is signed in from **two real browser contexts**; one revokes the other; the revoked context's next call to `/api/wallet` is refused while the revoking context still answers 200 |
| Preferences: odds format, notifications | `PUT /api/account/preferences` | `VERIFIED_IN_REAL_BROWSER` — both changed, saved, and still set after a reload |
| Safer gambling: deposit, stake and loss limits | `POST /api/responsible` — lowering applies immediately, raising waits 24 hours | `VERIFIED_IN_REAL_BROWSER` — all three set through the form and listed back |
| Safer gambling: delayed increase | The 24-hour wait | `VERIFIED_BY_INTEGRATION_TEST` — a browser cannot wait a day |
| Safer gambling: cool-off ("Take a break") | Pauses betting and deposits | `VERIFIED_IN_REAL_BROWSER`, **started for real** on an isolated funded account. It places a bet, takes a one-day break, and the next placement is refused — with the customer told a break is the reason, which is finding 46 asserted in a browser for the first time |
| Safer gambling: self-exclude | Closes the account, registered against the verified identity | `VERIFIED_IN_REAL_BROWSER`, **taken for real** on an isolated account with a verified identity on file. It cannot sign in again; a session cookie held from BEFORE the exclusion cannot place a bet; and the same identity number submitted on a brand-new account is refused. Finding 55 came out of it: the control did not actually sign the customer out |
| Referrals: copy link / share | Clipboard, and the Web Share sheet where the browser has one | `VERIFIED_IN_REAL_BROWSER` |
| Rewards: see promotions | Navigates | `VERIFIED_IN_REAL_BROWSER` |
| Date of birth: completion page and underage refusal | Write-once; underage is 403 and the date is not echoed back | `VERIFIED_IN_REAL_BROWSER` |

### Controls that are deliberately inert, and say so

| Control | Why | Status |
|---|---|---|
| Live board prices | Shown for information. In-play placement needs a real in-play feed; a tappable price the server would refuse is worse than none | `BLOCKED_BY_CONTRACT` |
| Casino game cards | **No longer links.** They pointed at `/casino/play/<id>`, which does not exist; the only configured provider is the development sandbox, whose own launch URL returns an explainer rather than a game. The page now says the games cannot be opened | `BLOCKED_BY_CONTRACT` |
| Fantasy / Live Casino / Lucky Numbers | An honest unavailable page with routes to what does work | `NOT_IMPLEMENTED` — and each states **its own** reason, not a borrowed one |

**Cash out is no longer in this table.** It is not inert: it prices, it is
accepted, and the money moves — in a browser. See §15 and the audit rows quoted
in §0.

### Dead controls found and closed in this pass

| Was | Now |
|---|---|
| `/sports/event/<id>` — two links per board row, both 404 | The page exists and lists every open market |
| Header search linked to `/sports?focus=search`, which nothing read | A real search that filters the board |
| League and fixture stars toggled a colour and forgot it | Persist and pin |
| "Sign in" after a password reset called `signIn` with no password | A link to the sign-in form |
| Casino tiles linked to a launch route that does not exist | Non-linking cards with an explanation |
| The More menu labelled Results and Livescore "Soon" although both work | Labels come from the registry's real status |
| Referral link printed as text | Copy and share buttons |

---

## 7. Design system

Tokens live in `src/styles/tokens.css` and nothing outside that file names a
colour. Names are semantic (`--sb-odds-bg`) rather than descriptive
(`--green-500`): a descriptive name says what it looks like, a semantic one says
when to use it, which is the question a component author actually has.

| Group | Notes |
|---|---|
| Brand | `#00c968` with a stronger `#00a957` for text and small elements; `--sb-brand-ink` is the only colour placed on top of it and meets AA against both |
| Chrome | Five dark values for the header, footer, balance panel and menus |
| Canvas | Off-white page, white surfaces, two greys, two border weights |
| Status | Live, warn, danger, up, down — every one paired with a word in the interface, so meaning survives greyscale and colour blindness |
| Odds tile | Its own group, because a price has nine states and they must be reviewable side by side |
| Spacing | A 4px/8px rhythm, ten steps |
| Type | Six sizes. Six is enough for a sportsbook and removes the argument about 13px versus 13.5px |
| Controls | Four heights, of which `--sb-h-touch: 44px` is a floor, not a suggestion |
| Focus | One ring, defined twice — for the light canvas and the dark chrome |
| Motion | Reduced to zero under `prefers-reduced-motion`; nothing carries meaning through motion alone |

The odds tile is written as plain CSS against `data-state` rather than as
utility classes, because expressing nine states as class strings inside JSX
makes them impossible to review together.

---

## 8. Accessibility and mobile

| Concern | How it is handled |
|---|---|
| Touch targets | 44px minimum, set through a token rather than left to whatever an icon measures |
| Odds tiles | `aria-pressed` for selection; the accessible name carries label, price and state, because "2.10" alone tells a screen-reader user nothing |
| Unavailable prices | Rendered as `—` and disabled, never as a plausible number |
| Collapsible groups | `aria-expanded` plus `aria-controls` on every league and market header |
| Betslip sheet | `role="dialog"`, `aria-modal`, Escape to close, background scroll locked |
| Forms | Every field has a real `<label>`; errors use `role="alert"` and `aria-describedby`; invalid fields carry `aria-invalid` |
| Inputs on iOS | 16px font on every text input, or Safari zooms the page on focus |
| Colour | Never the only signal — every status pill carries its own word |
| Motion | `prefers-reduced-motion` zeroes the durations and stops the live pulse and skeleton shimmer |
| Safe areas | The mobile bar and betslip sheet respect `env(safe-area-inset-bottom)` |
| Wide content | Tables and boards scroll inside their own container; the page body never scrolls sideways |

Breakpoints: 1180px drops the betslip to a sheet, 900px collapses the rail and
raises the bottom bar, 720px hides the Over/Under columns, 600px and 480px tune
padding and figure sizes, 440px stacks paired form fields.

### What has actually been measured

**Status: `VERIFIED_IN_REAL_BROWSER`, 2026-09-04.** The table above used to be
the whole of this section, and every row in it was a statement about intent read
off the source. It is now backed by a run.

| Check | Result |
|---|---|
| axe-core across **25 pages**, desktop 1440×900 and a Pixel 7 profile | **0 critical, 0 serious** — and the advisory (moderate/minor) set is empty too |
| Rule set | `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` |
| Keyboard: visible focus | Every control reached by tabbing carries a focus indicator — outline, box-shadow or `:focus-visible` |
| Keyboard: no trap | 60 tab presses reach far more than a handful of distinct controls |
| Responsive sweep | **7 viewports × 13 pages** — 390×844, 430×932, 768×1024, 1024×768, 1366×768, 1440×900, 1920×1080 — each page answers, logs nothing, and does not scroll sideways |

`e2e/accessibility.spec.ts` and `e2e/viewports.spec.ts`.

**It took five defects to get there**, and the row above claiming "Colour —
never the only signal" was among the things that turned out not to be true:
every prose link in the product, including the two safer-gambling routes, was
marked by colour alone. Findings 33, 34, 35 and 38.

**What this does not prove.** axe is a static rule engine over the accessibility
tree; a clean run means no rule fired. It is not a screen-reader pass, and none
has been done — see "Deliberately not performed" in §0.

---

## 9. Authentication and account

| Item | Status |
|---|---|
| Registration over HTTP, age gate, duplicate refusal | `VERIFIED_BY_INTEGRATION_TEST` |
| Password hashing (argon2id) | `VERIFIED_BY_INTEGRATION_TEST` |
| Sign-in through the credentials provider | `VERIFIED_BY_INTEGRATION_TEST` |
| Branded sign-in page | `VERIFIED_BY_INTEGRATION_TEST` — presentation only; `authOptions.pages.signIn` points at it, and `authorize()` is unchanged |
| Same-site redirect guard | `VERIFIED_BY_INTEGRATION_TEST` — 7 tests; rejects another origin, protocol-relative, backslash, non-rooted and control-character callbacks |
| Session revocation ("sign out my other device") | `VERIFIED_BY_INTEGRATION_TEST` |
| Re-read of role and status on every request | `VERIFIED_BY_INTEGRATION_TEST` — suspension takes effect on the next request, not at token expiry |
| Phone verification delivery | `BLOCKED_BY_KEY` — Termii |
| Email verification delivery | `BLOCKED_BY_KEY` — Resend |

The sign-in page shows one failure message for a wrong password, an unknown
address, a suspended account and a self-excluded one, because `authorize()`
returns the same `null` for all four. A more helpful message would re-introduce
the account-enumeration oracle the server was careful to remove.

---

## 10. The money core

| Property | Status |
|---|---|
| Integer kobo (`BIGINT`) end to end, no float in any money path | `VERIFIED_BY_INTEGRATION_TEST` |
| Double-entry, append-only ledger; deferred triggers reject unbalanced, empty, malformed or cache-divergent commits | `VERIFIED_BY_INTEGRATION_TEST` |
| Three wallet rows per account (CASH / BONUS / LOCKED) as rows, not columns, so every trigger covers them unchanged | `VERIFIED_BY_INTEGRATION_TEST` |
| Row locks (`SELECT … FOR UPDATE`); transfers lock both wallets in UUID order | `VERIFIED_BY_INTEGRATION_TEST` — 100-way hammer |
| Idempotency with SHA-256 request fingerprints — a replayed key with different parameters raises a typed conflict | `VERIFIED_BY_INTEGRATION_TEST` |
| Bonus credit cannot be withdrawn — refused by a database trigger, not a service check | `VERIFIED_BY_INTEGRATION_TEST` |
| Corrections are compensating entries, never edits | `VERIFIED_BY_INTEGRATION_TEST` |
| Money formatting, including negatives | `VERIFIED_BY_INTEGRATION_TEST` — 24 tests |

**Any new query against `wallets` must name a bucket.** Six queries once
resolved "the user's wallet" by `(user_id, kind, currency)`, matched all three
rows and took whichever the planner returned first — the ledger stayed
balanced and the money landed where the customer could not spend it.

---

## 11. Deposits and withdrawals

| Item | Status |
|---|---|
| Paystack adapter, webhook signature validation (HMAC-SHA512 over the raw body, constant-time) | `VERIFIED_BY_INTEGRATION_TEST` on fixtures |
| Deposit idempotency | `VERIFIED_BY_INTEGRATION_TEST` |
| Withdrawal balance reservation, KYC caps, manual approval | `VERIFIED_BY_INTEGRATION_TEST` in tests |
| A real deposit | `BLOCKED_BY_KEY` |
| A real payout | `BLOCKED_BY_KEY` |

**Not one byte has ever been exchanged with Paystack.** The adapter is written
against published documentation and exercised only by fixtures.

**The bank list is built.** This section previously said the form still asked for
a hand-typed numeric code and recorded it as outstanding; that stopped being true
in stage 5f and the sentence survived the change.

`PaymentProvider.listBanks()` sits on the provider interface so no part of the
codebase keeps a bank list of its own; the Paystack adapter follows `next_page`
rather than taking the first hundred and calling it the list; `BankListService`
caches with a 12-hour freshness and a 7-day stale window and **says when it is
serving a stale list**; `GET /api/payments/banks` is authenticated; and
`POST /api/withdrawals` validates the submitted code **before taking a hold**,
because a form is a suggestion and the request is what arrives. The form is a
real picker with loading, stale and failed states, falling back to a typed code
only when the list cannot be fetched — and saying why.

Twelve tests cover the caching, validation and failure behaviour.
**Communication with the real provider remains `BLOCKED_BY_KEY`**, and the
development adapter deliberately returns two banks named "NOT REAL" so a sandbox
can never be mistaken for the real list.

### The account name was chosen by the browser — findings 59, 60 and 61

**`VERIFIED_IN_REAL_BROWSER`, reproduced against the running server before
anything was changed.**

`POST /api/withdrawals` took `accountName` from the request body and passed it
to the transfer. A probe posted `"ATTACKER SUPPLIED NAME"` and was answered
**201**. The account number and bank code decide where money lands, so nothing
was misdirected by it — and that is exactly why it survived: the field looked
cosmetic. It is not. It is the only signal that would tell a customer they had
typed a stranger's account, and it was the name that would appear on the payout
record and on the Paystack transfer recipient.

| # | What was wrong | What it is now |
|---|---|---|
| **59** | The withdrawal route trusted the browser's `accountName` | The route **re-resolves against the provider** and stores the provider's answer. The body now carries `confirmedAccountName`, which exists **only to be compared** — a screen that went stale between confirming and submitting is refused `409 ACCOUNT_NAME_CHANGED` rather than paid |
| **60** | The form asked the customer to **type** the name | There is no name input. The bank's answer is shown read-only, cleared the instant the number or bank changes, and confirmed by an explicit tick before the submit enables |
| **61** | On the review server the bank list **could not be fetched at all** | `[payments] bank list unavailable` was in the log on every load and the picker was empty. The production-build refusal was throwing for a read-only call. See the read-only seam below |

**The stale-response problem, and why a counter rather than a debounce.** Two
resolutions can be in flight when somebody corrects a digit, and they can return
in either order. Without protection the SLOWER answer for the OLD number wins,
and the customer confirms a name belonging to an account they are no longer
paying. Every request takes a sequence number and every response checks it is
still the newest before it writes anything.

**Clearing happens in the edit handler, not in an effect.** The effect version
worked and `react-hooks` refused it — setting state synchronously in an effect
body causes a cascading render — and the rule is right for a better reason than
performance: deriving the clear from a dependency array leaves a one-render
window where the old name sits beside the new number, which is the exact window
this exists to close.

### The read-only provider seam, and the line it does not cross

`createPaymentProvider()` refuses to return the sandbox in production, because
the sandbox verifies no webhook signature and running it on a real deployment
would let anyone who found the webhook URL credit themselves. **That refusal
still stands and nothing here relaxes it.**

But the review server IS a production build — deliberately — so that refusal
threw for every bank-list fetch and would have thrown for every resolution. The
observed symptoms were an empty picker and a **500 from a money form because no
key was configured**.

`paymentProviderForReads()` opens the seam for exactly two calls that cannot be
abused by opening it: `listBanks`, which returns two banks named NOT REAL, and
`resolveBankAccount`, which returns a name saying NOT REAL and NOT VERIFIED and
carries `sandbox: true` so no caller has to read the string. **`parseWebhook`
and `initiateTransfer` still go through `paymentProvider()` and still refuse** —
and `security.spec.ts`'s webhook-signature probe passing is what proves that,
not the paragraph above.

---

## 12. Betting: pricing, placement, exposure

| Item | Status |
|---|---|
| Odds ingestion and `1x2` | `VERIFIED_BY_INTEGRATION_TEST` — 333 open selections on upcoming fixtures |
| Provider response parsing | `VERIFIED_BY_INTEGRATION_TEST` — pinned against real captured payloads, plus an opt-in live check |
| Bet placement over HTTP | `VERIFIED_BY_INTEGRATION_TEST` — 15 tests including concurrent placement repeated 5× |
| Stake debited at placement, not at settlement | `VERIFIED_BY_INTEGRATION_TEST` |
| Odds locked at placement | `VERIFIED_BY_INTEGRATION_TEST` — settlement reads `bet_legs.locked_odds_decimal`, never the current price |
| Exposure claimed per market at placement | `VERIFIED_BY_INTEGRATION_TEST` |
| Idempotent replay releases exactly what that attempt claimed | `VERIFIED_BY_INTEGRATION_TEST` — see §22 for the rows the pre-fix behaviour left behind |
| Singles, accumulators, system bets, bankers, booking codes | `VERIFIED_BY_INTEGRATION_TEST` |
| Bet builder (correlated legs) | `NOT_IMPLEMENTED` — also needs a pricing provider |
| Edit bet | `NOT_IMPLEMENTED` |

---

## 13. Settlement

The chain, and what makes each part reliable:

```
pollMatchResults (cron * * * * *)
  └─ ingest the provider result, and in the SAME transaction
     write a settlement_outbox row                       ← closes the dual write
dispatchSettlementOutbox (cron * * * * *)
  └─ claim due items FOR UPDATE SKIP LOCKED
  └─ send settlement/event.finished, id = key + attempt   ← so a retry delivers
settleEvent
  └─ settleBet ×N   (idempotent, moves money)
  └─ close the event's markets
recoverStrandedSettlements (cron */2 * * * *)
  └─ level-triggered sweep: any PENDING bet on an event with a final result
```

| Item | Status |
|---|---|
| Win / loss / void / partial settlement, idempotency | `VERIFIED_BY_INTEGRATION_TEST` |
| Automatic settlement scheduling | `VERIFIED_BY_INTEGRATION_TEST` — 9 tests through the registered function |
| Unattended result ingestion | `VERIFIED_BY_INTEGRATION_TEST` — observed, §14 |
| Unattended bet settlement | `VERIFIED_BY_INTEGRATION_TEST` — observed, §14 |
| Transactional outbox, dispatcher, recovery sweep | `VERIFIED_BY_INTEGRATION_TEST` — 19 acceptance tests |
| Per-stage heartbeats and stall alerts | `VERIFIED_BY_INTEGRATION_TEST` — recorded a real failure with its cause on the first live run |
| Result-poll fairness and backoff | `VERIFIED_BY_INTEGRATION_TEST` — money waiting sorts first; an unscorable event is deferred, never resolved |

Three design points worth keeping in mind before changing any of this:

1. **Inngest invokes a handler once per step.** Code inside `step.run` is
   memoised; code outside it re-executes on every invocation. A cadence claim
   placed outside a step made the entire dispatch unreachable for every event,
   always.
2. **The recovery sweep is level-triggered on purpose.** It asks "is any
   PENDING bet sitting on a finished event", not "did a message get lost". That
   is why it recovered a bet no edge-triggered retry could have.
3. **A dispatch id must include the attempt.** Inngest deduplicates by event id,
   so a stable id meant every re-dispatch was silently dropped and the retry
   path had never once delivered.

---

## 14. The real bet that proved the pipeline

| | |
|---|---|
| Bet | `d7d34d58-507a-4bb0-95e0-338d1626d706` |
| Fixture | Fortaleza FC v CD Once Caldas — Colombia, Liga DIMAYOR Finalizacion |
| Selection | away @ 2.150 |
| Stake / gross return | ₦200.00 / ₦430.00 |
| Result | 1–2 — the away side won |

Registered, funded and placed entirely through the public HTTP routes.
Registration refused an underage date of birth (403) and a duplicate email
(409); placement refused an over-balance stake (409), a zero stake (422) and
stale odds (409), and a duplicate submit returned the same bet id rather than a
second bet.

The match finished, the scheduler ingested the real result on its own — and the
bet then sat `PENDING` for fourteen hours because the hand-off to settlement
was unreachable. After the repair it was recovered **by the pipeline, with no
human in the loop**:

```
13:56:48  SETTLEMENT_RECOVERY_ENQUEUED  1 pending bet on an event with a final result
13:56:49  outbox DISPATCHED             source=RECOVERY, attempts=1
13:56:56  ledger PAYOUT CREDIT 43000
13:56:58  outbox COMPLETED
```

| Evidence | Result |
|---|---|
| Bet status | **WON**, `settled_at` populated |
| Payout | **exactly one** transaction, ₦430.00 |
| CASH balance | ₦0 → ₦430.00 |
| Markets | all 5 `SETTLED`, 0 of 68 selections open |
| Ledger | ₦2,035.00 debits = ₦2,035.00 credits, 0 negative wallets |
| Remaining recovery candidates | **0** |
| Same sweep, wider effect | 21 stranded events recovered, 0 failures |
| Stability | still `WON` with exactly one payout after 433 dispatcher and 228 recovery runs |

---

## 15. Cash-out: repaired, reachable, and tested

Status: **`VERIFIED_BY_INTEGRATION_TEST`**, and one step of the end-to-end
journey (§0, stage 7) takes a cash-out through the real HTTP route.

### What this section used to say, and why it was wrong

It said cash-out was "well constructed" and deliberately unreachable pending one
known exposure defect. The first half was wrong. **Partial cash-out had never
worked at all.**

Migration `0007` added a CHECK constraint requiring `cashout_value_minor IS
NULL` unless the bet was `CASHED_OUT`. Migration `0016` then added partial
cash-out, which by definition leaves a bet `PENDING` *with* a value. Every
partial call therefore died on Postgres error 23514 — and nothing noticed,
because there was no route, no UI and no test that took a partial. A feature can
be described as well constructed for as long as nobody calls it.

That is recorded here rather than quietly corrected, because "it looks correct"
was written into a status document about money and stood.

### What is true now

| Invariant | State |
|---|---|
| Partial cash-out completes at all | **Holds.** Migration `0027` replaces the constraint |
| Full cash-out releases exposure exactly once | **Holds.** The bet becomes `CASHED_OUT` and never reaches settlement |
| Partial cash-out releases exposure exactly once | **Holds.** `released_liability_minor` records what was released; settlement releases only the remainder. Previously the partial released a slice and settlement released the whole claim again, over-releasing the market's liability — floored at zero by `GREATEST`, so it read as no exposure while other bets carried real risk |
| Settlement pays only the stake still at risk after a partial | **Holds** |
| The service refuses a suspended, self-excluded or closed account | **Holds.** `assertMayCashOut` gates on status before pricing |
| A retried take pays once | **Holds.** The money key is derived from the bet, not supplied by the client, and a replay returns the original figure |
| A quote discloses nothing to a stranger | **Holds.** Ownership is checked before pricing, because what a bet is worth also reveals that it exists |

**It is reachable.** `GET`/`POST /api/bets/[id]/cashout`, an in-ticket control
on `/bets` that prices on demand and sends the figure it showed, and admin
visibility. 35 tests across three files, plus the journey.

**A deliberate difference, recorded so it is not "fixed":** cash-out refuses a
`SELF_EXCLUDED` customer; withdrawal permits one. Cash-out is a wagering
decision and nothing is trapped — the bet still settles and still pays.
Withdrawal is how a self-excluded customer gets their money out, and refusing it
would trap them.

### Finding 56 — the confirmation was destroyed by the refresh that caused it

`VERIFIED_IN_REAL_BROWSER`, fixed. Found by **reading the component while
investigating a journey failure that turned out to have a different cause**
(finding 57). Saying the journey "caught it" would be the convenient version and
it is not what happened: the journey never got far enough to judge.

`bets/page.tsx` rendered the cash-out panel only while `bet.status ===
"PENDING"`. On a successful take, the panel set its own state to show **"Cashed
out for the amount paid"** and then called `router.refresh()` — which re-rendered
the ticket as `CASHED_OUT` and **unmounted the component mid-sentence**. The only
plain statement of what the customer had just been paid lived for exactly one
server round-trip and was then removed by the very refresh that proved it had
worked.

Three things about this are worth keeping:

- **It is invisible on a partial.** A partial leaves the bet `PENDING`, so the
  panel stays mounted and its message persists. The dedicated partial spec
  passed throughout, and would have gone on passing.
- **A `role="status"` node destroyed before a screen reader reaches it has
  announced nothing at all.** The durable state — the "Cashed out" pill and the
  "Returned" column — is something to infer from, not a statement, and a
  customer using a screen reader got neither.
- **The proof is that the text now survives a cold load.** A fresh `GET /bets`
  with no cash-out in flight renders it on every settled ticket. Before the fix
  the only source of that sentence was a client component's state, so a reload
  could never have shown it — which is the same as saying the customer's record
  of what they were paid did not exist anywhere they could return to.

Fixed in the product rather than in the test: the ticket now renders that
confirmation from **the server's own view of the bet**, so it survives the
refresh, a reload, a second device and a week later. The wording is identical to
the panel's, because a customer should not have to notice that two parts of the
page are telling them the same thing. The transient message stays for the
partial case, where the panel is still the only thing that can say it.

### Finding 57 — the diagnostic written to explain failures was the failure

`FAILED` → fixed. A test defect, not a product one, and the reason the customer
journey could not pass at all.

The cash-out step reads the page's warning note so that a failure says *which*
of three causes it was — a refused cash-out, an intercepted click or a network
fault look identical otherwise. It did that with:

```
await page.locator(".sb-note--warn").first().textContent().catch(() => null)
```

**On a successful cash-out there is no warning note.** `textContent()` auto-waits
for its element; this project sets no `actionTimeout`, so the default of 0 means
"wait as long as the test has". Every SUCCESSFUL run therefore stopped here
until the 180-second budget expired. The `.catch()` then swallowed the timeout
long after it could matter, and the confirmation assertion — still pending, never
evaluated — was reported as `Received: undefined`.

So the failure message named the confirmation, and the confirmation was fine.
Three things made it hard to read, and all three are worth remembering:

- **It could never have passed.** This was not a flake to be re-run. The
  successful path was the blocking path.
- **`--timeout` from the command line did nothing**, because `test.setTimeout(180_000)`
  inside the test overrides it. That made "it is just slow" look disproved when
  it had not been tested.
- **The error context is captured at teardown, not at the assertion.** Its
  snapshot showed the confirmation present, which is true — by then. Trusting it
  as the state at failure time sent the first hour of the investigation at a
  locator that was never wrong.

Fixed by counting before reading: `count()` resolves against the DOM as it is
now, which is the question actually being asked, and the read that follows is
bounded. The journey went from a 180-second timeout to **15.3 seconds, passing**.
It is the only unbounded `textContent()` in the suite — checked, not assumed.

---

## 16. Responsible gambling, KYC and compliance

| Control | Status |
|---|---|
| Age gate — refused at registration and again by a database trigger | `VERIFIED_BY_INTEGRATION_TEST` |
| Date-of-birth backfill for accounts predating the gate | `VERIFIED_BY_INTEGRATION_TEST` — a write-once flow at `/account/date-of-birth`, a non-dismissible banner naming what is blocked, and gates inside placement and withdrawal. The column is still nullable, so enforcement is not yet structural; §0 stage 5d records the `NOT NULL` migration procedure that closes it |
| Deposit, loss and stake limits — lowering immediate, raising delayed 24 hours | `VERIFIED_BY_INTEGRATION_TEST` |
| Self-exclusion, surviving re-registration via an identity digest under a server-held pepper | `VERIFIED_BY_INTEGRATION_TEST` |
| Unverified accounts cannot withdraw (tier 0 → ₦0 daily cap) | `VERIFIED_BY_INTEGRATION_TEST` |
| KYC document upload and review | `VERIFIED_BY_INTEGRATION_TEST` |
| **BVN/NIN verification against a registry** | **`NOT_IMPLEMENTED`.** A digest is stored; it is never checked against anything. "KYC tier" is an internal authorisation model — it decides what a tier may do, not whether anybody is who they say they are |
| Bank-account **resolution** — asking the bank who owns an account | **Implemented.** `PaymentProvider.resolveBankAccount`, an authenticated rate-limited route, a read-only name in the form, and a server-side re-resolve that overwrites whatever the browser sent. `VERIFIED_BY_INTEGRATION_TEST` on fixtures and `VERIFIED_IN_REAL_BROWSER` against the sandbox adapter. **Resolution against the real Paystack endpoint is `BLOCKED_BY_KEY`** and is never claimed |
| Bank-account name **matching** — deciding whether that name is the customer's | **`BLOCKED_BY_PRODUCT_DECISION`.** The name is now fetched and stored; what nobody has decided is how close it must be to the account holder's own name before a payout is allowed. Initials, middle names, married names, transliteration and ordering are all ordinary in Nigerian records, and every one of them is a policy question with a false-reject cost on one side and a fraud cost on the other. The withdrawal route compares the provider's answer against what the customer CONFIRMED — exact after collapsing case and whitespace, and nothing more — which is a staleness check, not identity matching, and is deliberately not presented as one |
| Gaming licence | `BLOCKED_BY_REGULATION` |
| Independent RNG / platform certification | `BLOCKED_BY_REGULATION` |

The footer no longer claims a licence. Taking real money from Nigerian
customers without one is a legal exposure that no amount of test coverage
addresses.

---

## 17. Admin console

18 screens, RBAC with 8 roles and 31 permissions, step-up re-authentication held
server-side in Redis and failing closed, and an audit trail with a
database-enforced reason.

Status: **`VERIFIED_IN_REAL_BROWSER`** as of 2026-09-05, `e2e/admin.spec.ts`.

`npm run admin:smoke` proves every admin QUERY runs — 18 of 18 — and that was
the whole of the evidence until now. It cannot prove a person can operate the
console: a page whose query succeeds and whose markup throws renders a blank
screen and a green smoke test. So the browser opens them.

| Checked in a browser | Result |
|---|---|
| All 18 admin screens | every one answered under 400 with **no console error, no uncaught exception and no failed request** |
| Dashboard, user search, bets, ledger, reconciliation, audit log, KYC queue, withdrawal queue | each renders its own content, not an empty shell or a permission refusal |
| A newly placed bet | visible to the administrator, matching the customer's own view — the journey places it and the admin context sees it |
| Signed-out access by URL | redirected to sign-in; no admin chrome rendered |
| An ordinary customer by URL | refused; never reaches `/admin` |
| **A SUPPORT_AGENT at `/admin/roles`** | refused — while a SUPER_ADMIN is allowed, so the test proves a *separation* and not merely a broken page |
| **A SUPPORT_AGENT posting a SUPER_ADMIN grant** | refused at the route, using its own session cookie. Hidden navigation is a courtesy; this is the control |

To make that last pair meaningful the demo seed now creates a **second
administrator holding only SUPPORT_AGENT**, and issues both sets of powers the
way the application issues them — `bootstrapSuperAdmin` for the first super
admin, which refuses the moment one exists, then the real `RbacService.grant`,
which demands a super-admin actor, refuses self-granting, requires a reason and
writes the audit row. Granting by hand would have tested a fiction.

**What is still not claimed.** No withdrawal was approved, no exposure adjusted
and no bet settled from the browser. Those move money, and a browser suite that
moves money on a schedule is a worse idea than the coverage it buys — their
refusal paths are asserted here, their success paths in the acceptance tests.
And **no human has used the console against production traffic.**

**The admin console was not part of the interface redesign.** It renders
outside the `.sb` shell and keeps the dark system deliberately: it is an
internal tool, and re-skinning it here would have been an unreviewed change to
screens that approve withdrawals.

---

## 18. Background jobs and scheduling

13 Inngest functions register with a running scheduler. Cadence is claimed
through an atomic `SET NX` with a TTL, so two instances cannot both run one job.

`job_heartbeats` records every run — including the ones that find nothing,
because "ran and found nothing" and "did not run" are otherwise
indistinguishable and only one of them needs somebody woken up. The alert
distinguishes "no successful poll in N minutes" from "never succeeded on this
deployment"; the second is the one that catches a job nobody ever started.

Error messages written to that table are scrubbed of URLs, hostnames and IP
addresses before storage, so an improved error message cannot start publishing
the database endpoint.

Local development needs the scheduler explicitly enabled: `INNGEST_DEV=1`, via
`npm run dev:local`. Without it the SDK chooses cloud mode whenever signing keys
are present, registers zero functions, and no cron fires — which once looked
exactly like a working setup.

---

## 19. Database, migrations and roles

| Item | Value |
|---|---|
| Engine | PostgreSQL (Neon serverless) |
| Migrations | **29**, all applied to a clean database, 62 tables — read from `drizzle/meta/_journal.json`, which `scripts/check-docs.mjs` now compares every stated total against |
| Pooled connection | `DATABASE_URL` — ordinary reads through Neon's pooler, `prepare: false` |
| Unpooled connection | `DIRECT_DATABASE_URL` — money paths only, because row locks and `SET LOCAL ROLE` are session-scoped and unsafe through a transaction pooler |
| Owner connection | `MIGRATION_DATABASE_URL` — migrations only |
| Pool sizing | 10 pooled / 5 direct, configurable, refusing rather than clamping an out-of-range value. Was `max: 1`, which serialised the entire application on Railway's single persistent container |

`SET LOCAL ROLE app_role` is issued inside every money transaction. What that
role can and cannot do is pinned by 12 tests that attempt real DDL through the
real runtime client: PostgreSQL refuses `DROP`, `ALTER`, `TRUNCATE`, `DELETE`,
disabling the balance trigger, replacing the trigger function and creating
tables in `public`. It keeps **column-level** UPDATE on `wallets` — it can write
the balance and version columns and cannot write `user_id` or `kind`, so it
cannot move a balance between people.

---

## 20. Security posture and known exposure

### The most serious open finding

**Read this as two environments, because the answer differs between them and an
earlier version of this section reported only one.**

`npm run db:audit-roles` is read-only and reports whatever URLs it is given.

**Against the local disposable stack (measured 2026-09-04, exit 0):**

```
runtime pooled / money direct   bet_app
superuser                       no
owns ledger tables              no
can DROP / ALTER / TRUNCATE     no
can CREATE in public            no
can grant itself more           no
VERDICT: the runtime connection has no ownership of the ledger
```

That is the design working. It is **not** evidence about production.

**Against the production configuration**, the runtime URL still resolves to an
owner-privileged role:

```
session_user / current_user / current_role   neondb_owner
superuser                                    no
bypasses RLS                                 YES
owns ledger tables                           YES (ledger_entries, ledger_transactions, wallets)
can DROP / ALTER / TRUNCATE ledger           YES
can grant itself more                        YES
```

**This has not been re-measured in this pass and must not be presented as
though it had.** No production credential was used for anything here. The
finding stands from the earlier audit that recorded it, and it stays open until
somebody runs the audit with the real restricted credential —
`BLOCKED_BY_OWNER_CONFIGURATION`.

The money paths are safe — they set the restricted role per transaction. **The
pooled READ client does no role handling at all**, and thirty-four files import
it: every board query, every admin page, every public route. A compromised read
path inherits owner rights over the ledger.

`SET ROLE` on the pooled connection is not a reliable fix: that URL goes through
a transaction-mode pooler where a session-level role does not dependably survive
to the next transaction. The fix is a separate least-privilege credential for
`DATABASE_URL`; the exact SQL is in `OWNER_LAUNCH_CHECKLIST.md` §13.
`production:check` **fails** on this rather than noting it beside a passing
check, which is how a privilege problem survives a review.

### Everything else

| Control | Status |
|---|---|
| Passwords — argon2id | `VERIFIED_BY_INTEGRATION_TEST` |
| Sessions — httpOnly, sameSite, secure; revocation honoured on the next request | `VERIFIED_BY_INTEGRATION_TEST` |
| Input validation — Zod at every boundary | `VERIFIED_BY_INTEGRATION_TEST` |
| Webhook verification — HMAC over the raw body, constant-time | `VERIFIED_BY_INTEGRATION_TEST` |
| Rate limiting and OTP storage | `VERIFIED_BY_INTEGRATION_TEST` locally; needs Redis in the deployment |
| Open-redirect guard on sign-in | `VERIFIED_BY_INTEGRATION_TEST` — §9 |
| Secret scanning in CI | `VERIFIED_BY_INTEGRATION_TEST` — 15 rules |
| `IDENTITY_PEPPER` rotation | **NOT DONE.** Possible only while every account is a test account; permanently impossible afterwards |
| **`INTERNAL_SECURITY_VERIFICATION`** | **Done 2026-09-05**, `e2e/security.spec.ts` and `e2e/security-extended.spec.ts` — see below |
| Dependency vulnerability audit | **Done.** `npm audit --omit=dev`: **0 vulnerabilities**. Full tree: 4 moderate, all dev-only — see below |
| Rotation of credentials pasted into a chat during setup | **NOT DONE** — Neon, Upstash, Backblaze, Inngest, odds-api.io |
| Managed secret storage | `NOT_IMPLEMENTED` — `.env` is gitignored, and that is all |
| Prompt-injection corpus for the AI surfaces | **Complete.** 53 attacks and 59 tests; `prompt-injection.acceptance.spec.ts` runs the corpus against the real guardrail layer. A row here said `NOT_IMPLEMENTED` for a pass after it was finished, which is the contradiction `ci:docs` rule 12 now refuses |
| Independent penetration testing | `NOT_IMPLEMENTED` — external work, and the internal pass below does **not** discharge it |

### `INTERNAL_SECURITY_VERIFICATION`, 2026-09-05

Twenty-six probes across two files. The first twelve are below; the fourteen
added in the second pass, covering every attack class the brief named, are in
"The rest of the matrix" further down.

**What it is not.** Not a penetration test. Nobody creative sat down with this
system and tried to break it; a list of known attack shapes was fired at it
through the real HTTP surface and the answers were recorded. That catches
regressions in controls the team already knows about and finds nothing nobody
thought of, which is the entire value of the human exercise. An independent test
stays outstanding.

`e2e/security.spec.ts`, 12 probes, against the disposable local stack. **All
pass**, and one of them found a real defect on its first run.

| Probe | Result |
|---|---|
| Authentication bypass | 7 protected routes called with no session — all 4xx |
| Error-message identifier leakage | a forced placement refusal carries no UUID and no exposure figure |
| Cross-user object access | a foreign bet id is refused, and the refusal does not disclose whether it exists |
| Open redirect | 4 hostile `callbackUrl` forms, including protocol-relative and backslash — all stayed on this origin |
| Webhook signature | unsigned and wrongly signed credit payloads both refused |
| Idempotency conflict | one key, two different amounts — the second did not take effect |
| Injection | SQL, script and traversal payloads in the search box: no 5xx, no script executed |
| Secrets in the client bundle | 5 credential shapes searched across every same-origin script — none present |
| Rate limiting | 80 requests from one forwarded address: shed by refusing, **0 server errors** |
| Test-only routes | 8 QA, seed and debug paths probed — all 404 |
| Age-gate bypass | an underage date posted to an account that already holds one: refused, and not echoed back |
| AI money actions | 3 "do it without confirming" instructions — none reported an action performed |

**The defect it found is finding 41**, and it is the kind only a probe finds:
the password-reset endpoint answered **500 for an address with an account and
200 for one without**, in exactly the configuration this is deployed in. Its own
comment says it must answer identically. Reading the route would not have shown
it, because the difference came from an error thrown two modules away.

### The rest of the matrix, added in the second pass

`e2e/security-extended.spec.ts`. Every one is a refusal being asserted; nothing
here asserts that a vulnerability was exploited, and nothing runs anywhere but
loopback.

| Attack class | What was fired, and what came back |
|---|---|
| CSRF on state-changing routes | The session cookie's own flags read from the browser (httpOnly, SameSite ≠ None); a credentials callback posted from a foreign Origin with no CSRF token, which returned no session material; and a withdrawal posted **three hostile ways** — foreign `Origin`, `Sec-Fetch-Site: cross-site`, and a hostile `Referer` with the Origin stripped. **All three answered 403**, the balance was unchanged and every money invariant stayed zero. Findings 51, 59 and 60 |
| Session fixation | The session cookie read before authenticating, after authenticating, and after a second sign-in from a cleared context. A fresh token every time; no pre-authentication value survives the privilege change |
| Admin step-up bypass | A valid payout approval posted by a SUPER_ADMIN with a live session and no step-up: **401 `REAUTH_REQUIRED`**. The proof is held server-side and is never read from the request, so nothing in the body could satisfy it |
| Stored XSS | `<img src=x onerror=…>` written to the profile through its real route, then four pages that render it loaded: no script ran |
| Reflected XSS | The same payload in three echoed query strings: no script ran, and no element was created from it — React renders it as text |
| File-upload MIME spoofing | An HTML payload named `passport.png` with a `text/html` content type: refused by the allow-list, not by the filename |
| File size limit | An 11MB image against a 10MB cap: refused server-side, not by the form |
| Malicious filenames and path traversal | Five names containing `../`, backslash traversal, percent-encoded traversal and SQL: **accepted and then ignored**, which is the stronger property — every one produced a server-generated key of the form `kyc/<user-uuid>/<kind>-<32 hex>.<ext>`, with the supplied name nowhere in it |
| SSRF-shaped input | Five internal targets (link-local metadata, loopback Postgres and Redis, `file://`, `gopher://`) through a query string and a profile field: all answered promptly and below 500. Nothing in this product takes a URL from a customer and fetches it, and this confirms that rather than assuming it |
| Mass assignment | `kycLevel`, `role` and `status` posted to the profile route; `userId` and `driftPolicy` to placement; `effectiveFrom` to the limits route. None caused a server error, the account did not become an administrator, and a client-supplied `driftPolicy` did **not** place a bet at a price the account never agreed to — the policy is read from stored preferences on the server |
| Rate-limit bypass with spoofed headers | 90 requests, each with a different forged `x-forwarded-for` and `x-real-ip`: no server errors. **Recorded honestly**: the budget IS per-forwarded-address, so rotating the header does reset it behind a proxy that does not overwrite it. That is why the deployment sits behind one that does |
| Webhook replay | The identical `charge.success` body twice with a wrong signature: both answered the same status, so the response does not reveal whether the reference had been seen. Replay of a genuinely SIGNED webhook needs the provider secret and stays `BLOCKED_BY_KEY` |
| Withdrawal idempotency conflict | One key reused with a different amount: the second was refused |
| Cash-out idempotency conflict | The same bet cashed out twice under two DIFFERENT client keys: refused, or replayed the same payment. The money key is derived from the BET, so a client varying its own key cannot buy one back twice |
| Cross-user cash-out access | Another customer's quote and take: both refused |
| Cross-user KYC access | The KYC routes and the admin queue as an ordinary customer: refused, and no other user's id returned |
| Cross-user session access | One customer revoking another's session by id: refused, and the victim's session still worked afterwards |
| Unsafe error-detail leakage | Refusals checked for wallet ids, user ids and the book's remaining appetite on a market: none present |
| Production startup with QA routes | All five real `/api/qa/*` paths probed as a signed-in customer, with **both** GET and POST, then again with a wrong key: **404 every time**. Answering 404 rather than 403 means a customer cannot tell the surface is there. **Finding 52 came out of this**: Next answered 405 for an unimplemented verb, which distinguished a real path from an absent one |
| Production startup with local delivery/storage adapters | `review-adapters.acceptance.spec.ts` and `qa-surface.acceptance.spec.ts` falsify **each of the four conditions on its own** — the environment name, the second switch, eleven hosting-platform markers, and nine live provider credentials. Testing them together would pass for the wrong reason the moment one broke |
| Production startup with sandbox providers | `ephemeral-guard.acceptance.spec.ts`, at construction, which is where the decision is made |
| Responsible-gambling bypass | A cool-off and a self-exclusion taken for real on isolated accounts, then wagering attempted — including from a session cookie held from BEFORE the exclusion. Refused, and the customer is told which limit stopped them |
| Missing-DOB betting and withdrawal bypass | An account with no date of birth: bet refused, withdrawal refused, the board shows the banner, and a date ten years ago is refused when supplied |
| AI confirmation bypass | Five instructions claiming blanket permission, including one impersonating a system message. None claimed an action was performed and the balance did not move. The guardrail sits ABOVE the tool table, so a tool added later cannot forget it. **No language model is connected**: this exercises the keyword router and the guardrails and is not evidence about a model's behaviour |
| Admin AI permission boundary | Four administrative requests to the assistant while signed in as a SUPER_ADMIN: no other customer's address returned, no administrative action claimed. **Scaffolding.** There is no Admin AI product and this does not imply one |

**What this still is not.** Nobody creative sat down with this system and tried
to break it. A list of known shapes was fired at it and the answers were
recorded, which catches regressions in controls the team already knows about and
finds nothing nobody thought of. **An independent penetration test remains
outstanding external work** and none of the above discharges it.

### Dependency audit

| Scope | Result |
|---|---|
| `npm audit --omit=dev` (what ships) | **0 vulnerabilities** |
| Full tree including dev | **4 moderate**, one root cause |

| Package | Severity | Path | Exploitability here | Why it is not fixed |
|---|---|---|---|---|
| `esbuild` ≤ 0.24.2 | moderate | `drizzle-kit` → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` → `esbuild` | **None in this project.** The advisory is that esbuild's **development server** lets any website send it requests and read the response. This repository never runs that server; `drizzle-kit` is a dev dependency used by `db:generate` to emit SQL | The only offered fix is `drizzle-kit@0.18.1` — a **downgrade** and a breaking change, against a config written for 0.31. No fixed version exists in the 0.x line. Recorded rather than forced, per the instruction not to apply unsafe upgrades |
---

## 21. Performance

Fixture-sync classification, measured before and after on the same dataset,
process and database (`npm run bench:sync`). Both runs completed; no terminated
measurement is quoted.

| Events | Before | After | Speedup | Statements | Transactions |
|---|---|---|---|---|---|
| 200 | 3,815–4,235 ms | 84–86 ms | **45–49×** | 4,000 → 24 (167×) | 400 → 2 |
| 775 | 12,832–15,505 ms | 1,457–2,193 ms | **7.1–8.8×** | 15,500 → 96 (162×) | 1,550 → 8 |

Ranges rather than single figures, because two runs of the same benchmark on the
same machine differ by that much under load — which is exactly why the tests
assert statement counts and not milliseconds. The statement reduction was
identical across runs. Target was 3×.

The benchmark boots its own throwaway cluster and refuses to run against a
non-ephemeral database, after an earlier version wrote through the shared client
(§22).

**Now load-tested**, in stage 6 above: the board, `/api/live` polling at scale,
the market list, odds, and Pluto concurrency —
`scripts/bench-http.mjs`, report at `artifacts/load/HTTP_LOAD.md`. Zero failures
and zero 5xx, and the rate limiter measured shedding load correctly rather than
falling over.

Still not load-tested: **casino callbacks**, because there is no callback route
in the repository to load — the casino is a sandbox adapter with no aggregator
connected. And the Pluto figure covers the route, guardrails and dispatch, not
model latency, which does not exist yet.

---

## 22. Known contamination and pending destructive operations

The two items below need owner approval. **Neither has been run.** A third
entry records a connection to production that this pass made by accident and is
disclosed rather than omitted.

### Finding 58 — a readiness check read the production database, and nothing said so

**Disclosed, not discovered later.** During the final gate sweep,
`npm run readiness:demo` and `npm run readiness:real-money` were run from a
shell that had exported `DATABASE_URL`, `DIRECT_DATABASE_URL` and `REDIS_URL`
but **not** `MIGRATION_DATABASE_URL`. `scripts/production-check.ts` resolves that
name first for its migration count, and `dotenv` fills anything the shell has
not set from `.env` — which holds the production connection string.

| | |
|---|---|
| What was executed | **One read-only statement**, `SELECT count(*) FROM drizzle.__drizzle_migrations` |
| What was written | **Nothing.** No INSERT, UPDATE, DELETE, DDL or migration. The code path has no write in it |
| What it returned | a count of 27, which was then displayed beside numbers measured locally |
| Customer data | **Not read.** The statement touches the migration journal only |
| How it was caught | the readiness output said "27 applied but 29 exist on disk" while `check-migrations` had just reported **29 of 29** against a clean local database. Two numbers that could not both be about the same database |

**Why it is written down rather than quietly fixed.** The instruction for this
pass was explicit that no test may connect to production Neon. This did, once,
read-only, and the honest record of that is worth more than a clean-looking
document. It also demolishes a comfortable assumption: every *other* safeguard
in this repository worked — the review server blanks credentials, the money
gate refuses a non-loopback host, the reset script refuses any database but the
disposable one — and this still happened, because `production-check.ts` is the
one script whose **job** is to look at production and therefore has no loopback
guard to trip.

**What changed.** The check now names the database it counted: `29 of 29 applied
on this machine`, or `… on remote host <name>` when it is not local. A hostname
is not a credential and nothing else from the URL is ever printed. The script
was deliberately **not** given a loopback refusal — checking a remote deployment
is what it is for — so the fix is disclosure, which is the control that was
actually missing. Re-run with the local URL supplied, it reports **29 of 29 on
this machine**, demo **NOT READY on 1 blocking item**, real-money **NOT READY on
13**, both exit 1.

**A reading whose subject is ambiguous is not evidence about anything**, and for
the hour before this was noticed, one line of the gate table was evidence about
the wrong machine.

### 400 synthetic fixtures in the production database

Written by an earlier version of the benchmark when it still used the shared
pooled client. They carry a `bench-<timestamp>` provider tag, have no bets
against them (verified), and would appear on the customer-facing board as real
matches.

```bash
npm run db:clean-benchmark              # reports, changes nothing
npm run db:clean-benchmark -- --confirm # deletes
```

It refuses outright if any bet references them — that would be a data-integrity
problem, and deleting the evidence would be the wrong response.

**They must not appear in review screenshots.** The screenshots in this pass
were taken against a local disposable database seeded with `npm run db:seed-demo`
(five clearly-named demo fixtures), never against the database holding these.

### ₦630 of residual exposure across two markets

| Market | Fixture | Residual |
|---|---|---|
| `701daa4f-8b00-4d36-bf97-5ef236a3e52a` | Dinthar FC v Saikhamakawn FC `1x2` | ₦400.00 |
| `822cfe03-f701-4251-86e4-3a3e7842baed` | Fortaleza FC v CD Once Caldas `1x2` | ₦230.00 |

Left by the duplicate-submit defect described in §12, which is fixed. **No money
is involved** — exposure is a risk ceiling, not a balance. The ledger nets to
zero, every affected bet has exactly one payout, and both markets are already
`SETTLED`.

```bash
npm run db:repair-exposure                                   # dry run, prints a fingerprint
npm run db:repair-exposure -- --expect=<fingerprint> --confirm
```

The confirmed run refuses without the fingerprint from a dry run, and refuses
again if the data changed since — approving a repair you have read and applying
one you have not are different acts.

---

## 23. Blocked work, by what blocks it

### Blocked by owner configuration

| Item | Detail |
|---|---|
| `NEXTAUTH_URL` | Points at localhost, so sign-in callbacks send real users to their own machine. The documented example domain returns "Application not found"; the correct value is not knowable from here |
| Runtime database role | §20 |
| Railway database and Redis | Recorded as unattached by an earlier pass. **Not re-checked here** — Railway is not visible from this repository, and the owner should confirm rather than trust this row |
| Restore drill | No Neon API key. Runbook and a tested verifier are in `docs/restore-runbook.md` |
| `SENTRY_DSN` | Unset — no production error visibility |
| First administrator | `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, then `npm run db:seed-admin` |

### Blocked by a key

Paystack deposits and payouts · Termii SMS · Resend email · an LLM key for
Pluto AI, which is a keyword router today and needs an adapter — not "swap a
key".

The prompt-injection and concurrency work is **no longer waiting on the key**.
The adversarial corpus exists and runs (stage 5i: 53 attacks, 59 tests), and
Pluto concurrency is measured (stage 6). What still needs a key is replaying
that corpus **through a live model**, which is the only thing that can establish
how a model answers these prompts. Until then that specific claim, and nothing
else about this layer, stays `BLOCKED_BY_KEY`.

### Blocked by a contract

Casino aggregator · Live Casino · virtuals provider · in-play feed ·
correlated-leg pricing for a bet builder · a KYC identity provider.

### Blocked by regulation

A gaming licence, and independent certification.

### Blocked by nothing — the developer backlog

**Empty.** Every task that was in this table has been completed, and each is
listed below with where its evidence lives. Nothing developer-owned is waiting
on a decision that a developer is entitled to make.

*This section is enforced by `scripts/check-docs.mjs`, which fails the build if
an item recorded as finished reappears here — the exact drift that let this
table go on listing eight completed tasks.*

| Was listed here | Where its evidence is now |
|---|---|
| Cash-out exposure defect | §15 — repaired by migration `0027`, `released_liability_minor` records what was released so a double release is a loud error |
| Account-status gate on cash-out | §15 — `assertMayCashOut` gates inside the service boundary, not only in the UI |
| Bank list for withdrawals | §0 stage 5f — `PaymentProvider.listBanks()`, an authenticated route, a real picker, 12 tests. Provider *communication* stays `BLOCKED_BY_KEY` |
| Date-of-birth backfill | §0 stage 5d — write-once flow, non-dismissible banner, gates inside placement and withdrawal, 12 tests |
| Redis caching of `liveVersion` | §0 stage 5e — 2-second TTL as the correctness bound plus explicit invalidation, 8 tests, and load evidence at 0.8 transactions per poll |
| Load tests for the homepage and `/api/live` | §0 stage 6 — measured, `artifacts/load/HTTP_LOAD.md`. Casino callbacks remain unmeasured because **there is no callback route to load** |
| Prompt-injection corpus | §0 stage 5i — 53 attacks, 59 tests, three defects found. Replaying it through a live model stays `BLOCKED_BY_KEY` |
| Retire the legacy bridge | §5 — `src/styles/legacy-bridge.css` is deleted, and a repository-wide search confirms zero legacy `var(--…)` references in any `.tsx` file |

**The items that used to sit here alongside those are not developer work**, and
listing them as though a developer were simply behind on them was the error.
They are classified by what actually blocks them in "Owner decisions required"
below, and in the blocked sections above: edit bet, personalisation and Admin AI
need rules nobody has written; Fantasy needs product rules; Lucky Numbers needs
rules, a certified RNG and regulatory approval.

### Owner decisions required

**These are questions, not tasks.** Each names what a developer cannot decide,
because deciding it would mean writing the financial or responsible-gambling
policy of a money feature. A recommendation is offered where one is safe; **none
of it is implemented, and none should be until it is approved.**

| Feature | Blocked by | The exact questions | A safe default, if you want one |
|---|---|---|---|
| **Edit bet** | `BLOCKED_BY_PRODUCT_DECISION` | **Eligibility** — which bets, and until when: any time before kick-off, or a fixed window after placement? **Fees** — free, flat, or a percentage? **Odds-change consent** — a rebooked bet is priced again; does the customer confirm the new price, and what happens if it moved against them between the two screens? **Promotional stakes** — a bonus-funded bet edited into a different one is a wagering-requirement question, not a betting one | Cancel-and-rebook as an immutable replacement: the original stays auditable, the replacement gets its own id, the two are linked, and the customer must accept the new price explicitly. Refuse it outright on bonus-funded bets until the wagering rule is written |
| **Personalisation** | `BLOCKED_BY_PRODUCT_DECISION` | **What is surfaced** — a fixture, a market, or a *stake size*? A recommended stake is a different product and a different regulatory object from a recommended fixture. **On what signal** — betting history is the obvious one and also the signal that most reliably identifies somebody losing. **When it is suppressed** — under a deposit limit, in cool-off, showing loss-chasing, or flagged by the risk console. **Is it marketing?** `user_preferences.marketing_emails` already records a consent this would have to respect, and Nigerian advertising rules bear on the answer | Fixtures and markets only, never stakes; suppressed entirely for any account under a limit, in cool-off, self-excluded or risk-flagged; and treated as marketing for consent purposes until a regulator says otherwise |
| **Admin AI** | `BLOCKED_BY_KEY` **and** `BLOCKED_BY_PRODUCT_DECISION` | **Which admin actions may an assistant take at all?** The console approves withdrawals, adjusts exposure and settles bets. **What is draft-only versus executable?** **Whose authority does it act under**, and how is that recorded in the audit trail? | Read-only to begin with: it may summarise and locate, and may draft nothing that moves money. Give it its own tool registry and permission model before a line of it is written |
| **Fantasy** | `BLOCKED_BY_PRODUCT_DECISION` — **not** a provider | **Scoring rules. Contest formats. Entry fees and whether they are real money. Prize calculation and ties. Squad and transfer rules.** Nothing about this needs a third party; it needs a specification. The page currently says so, in its own words, rather than borrowing "we need a provider" from the casino | None. Do not guess the rules of a money game |
| **Lucky Numbers** | `BLOCKED_BY_PRODUCT_DECISION`, `BLOCKED_BY_CONTRACT` **and** `BLOCKED_BY_REGULATION` | **Draw mechanics and frequency. Prize tiers and odds. A certified RNG** — self-rolled randomness is not acceptable for a real-money draw. **Which licence covers a lottery-style product**, which is often not the one that covers sports betting | None. This is the one product where building it before the approvals exist is the expensive mistake |

---

## 24. What the owner should do next, in order

1. **Find out why a Vercel project is deploying this product at all.** You
   deploy on **Railway**, so the thirty `vercel[bot]` Production deployments on
   `Madubuezejoshua/plutobet` are an integration nobody is maintaining. The most
   recent built `299d4b9`. **If it is not wanted, disconnect it** — Vercel
   dashboard → the project → Settings → Git → Disconnect, or delete the project
   outright. That stops any further push from publishing this product.
2. **Before removing it, find out which database it has been pointing at.** If
   that Vercel deployment has been serving against the production database, a
   public URL has been reachable against real data for as long as it has
   existed. Vercel dashboard → the project → Settings → Environment Variables.
   §0 carries the read-only commands.
3. **Confirm what Railway is actually running**, which this repository cannot
   see. In particular whether it is deploying from `Madubuezejoshua/plutobet` or
   from `plutobet-ai/plutobet_ai`, because `main` now differs between them: the
   gap-closure work is on `plutobet` and `origin/main` is still `299d4b9`.
4. **Rotate `IDENTITY_PEPPER`** — possible only while every account is a test
   account, permanently impossible after the first real customer.
5. Rotate Neon, Upstash, Backblaze, Inngest, then odds-api.io.
6. Give the deployment a database, Redis, and a real `NEXTAUTH_URL`.
7. Create the least-privilege runtime database credential (§20). **This is the
   one open item the developer cannot close** — the code, the SQL and the
   readiness check all require it; only the credential is missing.
8. Run `npm run production:check -- --remote=<url>` until it exits 0.
9. Seed the first administrator.
10. Approve the synthetic-fixture cleanup and the exposure repair (§22).
11. Perform the restore drill and record the numbers.
12. **Create a Resend account and buy Termii credits.** Until then **nobody can
    register and nobody can reset a password** — and note that with no email
    provider the reset endpoint now answers a uniform 503 rather than leaking
    which addresses have accounts (finding 41).
13. Obtain Paystack approval and live keys; prove one small real deposit and one
    small real payout.
14. Contract a KYC identity provider.
15. Commission an **independent penetration test**. The internal verification in
    §20 is automated and does not substitute for it.
16. Resolve licensing before taking money from anybody.

---

## 25. Document map

| Document | Role |
|---|---|
| **`general.md`** | **This file. The single source of truth.** |
| `OWNER_LAUNCH_CHECKLIST.md` | Step-by-step owner actions, including the two approval blocks in §22 |
| `NEXT_WORK_REPORT.md` | The running log of what each pass did |
| `UI_REDESIGN_REPORT.md` | The detail of the interface redesign |
| `docs/deployment.md` | How to deploy and what each variable is for |
| `docs/restore-runbook.md` | How to restore, and what to check afterwards |
| `docs/settlement-operations.md` | Running the settlement pipeline |
| `docs/security-review.md` | The security review |
| `docs/who-does-what.md` | Division of responsibility |
| `docs/FSGRN-technical-topography.md` | Regulatory topography |

### Consolidated into this file

Five status documents each answered "what is the state of PlutoBet" as of a
different day, and disagreed with each other. They were read in full and their
still-true content is above. They are kept in `docs/history/` because the trail
from a defect to its fix is worth reading, and because deleting evidence to tidy
a directory is the wrong instinct on a money system.

| Was | Now | What it uniquely recorded |
|---|---|---|
| `docs/history/PROJECT_STATUS.md` | `docs/history/PROJECT_STATUS.md` | The money-path repair, in full |
| `docs/history/PLUTOBET_STATUS.md` | `docs/history/PLUTOBET_STATUS.md` | The 2026-08-27 phase table and the Railway 500 |
| `docs/history/PLUTOBET_CORE_FLOW_VALIDATION.md` | `docs/history/PLUTOBET_CORE_FLOW_VALIDATION.md` | The core-flow validation and its six bugs |
| `docs/history/DEVELOPER_COMPLETION_REPORT.md` | `docs/history/DEVELOPER_COMPLETION_REPORT.md` | The money-formatter and poll-fairness pass |
| `docs/history/GPT.md` | `docs/history/GPT.md` | The cold-read engineering audit, and its section on how documentation drifted optimistic |

---

## 26. Changelog

Dated, newest first. One entry per completed pass. A pass appears here only
after its gates have run; "what was attempted" belongs in `NEXT_WORK_REPORT.md`.

### 2026-09-06 — ask the bank whose account it is, and stop trusting the browser

**A focused correction pass, on `main`, published to `plutobet` only.**

**The account name was chosen by the browser.** `POST /api/withdrawals` took
`accountName` from the request body and passed it to the transfer recipient. A
probe posted `"ATTACKER SUPPLIED NAME"` and was answered **201**. The number and
the bank code decide where money lands, so nothing was misdirected — which is
precisely why it survived, because the field looked cosmetic. It is the only
signal that would tell a customer they had typed a stranger's account, and it
was the name that would appear on the payout record.

`PaymentProvider.resolveBankAccount` now sits on the contract, the Paystack
adapter calls the documented `/bank/resolve` with the secret key server-side
only, an authenticated rate-limited route fronts it, and **the withdrawal route
re-resolves and stores the provider's answer**. The body carries
`confirmedAccountName`, which exists only to be compared: a screen that went
stale between confirming and submitting is refused `409` rather than paid.
Findings 59, 60 and 61.

**The CSRF report was stale in one direction and wrong in two others.** The
brief asked for the reported `Origin: https://evil.example.com` acceptance to be
reproduced first, and it was — it answered **403**, already fixed. The same
probe then found two shapes nobody had reported, both answered **201**:
`Sec-Fetch-Site: cross-site`, which is the browser itself stating the request
came from somebody else's page and which page script cannot forge; and a hostile
`Referer` with the Origin stripped, because Referer was not read at all. The
guard now refuses cross-site fetch metadata outright and falls back to Referer,
and it was applied to `publicRoute` as well — `/api/ai` and `/api/bookings` read
the session cookie and had no origin check whatever, and `/api/ai` dispatches
tools.

**A third defect nobody had reported.** On the review server the bank list could
not be fetched at all: the production-build refusal was throwing for a read-only
call, the log said `bank list unavailable` on every load, and the picker was
empty. Withdrawals only kept working because `isPayableBankCode` deliberately
fails open — so the tier-1 cap test was passing while posting a bank code the
server could not validate. `paymentProviderForReads()` opens the seam for
`listBanks` and `resolveBankAccount` only; `parseWebhook` and `initiateTransfer`
still refuse, and the webhook-signature probe passing is what proves it.

**Two more checker rules, each proved against the sentence that motivated it.**
Rule 14 refuses a security result that records an attack as accepted without
saying it was fixed — proved against *"The last one was accepted with 201 —
finding 51"*, which had stood inside a passing security matrix for a whole pass.
Rule 15 requires the unit-suite totals to agree with each other, and caught two
stale `989`s the moment it was switched on, including one I had just written
myself while explaining the earlier ones.

**Gates, twice, on a freshly recreated disposable database:** tsc 0 · eslint
0/0 · secret-scan clean · `ci:docs` clean on 15 rules · migrations 29 of 29 ·
vitest **80 files, 1,034 passed, 1 skipped, 0 failed** · playwright **368 tests:
355 passed, 13 skipped, 0 failed, 0 flaky** · 165 controls declared with 152
browser-covered and an audit row in both projects · all 9 money invariants zero
· admin smoke 18 of 18 · build exit 0.

### 2026-09-05 — make the documents check themselves, then press every control

**A gap-closure pass on `finish/developer-verification-and-truth`, published to
`plutobet-ai/plutobet_ai` and deliberately NOT to `origin`.** The two remotes
are not equivalent: `origin` runs a Vercel integration that deploys on every
push and has five deployments to show for it, while `plutobet` has never created
one. The branch was held back until the owner chose, and the owner chose the
remote that does not deploy. `remote.pushDefault` now points there. **`main` was
not touched on either remote.**

**The documents now check themselves.** `scripts/check-docs.mjs`, seven rules, in
CI, **proved to fail** on an injected wrong migration total. It found forty
things; twenty were false positives in the checker itself and were fixed there
rather than silenced, because a checker with false positives is one people learn
to skim past. The twenty real ones included §19 understating the migration count
by two, §0 and §3 disagreeing about readiness blockers, §20 presenting
every runtime connection as owner-privileged when the local one is restricted,
§11 still telling customers to type a bank code, a backlog of eight *finished*
tasks, and a second document declaring itself the source of truth.

**The controls are now declared, not just recorded.** The generated audit says
what the browser did and can say nothing about a control nobody wrote a test
for. `e2e/control-manifest.mjs` declares what must be accounted for — browser,
blocked by a named dependency, or deferred to an integration boundary **with a
reason** — and `scripts/check-control-coverage.mjs` fails on a gap and on a
reasonless exclusion.

**Four new browser specs**: the board and betslip, the account and wallet, the
admin console, and a customer journey that crosses real browser, HTTP and cookie
boundaries. **Cash-out is now taken in a browser**, not only priced: quoted
₦190.00, accepted through the authenticated route, balance up by exactly that,
ticket updated.

**`INTERNAL_SECURITY_VERIFICATION`**, 12 probes — and it earned its place on the
first run. The **password-reset endpoint was an account-enumeration oracle**:
500 for an address with an account, 200 for one without, in exactly the
configuration this is deployed in. Its own comment says it must answer
identically; the difference came from an error thrown two modules away. Finding
41.

**And the seed had been hiding something.** `player@demo.local` was created with
no date of birth — the legacy state stage 5d closed — so every placement was
refused and **the browser suite had never once placed a bet**. Nothing said so,
because a correct refusal is indistinguishable from a passing test when nothing
asserts the success. Finding 40.

Dependency audit: **0 vulnerabilities in what ships**; 4 moderate dev-only from
`esbuild` via `drizzle-kit`, recorded with exploitability rather than forced
through a downgrade.

### 2026-09-04 — the accessibility pass, and a review server that phoned home

**Stages 3, 9, 10 and 11 completed.** The redesign branch was merged into `main`
by **fast-forward** at `84aab07` and pushed to **both** remotes, which carry
identical commits and trees. **CI passed on both repositories at the time** for
every commit pushed to `main` in that pass. The remotes have since diverged on
purpose; §0 carries the current state.

The push was blocked for part of this pass — the machine had no GitHub
credential — and the merge was deliberately withheld rather than performed
locally against a branch that could not be published. The owner authenticated on
2026-09-05 and the sequence completed. **One consequence nobody asked for: a
Vercel production deployment fires on every push to `main`, and it fired. See
§0.**

**Security.** The review server generated its own auth secrets and pinned every
database URL to loopback, then inherited every other credential from `.env`: the
live odds key, the production Inngest queue, production Redis, and the **B2 KYC
document bucket**. The interaction suite uploads a KYC document, so review runs
were writing test files into the production store of customers' identity
documents. All are blanked, and `/api/health` was used to prove it: the odds key
read `set` before and `missing` after. Separately, the script's loopback check
examined only the four variable names it set, while the application reads three
higher-precedence aliases first — so one addition to `.env` would have opened the
money path against production with the safety check still passing. Findings 31
and 32.

**Accessibility, first time measured.** axe across 25 pages in two browser
profiles, at a critical/serious bar, plus keyboard focus and keyboard-trap tests.
Four site-wide defects: prose links marked by colour alone (including both
safer-gambling routes), secondary text tokens chosen against white but used on
the canvas, a suspended price rendered at 1.9:1, an orphan `role="row"` on
`/live`, and two labels on `/account/preferences` left at the legacy dark
theme's near-white — roughly 1.1:1, unreadable. That last one also proved stage
5h's "all seven files converted" claim wrong: it had audited classes and never
looked inside inline `style` props. Findings 33 to 35 and 38.

**Responsive.** The 7-viewport sweep was written in an earlier session and had
never been run. It runs and passes.

**Tooling.** `@axe-core/playwright` was in `node_modules` but in neither
`package.json` nor the lockfile, so CI's `npm ci` would not have had it. Finding
36.

**Gates, as that pass measured them at the time** — kept as the record of what
was true then, not as a current figure; §4 carries the current ones. tsc 0 ·
eslint 0/0 · secret-scan clean over 450 files · `git diff --check` clean ·
the unit suite at the time stood at **76 files, 989 passed, 1 skipped, 0 failed, run twice with identical
results** · the browser suite at the time stood at **139 passed, 13 skipped, 0 failed** · migrations 29 of
29 on a clean database · admin smoke 18 of 18 · role audit clean. `readiness:demo` and `readiness:real-money` remain red on owner,
key, contract and regulatory items, which is the correct result.

**Layout.** On short pages the footer stopped mid-screen and left a band of pale
canvas beneath it. No automated check catches it — the page does not overflow
and nothing errors — and it was found by opening a screenshot, which is why the
brief asks for screenshots and not only a green suite. Finding 39.

**Artefacts.** 28 screenshots and the contact sheet were re-captured *after* the
final fix, and the interaction audit is 38 generated rows. Cash-out is now
`VERIFIED_IN_REAL_BROWSER` for the **quote**; taking the offer remains
`VERIFIED_BY_INTEGRATION_TEST`, and the two are recorded as different claims.

**Environment.** This machine was missing the MSVC redistributable, so
`embedded-postgres` could not start and vitest reported it as "No test files
found". Worked around for the gate runs; **the owner installed the
redistributable on 2026-09-05 and it is verified as the real fix** — see §0. Git
had no configured identity either; it is set repo-locally to the author already
in the history. The GitHub credential the push needed was supplied by the owner
on the same day.
