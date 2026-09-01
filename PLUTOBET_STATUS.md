# PlutoBet — Project Status

> ## HISTORICAL — not the current status
>
> This document records the project status as of 2026-08-27. It is kept as evidence and is **not** the
> current state of the repository.
>
> **For what works today, read [`PROJECT_STATUS.md`](PROJECT_STATUS.md).**
> Where this file disagrees with it, that file is right.
>
> Nothing here has been deleted. Findings that were later resolved are still
> described as they were found, so the trail from defect to fix stays readable.



**Last updated:** 2026-08-27
**Repository:** `github.com/plutobet-ai/plutobet_ai` (also `Madubuezejoshua/plutobet`)
**Branch:** `main` · 12 commits · working tree clean

> This document is organised around **what is left**, not what is done.
> Section 1 is the answer to "what's remaining". Everything after it is evidence.

---

## 0. Where the build stands

| Check | Result |
|---|---|
| Tests | ✅ **572 passing across 45 suites** |
| Typecheck (`tsc --noEmit`) | ✅ Clean |
| Production build (`next build`) | ✅ Clean |
| Migrations | ✅ **24 of 24 applied to Neon** · 60 tables |
| Both git remotes | ✅ Pushed, identical HEAD |
| **Deployed environment** | ⚠️ **See §0.1 — this was never verified until Railway, and it failed** |

### 0.1 Deployment was the untested surface

Everything above passes locally and in CI, and none of it exercised a *deployed*
environment. The first Railway deployment answered **every page with a 500**,
and there was no way to tell from outside whether the database was unreachable,
a migration was missing, or one variable had never been set.

It was the last one: `AUTH_SECRET`. `authOptions.secret` is a getter that
throws, every page reads a session, so a missing secret takes the whole site
down — while static assets and the 404 page keep working, which makes it look
like a partial outage rather than a configuration error.

Three things came out of it, all now in place:

- **`/api/health`** names the failing configuration. Unauthenticated by design
  (a deployment that cannot authenticate anybody is exactly when it is needed),
  and it reports only whether each name is set and usable — never a value.
- **`global-error.tsx`** replaces "A server error occurred" with a page that
  points at `/api/health` and states plainly that no money moved.
- **The build script detected only Vercel.** On Railway, `VERCEL_ENV` is never
  set, so migrations and the `app_role` grant silently did not run. It now
  detects both, prints its target on every build, and warns loudly rather than
  skipping in silence.

A latent bug surfaced with it: `process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET`
kept an **empty string**, because `""` is neither null nor undefined — so a
variable declared in a dashboard but left blank never fell through to the other
name. Fixed and pinned by tests.

**Setup instructions are in [`docs/deployment.md`](docs/deployment.md).**

**All 24 phases of the Master Build Prompt have implementation.**
Unweighted mean across the phase table (§4): **~74%**, up from ~23% at audit.

**Treat that number sceptically.** It averages "email verification UI missing"
against "no casino provider exists", which are not comparable units of work. The
honest version is §1: three of the remaining items are *blocking*, five need a
signed contract, and the rest is a normal backlog.

---

## 1. WHAT IS LEFT

Four groups, ordered by what actually unblocks them.

### 🔴 A — Blocking. The platform cannot serve a real customer.

| # | Item | Consequence today | To close |
|---|---|---|---|
| A1 | **`PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY`** | No deposits, no withdrawals. The money loop is inert | Paystack dashboard → live keys |
| A2 | **One real low-value Paystack transfer, end to end** | The adapter is written against published docs and exercised only by fixtures. It has never moved a real naira | Send ₦100 to a real account, confirm the webhook settles it |
| A3 | **`TERMII_API_KEY` + `RESEND_API_KEY`** | OTP codes print to the server console. **Nobody can register or reset a password** | Buy both; ~₦ trivial |
| A6 | ~~Select bookmakers on odds-api.io~~ | ✅ **Resolved — and my earlier diagnosis was wrong.** The 400 only occurs when `bookmakers` is OMITTED, which the probe script did but the adapter does not. Selection happens implicitly on first use; the plan caps it at **2 bookmakers** (`1xbet` is active). The real fault was the adapter parse — see §3 | Done |
| A4 | **Verify a database restore** | Neon has point-in-time restore. Nothing here has ever restored from it — *an untested backup is not a backup* | Restore to a scratch branch, confirm the ledger reconciles |
| A5 | **Rotate the credentials pasted into chat** | Neon, Upstash, Backblaze, Inngest, odds-api.io are all compromised | Rotate each. **`IDENTITY_PEPPER` cannot be rotated** — every stored identity digest derives from it. Move it to managed secret storage instead |

