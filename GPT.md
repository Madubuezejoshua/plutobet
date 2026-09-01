# PlutoBet — Complete Engineering Audit

> ## HISTORICAL — not the current status
>
> This document records a full engineering audit performed on 2026-08-31. It is kept as evidence and is **not** the
> current state of the repository.
>
> **For what works today, read [`PROJECT_STATUS.md`](PROJECT_STATUS.md).**
> Where this file disagrees with it, that file is right.
>
> Nothing here has been deleted. Findings that were later resolved are still
> described as they were found, so the trail from defect to fix stays readable.



**Prepared for:** a senior engineer picking this project up cold
**Audit date:** 2026-08-31
**Method:** direct inspection of the working tree, Git history, live database,
live odds provider and the running deployment. Prior status documents were
treated as claims to verify, not as evidence.

**No secret values appear in this document.** Environment variables are named
and reported as SET / MISSING only.

---

## Status label key

| Label | Meaning |
|---|---|
| `VERIFIED_E2E` | Exercised successfully through the real application flow |
| `VERIFIED_LIVE_PROVIDER` | Verified against a real external provider response |
| `VERIFIED_AUTOMATED` | Covered by passing automated tests |
| `IMPLEMENTED_UNTESTED` | Code exists, no reliable test evidence |
| `PARTIALLY_IMPLEMENTED` | Only part of the functionality exists |
| `BLOCKED_BY_KEY` | Implementation exists, an API key/account is missing |
| `BLOCKED_BY_CONTRACT` | Requires a commercial provider agreement |
| `BLOCKED_BY_BUSINESS` | Requires a company, bank account, licence or owner decision |
| `BROKEN` | Implemented but currently fails |
| `NOT_IMPLEMENTED` | No meaningful implementation |
| `UNKNOWN` | Evidence insufficient |

---

## 1. Executive summary

### What PlutoBet is

A Nigerian online gambling platform built as a Next.js application over a
PostgreSQL double-entry ledger. It targets sports betting, casino, virtual
games and an AI assistant ("Pluto AI"), aimed at the Nigerian market
(naira, BVN/NIN identity, Paystack payments, Nigerian mobile prefixes).

### What it is intended to become

A full-scale operator comparable to SportyBet or Bet9ja: pre-match and in-play
sportsbook, casino and live casino, virtuals, jackpots, fantasy, lottery-style
draws, promotions, referrals and affiliates, plus an AI assistant that can
analyse matches and prepare bets and financial actions.

### What it has actually reached

**Engineering prototype with a production-grade money core.**

The financial engine — ledger, wallets, bet placement, settlement — is
genuinely well built and well tested. Almost everything that touches an
external company is not connected. **No real money has ever moved through this
system, and no customer-facing flow has been exercised end to end on the
deployed environment.**

### Final classification

> ### `Engineering prototype`
>
> Not a UI prototype — the depth is real and the money core is unusually
> rigorous. Not a sandbox MVP — a sandbox MVP implies a customer can complete a
> journey against test credentials, and on the deployed environment they cannot
> complete step one, because **the deployment has no database connection**.

**Evidence for that classification:**

- `GET /api/health` on the live deployment returns **HTTP 503** with
  `"3 blocking problem(s): IDENTITY_PEPPER, database, redis"`. Only
  `AUTH_SECRET` is set in the Railway environment.
- The database holds **322 events but 0 markets and 0 selections**. The cause is
  now known and specific — see B14: the odds delta job has never passed a
  bookmaker parameter and has failed with HTTP 400 on every run since it was
  written.
- `PAYSTACK_SECRET_KEY` is empty. No deposit or withdrawal has ever run.
- Local automated tests are strong and currently green: **46 spec files, 575
  passed, 1 skipped**, typecheck clean, production build clean. They cover the
  money core, concurrency, settlement, property-based and chaos scenarios.

### Strongest completed parts

1. **The double-entry ledger.** Integer kobo, append-only, database triggers
   that reject unbalanced commits, a runtime role that cannot alter ledger
   tables. `VERIFIED_AUTOMATED`.
2. **Wallet concurrency.** Row locks, deadlock-ordered transfers, idempotency
   with request fingerprints, proven by a 100-way hammer. `VERIFIED_AUTOMATED`.
3. **Settlement.** Win, loss, void, partial cash-out and resettlement by
   compensating entries; a winner is paid exactly once across five replays of
   the same result feed. `VERIFIED_AUTOMATED`.
4. **Registration and the age gate.** Exercised against the live database.
   `VERIFIED_E2E`.
5. **Odds response parsing.** Pinned against real captured provider payloads.
   `VERIFIED_LIVE_PROVIDER`.

### Biggest unfinished parts

- **No prices are stored.** Fixture ingestion works (322 events). Odds
  persistence has never produced a single market row — root cause identified as
  B14, a two-line defect.
- **`1x2` — the market most bets are placed on — has never been observed** in
  any real provider payload from this account.
- Fantasy, Lucky Numbers, Bet Builder, personalization and Admin AI are
  greenfield.
- Live/in-play betting is display-only.

### Biggest external blockers

Paystack live keys · Termii · Resend · a casino aggregator contract · a
virtuals provider · an in-play feed · an LLM key · a KYC verification provider ·
a gaming licence.

### Biggest engineering blockers

1. **The Railway deployment is not configured.** No `DATABASE_URL`, no
   `REDIS_URL`, no `IDENTITY_PEPPER`.
2. **Odds persistence has never produced a market.** Until it does, the
   sportsbook has nothing to sell.
3. **`NEXTAUTH_URL` is unset in production**, so sign-in callbacks point at
   `http://localhost:3000`.

### Can a real customer currently…

| Action | Answer | Why |
|---|---|---|
| Register | **No (deployed)** / Yes (locally) | The deployment has no database |
| Verify an account | **No** | Termii and Resend unconfigured; OTP prints to a log |
| Complete KYC | **No** | No BVN/NIN verification provider is integrated at all |
| View real fixtures | **Partially** | 322 real events ingested locally; none deployed |
| View real odds | **No** | 0 markets, 0 selections anywhere |
| Place a pre-match bet | **No** | Nothing is priced |
| Place a live bet | **No** | Display-only by design; no in-play feed |
| Deposit real money | **No** | No Paystack keys |
| Withdraw real money | **No** | Same |
| Receive winnings | **No** (in production) | Proven in tests only |
| Use casino games | **No** | No aggregator contract |
| Use virtual games | **No** | No provider |
| Use Pluto AI | **Partially** | A keyword router, not a language model |

---

## 2. Repository identity and current state

| Item | Value |
|---|---|
| Package name | `bet-platform` (v0.1.0) |
| Remotes | `origin` → `github.com/Madubuezejoshua/plutobet.git`; `plutobet` → `github.com/plutobet-ai/plutobet_ai.git` |
| Branch | `main` |
| Commit | `d14b7e05be9b2f1226c4053377c0fab9d0afcd39` |
| Commits | **15** |
| Latest commit date | 2026-08-31 14:30:31 −0700 |
| Both remotes at same commit | **Yes** — both `refs/heads/main` = `d14b7e0` |
| Working tree | **NOT clean — 28 entries** |
| Deployment target | Railway (`npm run build` → `scripts/deploy-build.mjs`) |
| Deployed URL | `https://plutobetai-production.up.railway.app` |
| `/api/health` | **HTTP 503 — unhealthy** |
| Node / npm | v24.15.0 / 11.12.1 |

### Uncommitted files

**Modified (10):** `PLUTOBET_STATUS.md`, `package.json`,
`scripts/deploy-build.mjs`, `scripts/grant-app-role.ts`,
`scripts/seed-admin.ts`, `src/modules/admin/navigation.ts`,
`src/modules/odds/sync.service.ts`,
`src/modules/wallet/__tests__/concurrency.acceptance.spec.ts`,
`src/modules/wallet/errors.ts`, `src/modules/wallet/wallet.service.ts`

**Untracked (18):** `PLUTOBET_CORE_FLOW_VALIDATION.md`, `rbac-check.mjs`,
`scripts/push-env-railway.ts`, `scripts/qa-credit.ts`,
`scripts/qa-odds-sync.ts`, `scripts/qa-place-bet.ts`,
`scripts/qa-register.ts`, `scripts/smoke-admin.ts`,
`src/app/admin/_guard.tsx`, eight new `src/app/admin/*` page directories,
`src/modules/wallet/__tests__/contention.acceptance.spec.ts`

> `rbac-check.mjs` is leftover debris from a debugging session and should be
> deleted. Flagged, not removed — this pass changes only `GPT.md`.

**Risk:** the two launch-blocking fixes described in §3 (the RBAC bootstrap and
the odds sync window) exist **only in the working tree**. They are not on either
remote, and a fresh clone does not have them.

### Live deployment health (verbatim, secrets absent by design)

```json
{
  "status": "unhealthy",
  "summary": "3 blocking problem(s): IDENTITY_PEPPER, database, redis",
  "checks": [
    { "name": "AUTH_SECRET",           "state": "ok",      "blocking": true  },
    { "name": "IDENTITY_PEPPER",       "state": "missing", "blocking": true  },
    { "name": "NEXTAUTH_URL | AUTH_URL","state": "missing", "blocking": false },
    { "name": "ODDS_API_KEY",          "state": "missing", "blocking": false },
    { "name": "PAYSTACK_SECRET_KEY",   "state": "missing", "blocking": false },
    { "name": "database",              "state": "missing", "blocking": true  },
    { "name": "redis",                 "state": "missing", "blocking": true  }
  ]
}
```