A4 is the one that gets skipped, and the one that matters on the worst day.
**A6 turned out to be a misdiagnosis on my part**, and chasing it uncovered
something worse: the odds parse produced no prices at all. See §3.

### 🟠 B — Needs a commercial contract. No amount of code closes these.

| Phase | Item | What exists now |
|---|---|---|
| 9 | **Real in-play feed** | Live betting is **display-only**. Prices show; placement is refused. A tappable price the server would reject is worse than no price |
| 11 | **Casino aggregator** | Provider interface, sandbox adapter, catalogue, lobby — the lobby says it isn't connected rather than showing fake tiles |
| 12 | **Virtuals provider** | Rounds are modelled as sportsbook events, so pricing/placement/settlement are already reused |
| 8 | **Bet-builder pricing** | Not implemented. It needs a provider that prices *correlated* legs — naively multiplying odds on the same match is how a book gets arbitraged |
| 13 | **Fantasy + Lucky Numbers** | Not started. Jackpot (the same phase) is complete |
| 16 | **AI model key** | Pluto AI runs a **keyword router**, not a language model. The registry, guardrails and draft flow are built and tested, so this is an adapter swap |

Each of these has its integration built and its UI honestly stating it is not
connected. None is a rewrite — they are waiting on a signature, not a sprint.

### 🟡 C — Buildable now. No external dependency. This is the real backlog.

| # | Item | Phase | Why it matters |
|---|---|---|---|
| ~~C1~~ | ~~Odds provider contract test~~ | 6 | ✅ **Closed.** Real captured responses now pin the parse on every test run, a live opt-in check pins the provider's side, and a production alarm catches a silent settlement stall. **It found a real bug on the first run** — see §3 |
| ~~C2~~ | ~~Email verification UI~~ | 2 | ✅ **Closed.** The OTP service and EMAIL_VERIFY purpose already existed; nothing reached them, so every account had a null email_verified_at. Authenticated route + account-page flow |
| C3 | Edit bet | 9 | Cash-out and resettlement are done; edit-bet is the remaining leg |
| C4 | Backfill dates of birth | 20 | Accounts predating the age gate are *flagged* on their account page but not *blocked* |
| C5 | Cache `liveVersion` in Redis | 9 | The live feed polls conditionally (304 on no change) but still runs a query per poll. Fine now, wrong at scale |
| C6 | Personalisation | 19 | RAG corpus is built; per-user tailoring is not started |
| C7 | Admin AI | 23 | Revenue/customer/alert reporting is built; the AI layer over it is not |
| ~~C11~~ | ~~Admin panel gaps~~ | 3 | ✅ **Closed.** The nav declared 8 pages as built:false — bets, ledger, reconciliation, events, responsible gaming, compliance, casino, promotions. All 8 now exist and every query is verified against the live database by `npm run admin:smoke` |
| ~~C8~~ | ~~Delete `legacy/`~~ | — | ✅ **Closed.** 30 files removed, plus its tsconfig and eslint exclusions. Recoverable from git history |
| C9 | Load-test the untested paths | 24 | Covered: bet placement under contention. **Not covered:** homepage, casino callbacks, live-feed polling at scale, Pluto AI concurrency |
| C10 | `SENTRY_DSN` | 24 | Wired but unconfigured — currently flying blind on production errors |

### ⚪ D — Operational, one-time

- **`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`** then `npm run seed:admin` — there is no admin account yet.
- Decide the acceptable data-loss window and confirm Neon PITR actually meets it.
- Write the restore runbook: who restores, from where, what they check.

---

## 2. What genuinely works

Verified by passing tests, not assumed — several confirmed by driving the running app.