`GET /` returns 200 only because the homepage catches fixture-load failures and
renders an empty board. It is a shell over nothing.

---

## 3. Development history

Reconstructed from `git log` and the current tree. Fifteen commits over six
days, 2026-08-26 to 2026-08-31.

| # | Commit | Date | Scale | What |
|---|---|---|---|---|
| 1 | `10388ce` | 08-26 | 195 files, +42,768 | Initial commit — money core built to an earlier 8-phase brief |
| 2 | `604585e` | 08-26 | 4 files | Fix build-time server client initialisation |
| 3 | `6b7fa8e` | 08-26 | 1 file | Handle blank NextAuth deployment URLs |
| 4 | `05b6cee` | 08-26 | 8 files | Support Vercel database and Redis integrations |
| 5 | `84ccd4c` | 08-26 | 3 files | Migrate production database during deployment |
| 6 | `32aa110` | 08-27 | 133 files, +13,021 | PlutoBet phases 1–6 |
| 7 | `c9971d6` | 08-27 | 16 files | Phase 7 — booking codes, odds formats |
| 8 | `2ecd4cb` | 08-27 | 8 files | Phase 8 — system bets, bankers, slips |
| 9 | `391a37f` | 08-27 | 5 files | Phase 9 (part) — resettlement |
| 10 | `ccb654d` | 08-27 | 32 files, +4,011 | Phases 9–14 |
| 11 | `a49d5b6` | 08-27 | 23 files, +3,590 | Phases 15–21 |
| 12 | `db7d4f1` | 08-27 | 8 files | Phases 22–24 |
| 13 | `900012f` | 08-27 | 1 file | Status document restructure |
| 14 | `ef9ebac` | 08-27 | 13 files | Provider contract tests + settlement stall alarm |
| 15 | `d14b7e0` | 08-31 | 55 files, −3,601 | Odds parser fix, health endpoint, `legacy/` deleted |

### Architectural decisions worth knowing

- **Buckets as wallet rows, not columns.** CASH/BONUS/LOCKED are separate
  `wallets` rows so every existing ledger trigger covers them unchanged. A
  second balance column would have been unprotected.
- **Permissions in code, role assignments in the database.**
- **Conditional-poll realtime, not SSE/WebSockets** — chosen for serverless,
  where every open stream holds an invocation.
- **System bets as accumulators; virtuals as sportsbook events** — reuse of
  proven machinery rather than parallel implementations.
- **Corrections are compensating entries, never edits.**

### Bugs found and fixed — full register

Ten defects are documented. Six were found in earlier sessions and are
committed; four were found during the most recent core-flow validation and are
**uncommitted**.

---

#### B1 — Bucket-blind wallet lookups *(committed)*

| | |
|---|---|
| **Original behaviour** | Six queries resolved "the user's wallet" by `(user_id, kind, currency)` |
| **Root cause** | Phase 4 gave each account three wallet rows; the predicate matched all three and took whichever the planner returned first |
| **Impact** | **Deposits, settlement payouts, casino payouts, casino balance, withdrawal refunds and cash-out credited an arbitrary bucket.** The ledger stayed balanced — money simply landed where the customer could not spend it |
| **Fix** | All six now specify `bucket = 'CASH'` |
| **Regression test** | Yes |
| **Status** | `VERIFIED_AUTOMATED` |

This is the most instructive bug in the project: it produced no crash, no
imbalance and no alert.

---

#### B2 — Leap-day age-gate error *(committed)*

Found by a property test that passed on one seed and failed on another. On 29
February, `Date.UTC(y−18, 1, 29)` rolls *forward* to 1 March, making the cutoff
a day too young. Fixed with `setUTCDate(0)`. `VERIFIED_AUTOMATED`.

---

#### B3 — Forgeable step-up re-authentication *(committed)*

The first admin roles endpoint accepted `reauthenticatedAt` from the request
body — worse than useless, because the audit row would record a
re-authentication that never happened. Rewritten to server-held Redis state,
failing closed. `VERIFIED_AUTOMATED`.

---

#### B4 — Float arithmetic in two money paths *(committed)*

`BigInt(Math.round(Number(x) * 100))` in `withdraw-form.tsx` and
`bet-slip.tsx`, both directly beneath comments warning against exactly that.
Replaced with `parseNairaToKobo`. `VERIFIED_AUTOMATED`.

---

#### B5 — `sport` stored as `"[object Object]"` *(committed in `d14b7e0`)*

| | |
|---|---|
| **Root cause** | `sport` arrives as `{name, slug}`; the adapter did `String(e.sport ?? sport)` |
| **Impact** | The value is truthy and non-empty, so it passed every null check into the database. **Every event ever synced would have stored `sport = "[object Object]"`**, breaking browsing and filtering |
| **Fix** | A `text()` helper reading both string and `{name, slug}` shapes |
| **Regression test** | `provider-contract.acceptance.spec.ts` |
| **Status** | `VERIFIED_LIVE_PROVIDER` — confirmed today: `sport = "football"` across 322 ingested events, `[object Object]` count = 0 |

---

#### B6 — The odds parser returned no prices at all *(committed in `d14b7e0`)*

| | |
|---|---|
| **Root cause** | `normaliseBook()` was written from published documentation and never checked, because `probe-odds.ts` called `/odds` **without** a `bookmakers` parameter, received `400`, and stopped. The real response differs at every level |
| **Detail** | `bookmakers` is an object keyed by bookmaker name, not an array; each value is a list of markets, not a map; each market holds rows where `hdp` is the line and every other key is a selection; prices are strings |
| **Impact** | `asArray()` on an object returns `[]`, so **every snapshot came back with zero books** — silent, and indistinguishable from a quiet market |
| **Fix** | `normaliseSnapshots` and `normaliseBook` rewritten against a real captured payload |
| **Regression test** | 6 tests, including one proving `Corners Totals` never collides with goal totals |
| **Status** | `VERIFIED_LIVE_PROVIDER` for parsing — **but see §9: no market has ever been persisted end to end** |

---

#### B7 — Lock timeout escaped as an untyped error *(UNCOMMITTED)*

| | |
|---|---|
| **Original behaviour** | Under contention a rejection arrived as a raw Drizzle error, not a wallet error |
| **Root cause** | Money paths set `SET LOCAL lock_timeout = '30s'`; exceeding it raises PostgreSQL `55P03`. Drizzle wraps driver errors and hangs the original on `cause`, so nothing mapped it |
| **Impact** | An opaque HTTP 500 for a customer placing a bet during a burst, and no way for a caller to distinguish "retry shortly" from a real fault. **Money integrity was never at risk** — the transaction had written nothing |
| **How found** | The 100-way concurrency hammer failed on run 19 of 20. Intermittent, which is why earlier full-suite runs passed |
| **Files** | `src/modules/wallet/errors.ts`, `src/modules/wallet/wallet.service.ts` |
| **Fix** | New `WalletContentionError`; `55P03`/`40P01` mapped by walking the `cause` chain with a depth cap. `WALLET_LOCK_TIMEOUT` made configurable and pattern-validated (it is interpolated into `SET LOCAL`, which takes no bind parameters) |
| **Regression test** | `contention.acceptance.spec.ts` — 3 tests, including a SQL-injection guard on the new variable |
| **Status** | `VERIFIED_AUTOMATED` — 3/3 passing |

The concurrency hammer was also corrected to assert **conservation of money**
rather than a fixed success count. Requiring exactly 60 successes assumed no
operation ever loses the lock race, which is a claim about timing, not
correctness.

---

#### B8 — The admin panel was permanently unreachable *(UNCOMMITTED — LAUNCH-BLOCKING)*

| | |
|---|---|
| **Original behaviour** | A seeded admin could sign in and was then denied every admin page |
| **Root cause** | `RbacService.identify` requires **both** `users.role = 'ADMIN'` **and** a row in `admin_role_grants`. `scripts/seed-admin.ts` created only the users row. `RbacService.grant` refuses unless the actor already holds `SUPER_ADMIN`, and refuses self-granting |
| **Impact** | A **deadlock, not an error** — no one could ever obtain the first `SUPER_ADMIN`, so the admin panel was unreachable on any fresh deployment, permanently. Confirmed on the live database: the seeded admin had `role = ADMIN` and **zero grants** |
| **Files** | `scripts/seed-admin.ts` |
| **Fix** | The seed issues the initial `SUPER_ADMIN` grant inside its existing advisory-locked transaction, with `granted_by` set to the new admin and a reason recording that no other actor existed. Guarded on there being no live super admin anywhere, so it can only bootstrap — never re-elevate a revoked account. It also repairs an admin seeded before the fix |
| **Regression test** | **NONE YET — gap** |
| **Status** | `VERIFIED_E2E` manually — grant present, correct reason, idempotent across three runs |

---

#### B9 — Redis pointed at localhost *(configuration, fixed in gitignored `.env`)*

| | |
|---|---|
| **Root cause** | `REDIS_URL` was `redis://localhost:6379`. The real Upstash instance existed only as `UPSTASH_REDIS_REST_URL`, which `ioredis` cannot use — it speaks TCP, not REST |
| **Impact** | `ApiBudget.spend()` calls Redis before **every** provider request. With Redis refusing connections the odds sync produced **zero events in 25 minutes with no error surfaced**. Rate limiting and OTP storage were equally inert |
| **Fix** | `REDIS_URL` repointed to the Upstash TCP endpoint, verified with a real `PING` → `PONG` |
| **Status** | Fixed locally. **Railway still has no `REDIS_URL` at all** |

---

#### B10 — `syncFixtures` was unbounded *(UNCOMMITTED)*

| | |
|---|---|
| **Root cause** | The docstring has always claimed "one call covers the next 14 days", but no `to` parameter was ever passed. The provider returned its entire catalogue — ~5000 football events, of which only ~775 had not already finished |
| **Impact** | Each row costs an upsert plus taxonomy resolution and classification, so a job scheduled **every 30 minutes** ran for hours and never completed. It looked like a slow job; it was an unbounded one |
| **Files** | `src/modules/odds/sync.service.ts` |
| **Fix** | Pass the 14-day horizon the docstring already promised, and skip already-settled fixtures |
| **Regression test** | **NONE YET — gap** |
| **Status** | `VERIFIED_LIVE_PROVIDER` — the run now completes: 132 upserted, 322 stored, 88 upcoming, zero `[object Object]`. Markets remain 0 for the unrelated reason in B14 |

---

#### B14 — the odds delta job has never worked *(UNRESOLVED — this is why there are no prices)*

| | |
|---|---|
| **Observed** | `syncOddsDelta() FAILED: odds-api.io /odds/updated -> 400 {"error":"Missing bookmaker parameter"}` |
| **Root cause** | `sync.service.ts` calls `this.provider.getUpdatedSince(since, { sport: this.config.sport })` — **it never passes a bookmaker.** The adapter forwards `bookmaker: opts.bookmaker`, which is `undefined`, so the parameter is omitted from the URL and the provider rejects the request. Note the provider expects singular `bookmaker`, while `SyncConfig` holds a plural `bookmakers` array — the two were never reconciled |
| **Impact** | **This is the single reason PlutoBet has no prices.** The delta job is scheduled every 5 minutes and has failed on every run since it was written. `markets: 0, selections: 0` |
| **Why the fallback did not save it** | `fullRefreshWatchlist()` runs only when `getUpdatedSince` returns `null`. Here it **throws**, and `guard()` re-raises anything that is not an `OutOfBudgetError`. So the fallback path has never executed either |
| **Files** | `src/modules/odds/sync.service.ts` (~line 138), `src/modules/odds/odds-api-io.ts` (~line 104) |
| **Fix** | **NOT APPLIED** — this audit is reporting-only |
| **Status** | `BROKEN` |

This defect is small, specific and almost certainly a short fix. It is also the
highest-value item in this document: closing it is what turns a sportsbook with
no prices into one that has them.

---

#### B15 — team key generation rejects non-ASCII names *(UNRESOLVED)*

| | |
|---|---|
| **Observed** | PostgreSQL `23514` — `teams_key_format` violated. Failing row: key `cd-o´higgins`, name `CD O´Higgins`, country Chile |
| **Root cause** | The slug generator does not strip or transliterate non-ASCII characters. `teams_key_format` is `CHECK (key ~ '^[a-z0-9-]{1,120}$')`, and the acute accent (U+00B4) in `O´Higgins` fails it |
| **Impact** | Contained but real. Taxonomy classification is wrapped in a best-effort `try/catch`, so ingestion continues and the fixture is still bettable — but it is never classified onto the sports hierarchy, so it is missing from competition browsing and from the head-to-head data the AI analysis phase depends on. Affects any club with an accented or punctuated name — common across South America, Iberia and Turkey |
| **Files** | `src/modules/sports/taxonomy.service.ts` (slug generation), constraint in `drizzle/0013_phase6_sports_taxonomy.sql:84` |
| **Fix** | **NOT APPLIED** — reporting-only |
| **Status** | `BROKEN` (partial) |

---

#### Also found, not fixed

- **B11 — `NEXTAUTH_URL` unset in production.** `/api/auth/providers` returns
  callbacks at `http://localhost:3000`. `BROKEN`. Requires Railway access.
- **B12 — QA funding writes no admin audit row.** It runs as
  `actor: {type:"SYSTEM"}` from a script. Acceptable for a QA script disabled
  outside development; **not** acceptable as a pattern for real adjustments.
- **B13 — two invented column names** in the new admin pages (`bets.bet_type`,
  `casino_providers.status`) typechecked cleanly, because SQL inside a template
  literal is not checked. Fixed; `npm run admin:smoke` is the guard.

---

## 4. Technology stack

| Layer | Technology | Version | Notes |
|---|---|---|---|
| Framework | Next.js (App Router) | 16.3.2 | Turbopack builds |
| Runtime | React / React DOM | 19.2.8 | |
| Language | TypeScript | 5.9.3 | `strict` |
| Styling | Tailwind CSS | 4.1.14 | plus hand-written `globals.css` |
| Auth | NextAuth (Auth.js) | 4.24.15 | credentials provider, JWT sessions |
| Password hashing | argon2 (argon2id) | 0.45.1 | verified: hashes begin `$argon2id$v=` |
| Validation | Zod | 4.1.5 | |
| ORM | Drizzle ORM | 0.45.2 | schemas in TS; constraints/triggers hand-written SQL |
| Driver | postgres-js | 3.4.5 | |
| Database | PostgreSQL (Neon serverless) | — | 24 migrations, 60 tables |
| Cache | Redis (Upstash) via ioredis | ^5.11.1 | TCP, not REST |
| Background jobs | Inngest | 4.18.1 | **13** registered functions |
| Object storage | AWS SDK S3 → Backblaze B2 | ^3.1116.0 | |
| Payments | Paystack — **hand-written adapter**, no SDK | — | `https://api.paystack.co` |
| Odds provider | odds-api.io v3 — hand-written adapter | — | |
| SMS | Termii adapter | — | `BLOCKED_BY_KEY` |
| Email | Resend adapter | — | `BLOCKED_BY_KEY` |
| KYC | **None** | — | `NOT_IMPLEMENTED` — see §13 |
| Error monitoring | Sentry | 10.70.0 | wired, DSN empty |
| AI | **No SDK installed** | — | see §14 |
| Testing | Vitest + fast-check | 3.2.7 / 4.9.0 | real embedded Postgres + Redis |
| Deployment | Railway | — | `scripts/deploy-build.mjs` |
| CI/CD | **None** | — | `NOT_IMPLEMENTED` — no workflow files |

### Pooled vs unpooled database connections

Both exist deliberately. `DATABASE_URL` is Neon's PgBouncer endpoint used for
ordinary reads (`prepare: false`, required by transaction-mode pooling).
`DIRECT_DATABASE_URL` is an unpooled connection used exclusively by money
paths, because `SELECT … FOR UPDATE` row locks and `SET LOCAL ROLE` are
session-scoped and unsafe through a transaction pooler.
`MIGRATION_DATABASE_URL` is a third, owner-role connection — the runtime role
must not own ledger tables, which is what stops application code from altering
a table a trigger depends on.

### Realtime transport

**Conditional polling with ETag/304**, not SSE or WebSockets. Documented
reasoning: on a serverless platform every open stream holds an invocation for
its whole lifetime. No realtime library is installed — confirmed by dependency
search.

### AI

**No AI SDK is installed** — no `@anthropic-ai/sdk`, no OpenAI SDK, no vector
store. A dependency search for external model calls in `src/modules/ai/`
returns nothing. See §14.

---

## 5. Architecture map

### Layers

**Frontend** — Next.js App Router, two route groups: `src/app/(site)` for
player chrome, `src/app/admin` for admin chrome. They deliberately do not share
navigation; an admin reviewing exposure should not be one tap from a betslip.

**API** — 25 route handlers under `src/app/api`, wrapped by
`publicRoute`/`authedRoute`/admin guards providing rate limiting, Zod
validation and error mapping.

**Domain** — 23 modules under `src/modules`.

### Flow-by-flow verification status

| # | Flow | Status | Evidence |
|---|---|---|---|
| 1 | Registration | `VERIFIED_E2E` | Real service against the live DB; user `8af6309c…` created |
| 2 | Login | `VERIFIED_AUTOMATED` | Password verify correct both ways; **no browser session test** |
| 3 | Account verification | `BLOCKED_BY_KEY` | Code path exists; no SMS/email provider |
| 4 | KYC | `PARTIALLY_IMPLEMENTED` | Document upload and review exist; **no identity verification provider** |
| 5 | Odds ingestion | `PARTIALLY_IMPLEMENTED` | Fixtures yes (113 events); **markets/prices never persisted** |
| 6 | Bet placement | `VERIFIED_AUTOMATED` | Extensive tests; **never run against a real ingested fixture** |
| 7 | Settlement | `VERIFIED_AUTOMATED` | Win/loss/void proven deterministically |
| 8 | Winning payout | `VERIFIED_AUTOMATED` | Paid exactly once across 5 replays |
| 9 | Losing bet | `VERIFIED_AUTOMATED` | 0 payout legs |
| 10 | Void bet | `VERIFIED_AUTOMATED` | Stake returned exactly once |
| 11 | Deposit | `BLOCKED_BY_KEY` | Adapter + webhook exist; never run |
| 12 | Withdrawal | `BLOCKED_BY_KEY` | Same |
| 13 | Cash-out | `VERIFIED_AUTOMATED` | Full and partial |
| 14 | AI-prepared action | `IMPLEMENTED_UNTESTED` (live) / `VERIFIED_AUTOMATED` (guardrails) | Draft-only enforced in code and tests |