- **Money is never wrong.** Integer kobo (`BIGINT`) end to end. No float in any money path.
- **The ledger cannot be corrupted from application code.** Deferred PostgreSQL triggers reject unbalanced, empty, malformed or cache-divergent commits. The runtime database role *cannot* own or alter ledger tables.
- **Concurrency is safe.** `SELECT … FOR UPDATE` on wallet rows; transfers lock both wallets in UUID order to avoid deadlock. Proven by a suite that races real transactions.
- **Idempotency is real.** Keys carry a SHA-256 request fingerprint, so replaying a key with *different* parameters raises a typed conflict instead of silently succeeding.
- **Odds are locked at placement.** Settlement reads `bet_legs.locked_odds_decimal`, never the current price.
- **Self-exclusion survives re-registration.** Keyed to an HMAC digest of BVN/NIN under a server-held pepper, not to an email address.
- **RG limits are asymmetric.** Lowering applies immediately; raising waits 24 hours.
- **Unverified accounts cannot withdraw.** Tier 0 → ₦0 daily cap, enforced in the service and reflected in the UI.
- **Resettlement never edits history.** It posts compensating entries, and clawback records a *shortfall* rather than inventing a negative balance.
- **Bonus credit cannot be withdrawn.** A database trigger refuses it — not a service check that a future code path could bypass.
- **AI cannot move money.** Draft-only, confirmation plus server-held step-up re-auth. User-scoped tools take **no user id parameter**, asserted by a test that walks the registry.

---

## 3. Hazards worth re-reading before you touch the code

### 🟡 Wallet lookups must always name a bucket

Phase 4 gave each account three wallet rows (CASH / BONUS / LOCKED). Any query
resolving "the user's wallet" by `(user_id, kind, currency)` now matches **three
rows** and takes whichever the planner returns first.

Six such queries existed — deposits, settlement payouts, casino payouts, casino
balance, withdrawal refunds, cash-out — and every one was crediting an arbitrary
bucket. This was not a crash: the ledger stayed balanced, the money just landed
where the customer could not spend it. Fixed and pinned by a regression test.

**Any new query against `wallets` must include `bucket = 'CASH'`.**

### ✅ The odds parse is now guarded — and the guard caught a live bug

Settlement decides won-or-lost from `scores.periods.ft`. That shape had been
checked exactly once, by a human reading probe output. It is now pinned three ways:

| Guard | Catches | Runs |
|---|---|---|
| `provider-contract.acceptance.spec.ts` | *our* parse regressing | every test run |
| The same file's `LIVE` block (`ODDS_LIVE_CONTRACT=1`) | *the provider* changing shape | opt-in — costs API budget |
| `Settlement` operational alert | a stall in production | continuously |

The fixtures under `src/modules/odds/__tests__/fixtures/` are **real captured
responses**, refreshed by `npx tsx scripts/capture-odds-fixtures.ts` (the API key
is scrubbed recursively before anything is written). A fixture hand-typed to
match the code would test nothing but the typist.

**The bug it found immediately:** `sport` arrives as an object `{name, slug}`,
not a string. The adapter did `String(e.sport ?? sport)` — which yields
`"[object Object]"`. That value is truthy and non-empty, so it passed every null
check between the adapter and the database. **Every event ever synced would have
been stored with `sport = "[object Object]"`**, breaking sport browsing and
filtering. Caught before any event was synced, so no data repair was needed.

The third guard matters most. If the provider moves `periods.ft`, ingestion
correctly refuses to record the result — but refusing is *invisible*: the poll
keeps running, throws nothing, and bets sit `PENDING` while customers wait. The
alarm fires when a finished match **with pending bets on it** has had no result
for six hours, and names the provider shape as the place to look.

### 🔴 The odds parse produced NO prices — found and fixed

Chasing the bookmaker question uncovered the real fault. `normaliseBook()` was
the last function in the adapter still written from published docs and never
checked — because `scripts/probe-odds.ts` called `/odds` **without** a
`bookmakers` parameter, got a `400`, and stopped there. The real response
differs at every level:

| Adapter expected | Feed actually sends |
|---|---|
| `bookmakers` as an array | **object keyed by bookmaker name** |
| `markets` as an object map | **array of `{name, updatedAt, odds[]}`** |
| selections as `{name, odds}` objects | **rows where `hdp` is the line and every other key is a selection** |
| prices as numbers | **strings** — `"1.584"` |

`asArray()` on an object returns `[]`, so every snapshot came back with zero
books. **Silent, and indistinguishable from a quiet market** — which is why it
survived until a real response was finally captured.