---

## 6. User-facing functionality

26 player pages exist. `src/lib/navigation.ts` is the single source of truth and
its `status` flag drives placeholders, so an unfinished area cannot silently
look finished.

| Route | Status | Real data? | Evidence / remaining work |
|---|---|---|---|
| `/` Home | `IMPLEMENTED_UNTESTED` | No — board empty | Renders; no fixtures priced |
| `/register` | `VERIFIED_E2E` | Yes | Age gate + duplicate rejection proven |
| Login (`/api/auth/*`) | `VERIFIED_AUTOMATED` | Yes | Deployed endpoint answers 200 |
| `/forgot-password` | `BLOCKED_BY_KEY` | — | Needs Resend |
| Email verification | `BLOCKED_BY_KEY` | — | Route + UI shipped in `d14b7e0`; needs Resend |
| Phone verification | `BLOCKED_BY_KEY` | — | Needs Termii |
| `/account`, `/preferences`, `/security` | `IMPLEMENTED_UNTESTED` | Yes | Session revocation is real |
| `/kyc` | `PARTIALLY_IMPLEMENTED` | Yes | Upload + review only; no verification provider |
| `/wallet` | `VERIFIED_E2E` | Yes | Correct CASH balance after QA credit |
| `/deposit` | `BLOCKED_BY_KEY` | No | Paystack |
| `/withdraw` | `BLOCKED_BY_KEY` | No | Paystack |
| `/sports` | `PARTIALLY_IMPLEMENTED` | Fixtures only | **0 selections — nothing bettable** |
| `/live` | `PARTIALLY_IMPLEMENTED` | No | Display-only by design |
| Betslip | `VERIFIED_AUTOMATED` | — | Never exercised on real prices |
| `/bets` My Bets | `IMPLEMENTED_UNTESTED` | — | No bet has ever existed |
| Booking codes | `VERIFIED_AUTOMATED` | — | Phase 7 |
| Singles / Accumulators | `VERIFIED_AUTOMATED` | — | |
| System bets / Bankers | `VERIFIED_AUTOMATED` | — | Combinatorics proven exact |
| Cash-out / partial | `VERIFIED_AUTOMATED` | — | |
| Edit bet | `NOT_IMPLEMENTED` | — | |
| Bet Builder | `NOT_IMPLEMENTED` | — | 0 source matches; needs correlated pricing |
| `/livescore`, `/results` | `PARTIALLY_IMPLEMENTED` | Fixtures only | No results ingested |
| Statistics | `PARTIALLY_IMPLEMENTED` | — | Team form, head-to-head exist |
| `/casino` | `BLOCKED_BY_CONTRACT` | No | Interface + sandbox + lobby; no aggregator |
| `/live-casino` | `NOT_IMPLEMENTED` | No | Marked PLANNED |
| `/virtuals` | `BLOCKED_BY_CONTRACT` | No | One service file, no provider adapter |
| Instant games | `NOT_IMPLEMENTED` | — | |
| `/fantasy` | `NOT_IMPLEMENTED` | No | **2 source matches — nav entries only** |
| `/jackpot` | `VERIFIED_AUTOMATED` | — | Slate, entries, scoring, pool split proven exact |
| `/lucky-numbers` | `NOT_IMPLEMENTED` | No | **3 source matches — nav entries only** |
| `/promotions` | `IMPLEMENTED_UNTESTED` | — | Admin view added, unexercised |
| Bonuses | `VERIFIED_AUTOMATED` | — | Wagering, conversion, expiry clawback |
| `/rewards` | `PARTIALLY_IMPLEMENTED` | — | Tiers derived |
| `/referrals` | `PARTIALLY_IMPLEMENTED` | — | Qualification-gated |
| Affiliates | `PARTIALLY_IMPLEMENTED` | — | Schema only |
| `/responsible` | `VERIFIED_AUTOMATED` | — | Asymmetric limits verified live earlier |
| Self-exclusion | `VERIFIED_AUTOMATED` | — | Survives re-registration |
| Notifications | `PARTIALLY_IMPLEMENTED` | — | In-app only |
| Support | `PARTIALLY_IMPLEMENTED` | — | Tickets, disputes |
| Social/community | `PARTIALLY_IMPLEMENTED` | — | No module directory; schema-level |
| `/pluto` Pluto AI | `PARTIALLY_IMPLEMENTED` | — | Keyword router — see §14 |
| AI match analysis | `VERIFIED_AUTOMATED` | — | Arithmetic probabilities |
| AI bet preparation | `VERIFIED_AUTOMATED` | — | Draft-only |
| AI financial drafts | `VERIFIED_AUTOMATED` | — | Confirmation + step-up |
| Personalization | `NOT_IMPLEMENTED` | — | **0 source matches** |

---

## 7. Admin functionality

18 admin pages exist. Eight were added in the uncommitted working tree.

| Function | Status | Evidence |
|---|---|---|
| Admin login | `VERIFIED_E2E` | Seeded admin `b0ca3a52…`, `must_change_password` true |
| Admin seeding | `VERIFIED_E2E` **after fix** | See B8 — was a deadlock |
| RBAC roles | `VERIFIED_AUTOMATED` | 8 roles, 31 permissions |
| Permissions | `VERIFIED_AUTOMATED` | Separation of duties tested |
| Step-up auth | `VERIFIED_AUTOMATED` | Server-held in Redis, fails closed |
| User listing | `VERIFIED_E2E` | QA user visible with correct fields |
| User detail | `IMPLEMENTED_UNTESTED` | |
| KYC review | `IMPLEMENTED_UNTESTED` | |
| Wallet visibility | `VERIFIED_E2E` | CASH 20000 shown |
| Ledger visibility | `VERIFIED_E2E` | ADJUSTMENT with both legs |
| Manual adjustments | `NOT_IMPLEMENTED` (UI) | QA script only; see B12 |
| Bet visibility | `IMPLEMENTED_UNTESTED` | Query runs clean; **no bet ever existed** |
| Settlement visibility | `IMPLEMENTED_UNTESTED` | |
| Resettlement | `VERIFIED_AUTOMATED` | Compensating entries |
| Cash-out monitoring | `NOT_IMPLEMENTED` | No dedicated view |
| Withdrawal approval | `IMPLEMENTED_UNTESTED` | |
| Risk/fraud | `IMPLEMENTED_UNTESTED` | |
| Responsible-gaming mgmt | `IMPLEMENTED_UNTESTED` | Read-only by design |
| Promotions | `IMPLEMENTED_UNTESTED` | |
| Referrals/affiliates | `NOT_IMPLEMENTED` (admin view) | |
| Provider monitoring | `IMPLEMENTED_UNTESTED` | Events page shows feed staleness |
| Settlement alerts | `VERIFIED_AUTOMATED` | 3 tests |
| Revenue reporting | `VERIFIED_AUTOMATED` | GGR from ledger |
| Audit logs | `VERIFIED_AUTOMATED` | DB-enforced reason |
| Sentry visibility | `BLOCKED_BY_KEY` | DSN empty |
| Admin AI | `NOT_IMPLEMENTED` | 0 source matches |

### Explicit answers required by this audit

- **Did the newly registered QA user appear in admin?** **YES.** The
  `/admin/users` query returned `qa-flow-1788218004223@plutobet.test`, status
  `ACTIVE`, kyc 0, both verification flags false, CASH 20000.
- **Did the admin see the QA bet and its final status?** **NO — no QA bet was
  ever placed.** Odds persistence never produced a market, so there was nothing
  to bet on. The `/admin/bets` query executes cleanly against the real schema
  but has never displayed a row.

---

## 8. Registration and account validation

| Item | Result |
|---|---|
| Environment | Local process against the **live Neon database** |
| Path used | `registrationService.register` — the same service the public API route calls |
| Real user-facing path? | **Service-level, not HTTP.** The browser form was not driven |
| Inserted directly? | **No.** No direct INSERT into `users` |
| Email verification | Not completed — `email_verified_at` null |
| Phone verification | Not completed — `phone_verified_at` null |
| Termii used? | **No** — not configured |
| Resend used? | **No** — not configured |
| Development OTP used? | **No** — the OTP step was not exercised |
| Production bypass added? | **No** |
| Age validation | **PASS** — a 17-year-old was refused |
| Duplicate rejection | **PASS** — duplicate email refused |
| Password hashing | **PASS** — `$argon2id$v=` |
| Appeared in admin | **YES** |
| Wallet rows created | **YES** — `BONUS=0 CASH=0 LOCKED=0` |
| Opening balance | **0 kobo, 0 ledger entries** |

**Limitations.** Registration is proven at the service layer against a real
database. It has **not** been proven through the deployed HTTP endpoint,
because the deployment has no database. Verification is code-complete and
externally blocked.

---

## 9. Odds and sports-data validation

| Item | Finding |
|---|---|
| Provider | odds-api.io v3 |
| Plan limit | **2 bookmakers.** A 3-bookmaker request returned `403 Access denied. You're allowed max 2` |
| Bookmakers available | `1xbet` confirmed active |
| Second bookmaker tested? | **No** — `bet365` was configured but never confirmed permitted |
| Sports/leagues fetched | Football; Ukraine Premier League, Turkish Süper Lig, Brazilian Série A2, EFL Cup, others |
| Events fetched | 5000 returned unbounded. After the horizon fix: **132 upserted, 322 stored, 88 upcoming** — run completed |
| Markets returned by provider | Double Chance, Spread, Totals, European Handicap, Corners ×4, Correct Score |
| **`1x2` appeared?** | **NO.** Not in any payload observed from this account |
| Selections parsed (in-memory) | **77** across `double_chance`, `handicap` (32), `over_under` (42) |
| Selections **persisted** | **0** |
| Price format | Strings (`"1.584"`); non-finite or ≤ 1.0 dropped |
| Provider timestamps | `updatedAt` per market; newest retained as book freshness |
| Settlement fields | `scores.periods.ft` — confirmed present on settled events |
| Contract tests | 13 passing + 1 opt-in live check |
| Sanitization | API key scrubbed recursively before any fixture write; committed fixtures verified key-free |
| Stall alert | Fires when a finished match with pending bets has no result for 6 hours |

### Parser bugs — all previously fixed

Sport as object (B5) · bookmakers as object (B6) · markets as array (B6) ·
selections as dynamic row keys (B6) · prices as strings (B6). All are pinned by
`provider-contract.acceptance.spec.ts` against real captured payloads.
`scores.periods.ft` was validated and is now asserted on every test run.

### Could the platform safely accept production bets on this feed?

**No.** Three independent reasons:

1. **No market has ever been persisted.** 322 events, 0 markets, 0 selections.
   Parsing is proven in memory; the persistence path fails at the provider call
   itself — see B14, the delta endpoint has never been sent a bookmaker.
2. **`1x2` has never been observed.** The market most bets are placed on is
   unverified against this account.
3. **One bookmaker means one price and no comparison**, and margin cannot be
   sanity-checked against a second source.

---

## 10. Wallet, ledger and money core

### Architecture

- **Integer kobo (`BIGINT`) end to end.** No float in any money path.
- **Three wallet rows per account** — CASH, BONUS, LOCKED — as rows, not
  columns, so every trigger covers them unchanged.
- **Double-entry, append-only.** Deferred triggers reject unbalanced, empty,
  malformed or cache-divergent commits.
- **Runtime role restriction.** Money paths run `SET LOCAL ROLE app_role`; that
  role cannot own or alter ledger tables.
- **Row locks** via `SELECT … FOR UPDATE`; transfers lock both wallets in UUID
  order to avoid deadlock.
- **Idempotency with SHA-256 request fingerprints** — replaying a key with
  different parameters raises a typed conflict instead of silently succeeding.
- **Bonus cannot be withdrawn** — a database trigger refuses it.
- **Corrections are compensating entries**, never edits.

### The bucket bug and its guard

See B1. The fix was to name `bucket = 'CASH'` in all six queries; the guard is
a regression test plus a standing rule that any new `wallets` query must
specify a bucket.

### QA funding test

| Item | Result |
|---|---|
| Method | `scripts/qa-credit.ts` → `walletService.credit` |
| Direct SQL used? | **No** — no `UPDATE wallets SET balance` anywhere |
| Amount | 20,000 kobo (₦200) |
| Reason | `QA_VALIDATION_CREDIT` in transaction metadata |
| Bucket credited | **CASH** — verified `CASH=20000 BONUS=0 LOCKED=0` |
| Before / after | 0 → 20,000 kobo |
| Double entry | DEBIT `ADJUSTMENTS_EQUITY` 20000 / CREDIT `USER CASH` 20000 |
| Idempotent replay | Same key → `idempotent: true`, balance unchanged |
| Fingerprint conflict | Same key + 50000 → `idempotency key was already used for a different operation` |
| Guards | Refuses `NODE_ENV=production`; requires `ALLOW_QA_CREDIT=true`; rejects non-integer amounts |
| Admin visibility | **YES** |
| Global ledger | debits 20000 = credits 20000 |

> **This is not a Paystack deposit.** It proves the wallet, ledger and
> idempotency machinery. It proves **nothing** about the payment gateway.

---

## 11. Bet placement and settlement validation

### Live provider end-to-end — **BLOCKED**

**No bet was ever placed against a real ingested fixture**, because odds
persistence produced no markets. `scripts/qa-place-bet.ts` exists and exits
with `BLOCKED: no open 1x2 selection on an upcoming event`.

### Deterministic automated settlement — PASS

`src/modules/settlement/__tests__/settlement.acceptance.spec.ts`, driving the
production settlement service, real database constraints and real ledger
posting in an isolated test database.

| Scenario | Assertion | Result |
|---|---|---|
| Pending | Stays PENDING while any event lacks a result | PASS |
| Winning | Replaying the result feed 5× pays **exactly once** | PASS |
| Losing | Settles with **0** payout legs | PASS |
| Void | Stake returned exactly once, no profit | PASS |
| Accumulator + void leg | Recalculated at odds 1.0 | PASS |
| Exposure | Released on settlement | PASS |
| Market closure | Closed so nothing can be placed on a finished match | PASS |
| Duplicate settlement | Never pays twice | PASS |
| Resettlement | Compensating entries; original untouched | PASS |
| Chaos | No partial settlement after repeated mid-transaction kills | PASS |
| Concurrent placement | 100-way hammer; no negative balance, no drift | PASS |
| Insufficient funds | Typed `InsufficientFundsError` | PASS |
| Duplicate placement | One idempotency key → one bet | PASS |
| Stale odds | Rejected / re-quote required | PASS |

**Stake removal:** the stake is debited **at placement**, not at settlement.
A ₦200 bet on a ₦200 balance leaves ₦0 immediately.

> **These are deterministic fixture tests, not a real match.** They use
> sanitized payloads shaped like real provider responses. Nobody has waited for
> an actual fixture to finish and watched a real settlement occur. Those are
> different claims and this audit does not conflate them.

---

## 12. Payments and withdrawals

### What exists

| Component | Status |
|---|---|
| Payment provider interface + factory | `IMPLEMENTED_UNTESTED` |
| Paystack adapter (`https://api.paystack.co`) | `IMPLEMENTED_UNTESTED` |
| Sandbox provider (refuses to boot in production) | `VERIFIED_AUTOMATED` |
| Deposit initialization | `IMPLEMENTED_UNTESTED` |
| Webhook signature validation (HMAC-SHA512, raw body, constant-time) | `VERIFIED_AUTOMATED` |
| Deposit idempotency | `VERIFIED_AUTOMATED` |
| Transfer recipient creation | `IMPLEMENTED_UNTESTED` |
| Transfer initiation + references | `IMPLEMENTED_UNTESTED` |
| Transfer status: success / failure / reversal | `VERIFIED_AUTOMATED` (fixtures) |
| Withdrawal balance reservation | `VERIFIED_AUTOMATED` |
| KYC withdrawal caps | `VERIFIED_AUTOMATED` |
| Manual approval + payout worker | `IMPLEMENTED_UNTESTED` |
| Reconciliation | `VERIFIED_AUTOMATED` |

### What has actually been tested

| Test | Performed? |
|---|---|
| Automated unit/integration tests | **Yes** — 4 spec files |
| Fixture-based webhook tests | **Yes** |
| Paystack **test mode** | **NO** |
| Paystack **live mode** | **NO** |
| Real ₦100/₦200 deposit | **NO** |
| Real transfer to a Nigerian bank account | **NO** |
| Webhook actually received from Paystack | **NO** |

**Not one byte has ever been exchanged with Paystack.** The adapter is written
against published documentation and exercised only by fixtures.

### What the boss must obtain

Registered company · corporate bank account · approved Paystack business
account · live secret and public keys · a webhook URL registered with Paystack
pointing at the deployed domain.

---

## 13. KYC, security, risk and regulatory status

### The critical distinction

**No external identity-verification provider is integrated.** A search of
`src/modules/kyc/` finds document storage (Backblaze) and hashing, and **no
verification API call whatsoever**. "KYC tier" code is an internal
authorisation model — it decides what a tier may do. It does **not** verify
that anybody is who they claim to be.

| Control | Status | Note |
|---|---|---|
| Age gate | `VERIFIED_E2E` | 17-year-old refused |
| Date-of-birth handling | `VERIFIED_AUTOMATED` | Leap-day bug fixed (B2) |
| Old-account DOB backfill | `NOT_IMPLEMENTED` | Flagged, not blocked — needs an owner decision |
| KYC tiers + withdrawal caps | `VERIFIED_AUTOMATED` | Tier 0 → ₦0 |
| **BVN/NIN verification provider** | **`NOT_IMPLEMENTED`** | Digest stored; never checked against any registry |
| Bank-account name matching | `NOT_IMPLEMENTED` | |
| Duplicate identity prevention | `VERIFIED_AUTOMATED` | Via identity digest |
| Self-exclusion | `VERIFIED_AUTOMATED` | Survives re-registration |
| Identity digest / pepper design | `VERIFIED_AUTOMATED` | HMAC under a server-held pepper |
| **Pepper rotation** | **NOT DONE** | See below |
| RG limits + 24h cooling | `VERIFIED_AUTOMATED` | Asymmetric by design |
| Fraud/risk scoring | `IMPLEMENTED_UNTESTED` | Heuristic signals |
| Audit logs | `VERIFIED_AUTOMATED` | DB-enforced reason |
| Secrets management | `PARTIALLY_IMPLEMENTED` | `.env` gitignored; no managed secret store |
| **Credential rotation** | **NOT DONE** | |
| Rate limiting | `BROKEN` in production | Requires Redis; Railway has none |
| CSRF / sessions | `VERIFIED_AUTOMATED` | httpOnly, sameSite, secure |
| Input validation | `VERIFIED_AUTOMATED` | Zod at every boundary |
| RBAC / separation of duties | `VERIFIED_AUTOMATED` | |
| Security review | `PARTIALLY_IMPLEMENTED` | Self-review only |
| Penetration testing | `NOT_IMPLEMENTED` | |
| Independent certification | `NOT_IMPLEMENTED` | |
| Licensing | `BLOCKED_BY_BUSINESS` | |