Fixed and pinned. The same fixture that used to yield nothing now parses **77
selections across 3 markets**: `double_chance`, `handicap` (32 lines) and
`over_under` (42 lines).

The canonical mapper was already correct and was left alone: `Corners Totals`
maps to `null` rather than colliding with goal totals, so a corners bet can
never settle against the goal count. A test now pins that too.

**Still unverified:** `1x2` did not appear in this bookmaker's response, so the
match-result market — the most commonly bet one — has not been seen in a real
payload. Worth confirming against a second bookmaker before launch.

---

## 4. Phase-by-phase

| # | Phase | % | Remaining |
|---|---|---|---|
| 1 | Project Audit + UI Foundation | **100%** ✅ | — |
| 2 | Authentication + User Account | **90%** ✅ | Email verification UI (C2) |
| 3 | Admin Platform Foundation | **85%** ✅ | First admin account (D) |
| 4 | **Wallet + Immutable Ledger** | **100%** ✅ | — |
| 5 | Payments, Deposits, Withdrawals | **85%** ✅ | Live keys + one real transfer (A1, A2) |
| 6 | Sports Data Foundation | **80%** ✅ | Provider contract test (C1) |
| 7 | Odds Engine + Betslip | **85%** ✅ | — |
| 8 | **Sportsbook Betting Engine** | **90%** ✅ | Bet builder — needs correlated pricing (B) |
| 9 | Live Betting + Cashout + Settlement | **80%** | Real in-play feed (B), edit bet (C3), cache (C5) |
| 10 | Livescore + Results + Statistics | **75%** ✅ | — |
| 11 | Casino + Live Casino | **65%** | Aggregator contract (B) |
| 12 | Virtuals + Instant Games | **55%** | Provider contract (B) |
| 13 | Fantasy + Jackpot + Draw | **40%** | Jackpot done. Fantasy + Lucky Numbers not started (B) |
| 14 | Promotions + Bonuses + Loyalty | **70%** ✅ | — |
| 15 | Referrals + Affiliates | **70%** | — |
| 16 | **Pluto AI Foundation** | **75%** | Model API key (B) |
| 17 | Pluto AI Betting + Financial Actions | **70%** | — |
| 18 | AI Match Analysis + Prediction | **70%** | — |
| 19 | AI RAG + Personalization | **60%** | Personalisation (C6) |
| 20 | KYC + Risk + Fraud + Responsible Gaming | **85%** | DOB backfill (C4) |
| 21 | Notifications + Support | **65%** | Termii/Resend keys (A3) |
| 22 | Social + Community | **50%** | — |
| 23 | Analytics + Admin AI + Monitoring | **60%** | Admin AI (C7), Sentry DSN (C10) |
| 24 | Security, Reconciliation, QA, Production | **70%** | **Verified restore (A4)**, load tests (C9) |

Detail on 24 is in [`docs/security-review.md`](docs/security-review.md).

---

## 5. Product areas

**14 live:** Home · Sports · Live · Jackpot · Casino · Virtuals · Livescore ·
Results · Promotions · Rewards · Pluto AI · My Bets · Wallet · Account

**3 planned, and the UI says so:** Live Casino · Fantasy · Lucky Numbers

`src/lib/navigation.ts` is the single source of truth. Its `status` flag drives
the placeholders, so an unfinished area cannot silently look finished — and
Pluto AI navigates by key, never by inventing a URL.

---

## 6. Stack

| Layer | Technology | Version |
|---|---|---|
| Framework | Next.js (App Router) | 16.3.2 |
| Runtime | React / React DOM | 19.2.8 |
| Language | TypeScript (`strict`) | 5.9.3 |
| ORM | Drizzle ORM | 0.45.2 |
| Driver | postgres-js | 3.4.5 |
| Database | PostgreSQL (Neon) — pooled + unpooled, deliberately separated | — |
| Cache / limits | Redis (Upstash) via `ioredis` — TCP, **not** REST | 5.11.1 |
| Background jobs | Inngest — 13 registered functions | 4.18.1 |
| Auth | NextAuth (Auth.js), JWT sessions | 4.24.15 |
| Password hashing | argon2id | 0.45.1 |
| Validation | Zod | 4.1.5 |
| Object storage | AWS SDK S3 → Backblaze B2 | 3.1116 |
| Errors | Sentry (**DSN unset**) | 10.70.0 |
| Styling | Tailwind CSS | 4.1.14 |
| Testing | Vitest + fast-check, real embedded Postgres + Redis | 3.2.7 |