### `IDENTITY_PEPPER` — explicit call-out

**The pepper was pasted into a chat transcript during setup and has NOT been
rotated.** It is set locally and **missing from the Railway deployment**.

The important and time-limited fact: **only test identities exist today.** The
`users` table holds 4 accounts, all `@plutobet.test`. Rotation is normally
impossible — every stored identity digest derives from the pepper, so rotating
it silently breaks self-exclusion for every existing account.

**Right now that cost is zero.** Once real customers exist, this becomes
permanently unfixable. Rotating the pepper and moving it to managed secret
storage should happen **before the first real registration**, and this window
will not reopen.

---

## 14. AI status

### What Pluto AI actually is

**A keyword router. There is no language model connected.** No AI SDK is
installed; no external model HTTP call exists in `src/modules/ai/`.

| Component | Status |
|---|---|
| Tool registry (no dynamic dispatch) | `VERIFIED_AUTOMATED` |
| User-scoped tools take **no** userId parameter | `VERIFIED_AUTOMATED` — asserted by a test walking the registry |
| Guardrails: auth → RG override → confirmation → reauth | `VERIFIED_AUTOMATED` |
| Draft-only money actions | `VERIFIED_AUTOMATED` |
| Step-up authentication | `VERIFIED_AUTOMATED` |
| Arithmetic probabilities (sum to exactly 1, state confidence) | `VERIFIED_AUTOMATED` |
| Match analysis | `VERIFIED_AUTOMATED` |
| Navigation by key, never inventing URLs | `VERIFIED_AUTOMATED` |
| Bet preparation (draft) | `VERIFIED_AUTOMATED` |
| Deposit/withdrawal drafts | `VERIFIED_AUTOMATED` |
| RAG retrieval (curated corpus) | `PARTIALLY_IMPLEMENTED` |
| Personalization | `NOT_IMPLEMENTED` |
| Admin AI | `NOT_IMPLEMENTED` |
| **Prompt-injection testing** | **`NOT_IMPLEMENTED`** |
| **Concurrency testing** | **`NOT_IMPLEMENTED`** |
| Model provider key | `BLOCKED_BY_KEY` |

The safety architecture is the valuable part and it is genuinely built: the
model emits only a tool *name*, dispatched by a hand-written `switch`, so a
model cannot invent a callable. The rules-based fallback is safe in production —
a keyword router cannot be prompt-injected — so it degrades rather than
refusing to start.

**Remaining work after a key arrives:** implement the provider adapter, add
prompt-injection tests, add concurrency tests, tune the budget guard. This is
days of work, not an afternoon, and it must not be described as "swap a key".

---

## 15. Environment variables

`SET` reflects the **local `.env`**. `RAILWAY` reflects the live `/api/health`
response. **No values appear here.**

| Variable | Provider | Local | Railway | Enables | Blocked without it |
|---|---|---|---|---|---|
| `DATABASE_URL` | Neon (pooled) | SET | **MISSING** | All reads | Everything |
| `DIRECT_DATABASE_URL` | Neon (unpooled) | SET | UNKNOWN | Money paths | All money movement |
| `MIGRATION_DATABASE_URL` | Neon (owner) | SET | UNKNOWN | Migrations, role grant | Schema updates |
| `APP_DATABASE_ROLE` | — | SET | UNKNOWN | Role separation | — |
| `REDIS_URL` | Upstash (TCP) | SET *(fixed this session)* | **MISSING** | Rate limits, OTP, odds budget | Odds sync, rate limiting |
| `UPSTASH_REDIS_REST_URL/TOKEN` | Upstash | SET | UNKNOWN | Source of the TCP endpoint | — |
| `AUTH_SECRET` | — | SET | **SET** | Sessions | Every page 500s |
| `NEXTAUTH_URL` | — | SET | **MISSING** | Sign-in callbacks | **Callbacks → localhost** |
| `IDENTITY_PEPPER` | — | SET | **MISSING** | Identity hashing, self-exclusion | KYC and self-exclusion |
| `ODDS_API_KEY` | odds-api.io | SET | **MISSING** | Fixtures and prices | Empty board |
| `PAYSTACK_SECRET_KEY` | Paystack | **EMPTY** | MISSING | Deposits/withdrawals | All real money |
| `PAYSTACK_PUBLIC_KEY` | Paystack | **EMPTY** | MISSING | Checkout | Same |
| `TERMII_API_KEY` / `SENDER_ID` | Termii | **ABSENT from `.env`** | MISSING | SMS OTP | **Nobody can register** |
| `RESEND_API_KEY` / `FROM` | Resend | **ABSENT from `.env`** | MISSING | Email | Verification, reset |
| `SENTRY_DSN` | Sentry | **EMPTY** | MISSING | Error visibility | Blind in production |
| `B2_*` (5 vars) | Backblaze | SET | UNKNOWN | KYC documents | Document upload |
| `INNGEST_EVENT_KEY` / `SIGNING_KEY` | Inngest | SET | UNKNOWN | Background jobs | Settlement, sync |
| `SEED_ADMIN_EMAIL` / `PASSWORD` | — | SET *(this session)* | MISSING | First admin | No admin |
| AI model key | — | **ABSENT** | MISSING | Pluto AI | Keyword router only |
| Casino aggregator | — | **ABSENT** | MISSING | Casino | Contract, not a key |
| Virtuals provider | — | **ABSENT** | MISSING | Virtuals | Contract, not a key |
| KYC provider | — | **ABSENT** | MISSING | Identity verification | Contract, not a key |

> `TERMII_*` and `RESEND_*` are **absent from `.env.example` as well** — they
> are documented in `docs/deployment.md` but missing from the environment
> contract. That is a real gap.

---

## 16. Test and verification inventory

Commands run for this audit against the current working tree.

| Command | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0 — clean** |
| `npx vitest run` | **46 files · 575 passed · 1 skipped · 576 total · exit 0** |
| `npx next build` | **exit 0 — clean**, 70 routes emitted |
| Spec files on disk | **46** |
| Migrations on disk | **24** |
| Migrations applied (Neon) | **24** |
| Public tables (Neon) | **60** |
| Deployment health | **503 unhealthy** |
| Code coverage | **Not configured** — no coverage tooling |
| Load testing | Bet placement only; homepage, casino callbacks, live-feed polling and AI concurrency **untested** |

### Resolving the suite-count contradiction

The status document has variously claimed 42, 44 and 45 suites. Measured truth:

- **46 spec files**, all passing: **575 passed, 1 skipped, 576 total** on the
  current working tree (45 files at the start of the previous session; one
  added for B7).
- All live under `src/modules/**`, the only path the vitest `include` pattern
  collects — **none are orphaned or silently unrun**.
- Baseline before this session: **572 passed, 1 skipped, 573 total, 45 files.**
  Current: **575 passed, 1 skipped, 576 total, 46 files** — the three new tests
  are the B7 contention regressions.
- The single skip is the opt-in live provider contract block, skipped unless
  `ODDS_LIVE_CONTRACT=1`. **It is not counted as passing.**

An earlier run in the previous session produced **571 passed / 1 failed** — the
intermittent concurrency defect (B7). **A green count on one run was never
sufficient evidence**, which is the most useful lesson in this section.

### Per-module spec distribution

wallet 7 · betting 7 · settlement 5 · odds 5 · payments 4 · ai 3 · users 2 ·
sports 2 · reporting 2 · notifications 2 · responsible 1 · promotions 1 · kyc 1
· jackpot 1 · casino 1 · auth 1 · admin 1

> **Passing automated tests are not evidence that any external service works.**
> Every payments test uses fixtures. No test has ever contacted Paystack,
> Termii or Resend.

---

## 17. Feature-status matrix — phases 1–24

| Phase | Area | Implementation | Tests | Live verification | Blocker |
|---|---|---|---|---|---|
| 1 | Audit + UI foundation | `IMPLEMENTED_UNTESTED` | Partial | No | — |
| 2 | Auth + user account | `VERIFIED_E2E` | Yes | Registration only | Termii/Resend |
| 3 | Admin + RBAC | `VERIFIED_E2E` after B8 | Yes | Seed + login | — |
| 4 | **Wallet + ledger** | `VERIFIED_AUTOMATED` | **Extensive** | QA credit | — |
| 5 | Payments | `IMPLEMENTED_UNTESTED` | Fixtures | **No** | `BLOCKED_BY_KEY` |
| 6 | Sports data | `PARTIALLY_IMPLEMENTED` | Yes | Fixtures only | — |
| 7 | Odds engine + betslip | `PARTIALLY_IMPLEMENTED` | Yes | Parsing only | — |
| 8 | Sportsbook engine | `VERIFIED_AUTOMATED` | Extensive | **No** | No prices |
| 9 | Live + cashout + settlement | `PARTIALLY_IMPLEMENTED` | Yes | **No** | `BLOCKED_BY_CONTRACT` |
| 10 | Livescore/results/stats | `PARTIALLY_IMPLEMENTED` | Partial | No | No results |
| 11 | Casino | `BLOCKED_BY_CONTRACT` | Sandbox | No | Aggregator |
| 12 | Virtuals | `BLOCKED_BY_CONTRACT` | Minimal | No | Provider |
| 13 | Fantasy/Jackpot/Draw | Jackpot `VERIFIED_AUTOMATED`; **Fantasy + Lucky Numbers `NOT_IMPLEMENTED`** | Partial | No | Greenfield |
| 14 | Promotions/bonuses | `VERIFIED_AUTOMATED` | Yes | No | — |
| 15 | Referrals/affiliates | `PARTIALLY_IMPLEMENTED` | Partial | No | — |
| 16 | Pluto AI foundation | `PARTIALLY_IMPLEMENTED` | Yes | No model | `BLOCKED_BY_KEY` |
| 17 | AI betting/financial | `VERIFIED_AUTOMATED` | Yes | No | `BLOCKED_BY_KEY` |
| 18 | AI analysis | `VERIFIED_AUTOMATED` | Yes | No | — |
| 19 | AI RAG + personalization | `PARTIALLY_IMPLEMENTED`; personalization `NOT_IMPLEMENTED` | Partial | No | — |
| 20 | KYC/risk/RG | `PARTIALLY_IMPLEMENTED`; **identity verification `NOT_IMPLEMENTED`** | Yes | Age gate | KYC provider |
| 21 | Notifications/support | `PARTIALLY_IMPLEMENTED` | Partial | No | `BLOCKED_BY_KEY` |
| 22 | Social | `PARTIALLY_IMPLEMENTED` | Minimal | No | — |
| 23 | Analytics/Admin AI | Reporting `VERIFIED_AUTOMATED`; **Admin AI `NOT_IMPLEMENTED`** | Partial | No | — |
| 24 | Security/QA/production | `PARTIALLY_IMPLEMENTED` | Partial | **Deployment unhealthy** | Multiple |

### On percentages

Earlier documents reported "~74% complete", computed as an **unweighted mean of
24 self-assigned phase percentages**. That number is misleading and should not
be used:

- It averages "email verification screen missing" against "no casino provider
  exists" as if they were equal units.
- Self-assigned percentages were assigned by the same process that wrote the
  code.
- It counts an unconnected provider interface as substantial completion.
- **It cannot express that a customer currently cannot place a single bet.**

A truer summary: **the money core is near production quality; the product
around it is a prototype; the deployment is not configured.**

---

## 18. Work waiting only on a key

| Missing key | Provider | Implementation exists | Tests exist | Blocked functionality | Boss must | Developer must afterwards |
|---|---|---|---|---|---|---|
| `PAYSTACK_SECRET_KEY` / `PUBLIC_KEY` | Paystack | Adapter, webhook, payout worker, reservation, caps | Fixtures only | Deposits, withdrawals, payouts | Register company, bank account, Paystack approval | Test-mode deposit → webhook → ledger; then one real ₦100 transfer; register the webhook URL |
| `TERMII_API_KEY` / `SENDER_ID` | Termii | Adapter, OTP service, throttles | Yes | Phone verification, **registration completion** | Buy credits | Verify delivery; confirm rate limits under real latency |
| `RESEND_API_KEY` / `FROM` | Resend | Adapter, email verification route + UI, password reset | Yes | Email verification, password reset | Create account, verify domain | Verify deliverability and bounce handling |
| `SENTRY_DSN` | Sentry | SDK wired | — | Production error visibility | Free account | Verify events arrive; set alert routes |
| AI model key | Anthropic/OpenAI | Registry, guardrails, prediction, draft flow | Yes | Real conversational AI | Choose provider, fund | **Write the adapter**, prompt-injection tests, concurrency tests, budget guard |

**Suggested validation sequence once keys arrive:** Sentry → Termii + Resend
(unblocks registration, so everything else becomes testable by a human) →
Paystack test mode → Paystack live with one ₦100 transfer → AI adapter.

---

## 19. Work waiting on contracts or licensing

| Item | Code that exists | What cannot be proven until signed |
|---|---|---|
| **Paystack approval** | Full adapter + webhook | That any real money can move |
| **Odds/data agreement** | Working adapter, contract tests | `1x2` availability; multi-bookmaker pricing; results coverage |
| **In-play feed** | Live board on conditional polling | That an in-play price can be accepted safely |
| **Casino aggregator** | Provider interface, sandbox adapter, catalogue, lobby, callbacks | Any real game round |
| **Live Casino** | Nav placeholder only | Everything |
| **Virtuals provider** | One service file, events modelled as sportsbook events | Any real round |
| **Bet Builder pricing** | **Nothing** | Everything — needs correlated-leg pricing |
| **KYC provider** | Document storage + hashing | **That any identity is real** |
| **AI provider** | Safety layer + registry | Real model behaviour |
| **Company registration** | — | Paystack, licensing, bank |
| **Settlement bank account** | — | Receiving and paying out |
| **Gaming licence** | Compliance groundwork | Legal operation |
| **Independent certification** | — | RNG/fairness attestation |

---

## 20. Untested work blocked by nothing

**The most actionable section.** None of this needs a purchase or a credential.

| # | Item | Why it is still unfinished |
|---|---|---|
| 1 | **Configure the Railway environment** | Nothing works there without `DATABASE_URL`, `REDIS_URL`, `IDENTITY_PEPPER`, `NEXTAUTH_URL`, `ODDS_API_KEY`. All values already exist locally |
| 2 | **Commit the working tree** | Two launch-blocking fixes (B8, B10) exist only locally. A fresh clone still has the admin deadlock |
| 3 | **Fix B14 — the odds delta job never sends a bookmaker** | A ~2-line defect causing HTTP 400 on every run for the life of the project. **This is the single highest-value fix available.** Nothing external blocks it |
| 4 | **Verify `1x2` from the real feed** | The account permits a second bookmaker; only one was tried |
| 5 | **Place one bet end to end** | Blocked only by #3 |
| 6 | **Verify a database restore** | Neon PITR is untested. *An untested backup is not a backup* |
| 7 | **Regression test for the RBAC bootstrap (B8)** | Fixed manually, never pinned |
| 8 | **Regression test for the odds horizon (B10)** | Same |
| 9 | **DOB backfill** | Needs an owner policy decision first — block, or ask at next login |
| 10 | **Edit bet** | Never started |
| 11 | **Redis `liveVersion` caching** | Query per poll; fine now, wrong at scale |
| 12 | **Load-test homepage, casino callbacks, live-feed polling, AI** | Only bet placement is load-tested |
| 13 | **Casino callback tests via the existing sandbox adapter** | Sandbox exists and is unused for this |
| 14 | **Prompt-injection tests for Pluto AI** | Router is testable today |
| 15 | **Restore + reconciliation runbooks** | Not written |
| 16 | **CI/CD** | **No workflow files exist.** Tests run only when someone remembers |
| 17 | **Delete `rbac-check.mjs`** | Debugging debris in the repo root |
| 18 | **Add `TERMII_*`/`RESEND_*` to `.env.example`** | Documented but absent from the contract |
| 19 | **Schedule `npm run odds:contract`** | Exists; nothing runs it |
| 20 | **Rotate `IDENTITY_PEPPER`** | Possible **only while no real customers exist** |

---

## 21. Completely missing work

Evidence is a source search across `src/**/*.ts{,x}`.

**Missing backend + frontend + tests + provider (fully greenfield):**

| Item | Evidence |
|---|---|
| **Fantasy** | No module; **2 source matches** — navigation entries only |
| **Lucky Numbers** | No module; **3 source matches** — navigation entries only |
| **Bet Builder** | **0 source matches** |
| **Personalization** | **0 source matches** |
| **Admin AI** | **0 source matches** |
| **Live Casino** | Navigation placeholder only |
| **Instant games** | No module |
| **Edit bet** | Not implemented |
| **KYC verification provider** | No verification call anywhere |
| **CI/CD** | No workflow files |

**Missing operational procedures:** restore runbook · reconciliation-after-restore
procedure · incident response · rollback process · on-call/alert routing ·
data-retention policy.

---

## 22. Deployment, operations and disaster recovery

| Item | Status |
|---|---|
| Railway deployment | Live but **unhealthy (503)** |
| Previous `AUTH_SECRET` failure | **Resolved** — now `ok` |
| Health endpoint | **Deployed and working** — correctly reporting three blocking problems |
| Database on Railway | **NOT CONFIGURED** |
| Redis on Railway | **NOT CONFIGURED** |
| Migration execution | Detects Vercel and Railway; warns and skips without an owner URL |
| Runtime role grant | `GRANT app_role … WITH INHERIT TRUE, SET TRUE` — fixed earlier for a PostgreSQL 16 behaviour change |
| Error pages | `global-error.tsx` + `(site)/error.tsx`, pointing at `/api/health` |
| Logging | Console only |
| Sentry | `BLOCKED_BY_KEY` |
| Background jobs | **13** Inngest functions registered; cron schedules present. **Never observed running in production** |
| Settlement stall alert | `VERIFIED_AUTOMATED`; never fired in production |
| Odds contract-test schedule | **Not scheduled** |
| Backups | Neon PITR assumed; **plan not confirmed** |
| **Restoration performed?** | **NO** |
| Acceptable data-loss window | **Not defined** |
| Restore runbook | **Not written** |
| Reconciliation after restore | **Not defined** |
| Rollback process | **Not defined** |
| Incident response | **Not defined** |
| Load test | Bet placement only |
| Production observability | **Effectively none** |