**246 source files · 42 test suites · 36 pages · 24 API routes · 23 modules · 24 migrations**

### Two decisions worth knowing

**Realtime is a conditional-poll transport, not SSE or WebSockets.** On Vercel
every open stream holds a serverless invocation for its whole lifetime. The live
board polls with ETags and costs a 304 when nothing has changed.

**No AI SDK is installed.** Pluto AI's registry, guardrails, prediction
arithmetic and draft flow are complete and tested. The model itself is an
adapter behind an interface — deliberately, so the safety layer is not
entangled with a vendor.

---

## 7. Environment variables

**Configured:** `DATABASE_URL` · `DIRECT_DATABASE_URL` · `MIGRATION_DATABASE_URL` ·
`APP_DATABASE_ROLE` · `REDIS_URL` · `AUTH_SECRET` · `NEXTAUTH_URL` ·
`IDENTITY_PEPPER` · `ODDS_API_KEY` · `B2_ENDPOINT` · `B2_REGION` · `B2_BUCKET` ·
`B2_KEY_ID` · `B2_APPLICATION_KEY` · `INNGEST_EVENT_KEY` · `INNGEST_SIGNING_KEY` ·
`UPSTASH_REDIS_REST_URL` · `UPSTASH_REDIS_REST_TOKEN`

**Still required:**

| Variable | Blocks | Group |
|---|---|---|
| `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY` | **All deposits and withdrawals** | A1 |
| `TERMII_API_KEY` / `TERMII_SENDER_ID` | SMS OTP delivery | A3 |
| `RESEND_API_KEY` / `RESEND_FROM` | Email delivery | A3 |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | First admin account | D |
| `SENTRY_DSN` | Production error visibility | C10 |
| Casino / virtuals / fantasy provider credentials | Phases 11, 12, 13 | B |
| AI model API key | Phase 16 | B |

### ⚠️ Credential hygiene

Neon, Upstash, Backblaze, Inngest and odds-api.io credentials were pasted into a
chat transcript during setup. **Rotate them before real user data exists.**

`IDENTITY_PEPPER` is the exception — it *cannot* be rotated, because every stored
identity digest derives from it. Rotating it would silently break self-exclusion
enforcement for every existing account. Move it to managed secret storage instead.

---

## 8. Compliance with the Master Build Prompt's rules

| Rule | Status |
|---|---|
| 7 — Security before convenience | ✅ All authoritative decisions server-side |
| 8 — No floating-point money | ✅ Integer kobo throughout |
| 9 — Database transactions | ✅ Atomic, with rollback, DB-enforced |
| 10 — Idempotency | ✅ With fingerprinting — exceeds the requirement |
| 11 — Provider abstraction | ✅ Odds, payments, casino, virtuals, SMS, email, AI |
| 12–16 — AI rules | ✅ Registry, no dynamic dispatch, draft-only money actions, arithmetic probabilities |
| **Prohibited: fake wallet balance** | ✅ Never |
| **Prohibited: trust frontend payment** | ✅ Webhook-verified, HMAC over the raw body |
| **Prohibited: negative balance race** | ✅ Structurally prevented |
| **Prohibited: plain-text passwords** | ✅ argon2id |
| **Prohibited: duplicate webhooks** | ✅ Idempotent |
| **Prohibited: support = super admin** | ✅ Enforced and tested |
| **Prohibited: unmarked mock data** | ✅ Sandbox providers labelled, and refuse to boot in production |

---

## 9. Bottom line

The parts that are **hard to fix later** — money integrity, concurrency,
settlement, audit trail, AI permission boundaries — are done, and done properly.

What remains is mostly **not engineering risk**. Group A is five errands. Group B
is six signatures. Group C is a normal backlog, of which only C1 carries real
consequence.

Nothing built so far needs to be thrown away.

**If you do only three things: A1 (Paystack keys), A3 (Termii + Resend), A4
(verify a restore).** The first two turn the platform from a demo into a
business; the third is what you will wish you had done.