> An available backup feature is not a verified recovery system. Nothing here
> has ever been restored, so the recovery capability of this platform is
> **`UNKNOWN`**.

---

## 23. Contradictions in existing documentation

| Claim | Evidence-based truth |
|---|---|
| "`AUTH_SECRET` is missing" *(status doc §0.1)* | **Stale.** Live health reports `ok`. Fixed by the owner between sessions |
| Suite totals "42" / "44" / "45" | **46 spec files** now; 45 at last baseline; 572 passed / 1 skipped |
| "All 24 phases have implementation" | **Misleading.** Fantasy, Lucky Numbers, Bet Builder, personalization and Admin AI have **0–3 source matches** — navigation entries, not implementations |
| "~74% complete" | Unweighted mean of self-assigned percentages. It cannot express that **no customer can place a bet** |
| "Four purchases turn this from a demo into a business" | **False.** Purchases do not fix: the unconfigured deployment, zero persisted markets, unverified `1x2`, the missing KYC provider, or the untested restore |
| "The boss is the bottleneck, not the developer" | **False as stated.** Item 20 lists twenty developer tasks blocked by nothing at all, including two launch-blocking fixes that are not even committed |
| "Casino/virtuals integrations are built and waiting on a signature" | **Overstated.** Casino has an interface, sandbox and lobby. Virtuals has **one service file** and no provider adapter |
| Fixture tests prove live provider/payment operation | **No.** Every payments test uses fixtures. Nothing has contacted Paystack |
| "Deployment verified" | **No.** Health returns 503; the deployment has no database |

---

## 24. Risk register

| # | Risk | Sev | Likelihood | Mitigation | Remaining action | Owner | Blocks customers? |
|---|---|---|---|---|---|---|---|
| 1 | Real-money loss via ledger error | Critical | **Low** | Double-entry, triggers, role separation, extensive tests | Keep the invariant tests | Dev | No |
| 2 | Incorrect settlement | Critical | **Low** | Deterministic tests; odds locked at placement | Real-match settlement never observed | Dev | **Yes** |
| 3 | Wrong wallet bucket | High | Low | All six queries fixed; regression test | Enforce the bucket rule in review | Dev | No |
| 4 | Duplicate payout | Critical | **Low** | Idempotency + fingerprints; 5× replay test | — | Dev | No |
| 5 | Provider shape change | High | Medium | Contract tests + stall alarm | **Schedule the live contract test** | Dev | **Yes** |
| 6 | **`1x2` unavailable** | **Critical** | **Confirmed** | None | Test a second bookmaker; upgrade plan if needed | Joint | **Yes** |
| 7 | **Zero persisted markets (B14)** | **Critical** | **Confirmed** | None | Pass a bookmaker to /odds/updated | Dev | **Yes** |
| 8 | **Deployment unconfigured** | **Critical** | **Confirmed** | None | Set 5 Railway variables | Boss | **Yes** |
| 9 | Stale live odds | High | Medium | Display-only live betting | Needs in-play feed | Boss | No |
| 10 | Payment chargebacks | High | Unknown | None | Paystack dispute handling | Boss | No |
| 11 | Withdrawal fraud | High | Medium | KYC caps, manual approval, risk signals | **No real identity verification** | Joint | **Yes** |
| 12 | **Unverified KYC identity** | **Critical** | **Confirmed** | Digest only | Integrate a BVN/NIN provider | Boss | **Yes** |
| 13 | Exposed credentials | High | **Confirmed** | Gitignored `.env` | **Rotate all pasted credentials** | Boss | No |
| 14 | **Compromised identity pepper** | **Critical** | **Confirmed** | None | **Rotate NOW — only test identities exist; this window closes permanently** | Joint | No |
| 15 | Database loss | Critical | Low | Neon PITR assumed | **Confirm the plan; perform a restore** | Joint | No |
| 16 | **Untested restoration** | **Critical** | **Confirmed** | None | Restore into a scratch branch and reconcile | Dev | No |
| 17 | Missing monitoring | High | Confirmed | None | Set `SENTRY_DSN` | Joint | No |
| 18 | Load failure | Medium | Unknown | Bet placement load-tested | Test homepage, callbacks, live feed, AI | Dev | No |
| 19 | Licensing | Critical | Confirmed | None | Begin the licence process | Boss | **Yes (legally)** |
| 20 | Provider-contract delays | High | Likely | Honest "not connected" UI | Begin negotiations | Boss | No |
| 21 | AI prompt injection | Medium | Low today | Keyword router cannot be injected | **Test before connecting a model** | Dev | No |
| 22 | **Scope overstatement** | **High** | **Confirmed** | This document | Retire the percentage metric | Joint | No |
| 23 | **Fixes exist only locally** | High | **Confirmed** | None | **Commit and push** | Dev | **Yes** |

---

## 25. Exact remaining work, ordered

### A. The developer can do now — no purchases, no contracts

1. **Commit and push the working tree.** B8 (admin deadlock) and B10 (odds
   horizon) exist only locally. A fresh clone still has an unreachable admin
   panel. *Highest priority — everything else builds on it.*
2. **Configure Railway**: `DATABASE_URL`, `DIRECT_DATABASE_URL`,
   `MIGRATION_DATABASE_URL`, `REDIS_URL` (TCP, not REST),
   `IDENTITY_PEPPER`, `NEXTAUTH_URL`, `ODDS_API_KEY`. Confirm `/api/health`
   returns 200.
3. **Fix B14** — pass a bookmaker to `/odds/updated`. Until this is done
   PlutoBet has no prices and nothing to sell. Then confirm markets and
   selections persist.
4. **Verify `1x2`** — add the second permitted bookmaker, re-run
   `npm run odds:capture`, confirm the market appears.
5. **Place one bet end to end** using `scripts/qa-place-bet.ts`; confirm the
   admin sees it.
6. **Verify a database restore** into a scratch branch and reconcile the ledger.
7. **Add regression tests for B8 and B10.**
8. **Rotate `IDENTITY_PEPPER`** while only test identities exist.
9. **Set up CI** so tests run on every push.
10. Delete `rbac-check.mjs`; add `TERMII_*`/`RESEND_*` to `.env.example`;
    schedule `npm run odds:contract`.
11. Load-test the untested paths; add prompt-injection tests; write the restore
    and incident runbooks.
12. Then the feature backlog: edit bet, `liveVersion` caching, personalization,
    Admin AI, Fantasy, Lucky Numbers.

### B. The boss must do — nobody else can

1. **Register the company** and open a corporate bank account. *Gates Paystack
   and the licence; start immediately.*
2. **Begin the gaming licence process.** The slowest item.
3. **Buy Termii credits and create a Resend account.** Cheap, and until then
   **nobody can complete registration**.
4. **Obtain Paystack approval and live keys.**
5. **Rotate every credential pasted into a chat or ticket** — Neon, Upstash,
   Backblaze, Inngest, odds-api.io.
6. **Contract a KYC/identity provider.** Without it no customer identity is
   verified, whatever the tier code says.
7. **Decide the DOB backfill policy** — block, or ask at next login.
8. **Confirm the Neon plan includes PITR** and set an acceptable data-loss
   window.
9. Create a free Sentry account.
10. Negotiate: casino aggregator · virtuals provider · in-play feed ·
    correlated-leg pricing · AI provider · odds plan upgrade if `1x2` requires
    it.

### C. Joint decisions

1. **Should Fantasy, Lucky Numbers and Bet Builder be in v1 at all?** They are
   fully greenfield. Cutting them from launch is a legitimate, cheap decision.
2. **Beta scope** — a closed beta on sportsbook alone is reachable far sooner
   than a full launch.
3. **Retire the completion percentage** in favour of the status labels used
   here.

---

## Closing assessment

PlutoBet has an unusually strong financial core and an unusually weak
connection to the outside world. The ledger, wallets, concurrency handling and
settlement engine are of a standard many production betting platforms do not
reach, and they are backed by real tests including property-based, chaos and
concurrency suites.

Around that core sits a product that cannot yet complete a single customer
journey. The deployment has no database. No prices exist. The market most bets
are placed on has never been observed. No identity is verified. No money has
ever moved.

The most important finding is not any individual defect. It is that **the two
launch-blocking fixes made during the most recent validation are not committed**,
and that **the deployment nobody can use has been described as working**. The
gap between documented state and evidenced state was, throughout this audit,
consistently in the optimistic direction.

The path forward is not mysterious, and much of it costs nothing. It starts
with committing the fixes, configuring the deployment, and getting one real
price into the database.

---

*Audit performed 2026-08-31 against `main` @ `d14b7e0` with 28 uncommitted
working-tree entries. No secret values, credentials, OTPs or personal data are
included in this document. No production data was modified and no credentials
were rotated during this reporting pass.*
