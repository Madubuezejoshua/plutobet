# PlutoBet — Core Sportsbook Flow: Implementation & Validation

> ## STATUS: SUPERSEDED IN PART
>
> **For what works today, read [`PROJECT_STATUS.md`](PROJECT_STATUS.md)**, which is
> the single source of truth. This document remains historical evidence.
>
> This document records the pass that got the first real bet placed and
> settled. It is kept as historical evidence and is **not** the current state
> of the repository. Where it is out of date, the newer figures are here:
>
> | This document says | Current truth | Where |
> |---|---|---|
> | Migrations 24 | **26** (0024 heartbeats, 0025 poll fairness) | `DEVELOPER_COMPLETION_REPORT.md` §7 |
> | Stage 7 HTTP/RBAC `NOT_IMPLEMENTED` | **Complete** — 27 tests across four areas | §9 |
> | Stage 9 fixture-sync `NOT_IMPLEMENTED` | **Batched**; target not demonstrated, limiting factor documented | §11 |
> | Registered scheduler untested | **9 acceptance tests** drive the real handler | §6 |
> | Defect 6 (poll starvation) open | **Fixed**, 7 tests | §8 |
> | Defect 1 (non-ASCII team keys) open | **Fixed**, 33 tests | §10 |
>
> **The real match result and ₦600 payout were genuine, but the earlier
> settlement services were manually invoked through QA scripts. Automatic
> scheduling is validated separately** — see `DEVELOPER_COMPLETION_REPORT.md`
> §6, where the registered Inngest function is driven end to end.
>
> Nothing here has been deleted. Findings that are now resolved are marked
> above rather than removed, so the trail from defect to fix stays readable.


**Objective:** move from *"real fixtures exist, zero markets stored, no real-provider
bet ever placed"* to a proven journey:
**Register → admin sees user → ingest real odds → persist markets → QA credit →
place bet → admin sees bet → monitor real settlement.**

No secret values, credentials, OTPs or personal data appear in this document.

---

## 1. Starting commit and working-tree state

| | |
|---|---|
| Branch | `main` |
| Starting commit | `d14b7e05be9b2f1226c4053377c0fab9d0afcd39` |
| Working tree at start | **NOT clean — 28 entries** (10 modified, 18 untracked) |
| Both remotes at start | `origin` and `plutobet` both at `d14b7e0` |

---

## 2. Files reviewed and classified (Stage 1)

| Classification | Files |
|---|---|
| **Intentional production change** | `scripts/deploy-build.mjs`, `scripts/grant-app-role.ts`, `scripts/seed-admin.ts`, `src/modules/admin/navigation.ts`, `src/modules/odds/sync.service.ts`, `src/modules/wallet/errors.ts`, `src/modules/wallet/wallet.service.ts`, `package.json`, 9 × `src/app/admin/*` |
| **Intentional QA/test utility** | `scripts/qa-credit.ts`, `scripts/qa-odds-sync.ts`, `scripts/qa-place-bet.ts`, `scripts/qa-register.ts`, `scripts/smoke-admin.ts`, `scripts/push-env-railway.ts`, `src/modules/wallet/__tests__/contention.acceptance.spec.ts` |
| **Documentation / report** | `GPT.md`, `PLUTOBET_CORE_FLOW_VALIDATION.md`, `PLUTOBET_STATUS.md` |
| **Debugging debris** | `rbac-check.mjs` |
| **Secret / environment** | None in the tree — `.env` is gitignored (`git check-ignore` confirmed) |
| **Unknown** | None |

### Existing changes verified and preserved

All ten pre-existing changes were inspected and kept:

1. `WalletContentionError` with `55P03`/`40P01` mapping — **preserved**, walks the
   Drizzle `cause` chain
2. `WALLET_LOCK_TIMEOUT` pattern validation — **preserved** (interpolated into
   `SET LOCAL`, so the guard matters)
3. Corrected concurrency acceptance test — **preserved**
4. First-admin `SUPER_ADMIN` bootstrap — **preserved and extracted** to a testable
   module (see §5)
5. Bounded 14-day odds horizon — **preserved**
6. Skipping already-settled fixtures — **preserved**
7. Corrected admin SQL column names — **preserved**
8. New admin guards and pages — **preserved**
9. QA scripts — **preserved**
10. `rbac-check.mjs` — **deleted** (see §4)

Nothing was reset, reverted or force-checked-out.

---

## 3. Debugging files removed

**`rbac-check.mjs`** — 14 lines, unreferenced anywhere in `src/`, `scripts/` or
`package.json`, and containing no unique logic (it only called
`rbacService.identify` and printed the result). Its purpose is now served
properly by the bootstrap regression suite. Deleted.

---

## 4. Regression tests added — 37 total

| Suite | Tests | Covers |
|---|---|---|
| `src/modules/admin/__tests__/bootstrap.acceptance.spec.ts` | **8** | Admin bootstrap deadlock |
| `src/modules/odds/__tests__/sync-horizon.acceptance.spec.ts` | **10** | Odds horizon + missing bookmaker |
| `src/modules/notifications/__tests__/otp-production-guard.acceptance.spec.ts` | **6** | Production verification bypass |
| `provider-contract.acceptance.spec.ts` (extended) | **+4** | `ML` → `1x2`, three-way proof |
| `src/modules/wallet/__tests__/contention.acceptance.spec.ts` (pre-existing) | 3 | Lock contention |
| **Previously added odds price contract** | 6 | Price parsing |

### Admin bootstrap — all required cases proven

- ✅ A fresh database with no super admin can seed the first admin
- ✅ The first admin receives **exactly one** `SUPER_ADMIN` grant
- ✅ Running the seed repeatedly is idempotent (3 runs → 1 grant)
- ✅ A deliberately revoked grant is **not** re-elevated
- ✅ A **second administrator cannot self-promote** via the bootstrap
- ✅ Advisory-lock protection holds under a race (2 concurrent → 1 grant)
- ✅ The audit reason and accountable grantor are recorded
- ✅ A non-admin account is refused

### Odds horizon — all required cases proven

- ✅ `syncFixtures` sends a bounded `to`
- ✅ Bounded to ~14 days (asserted 13.9–14.1)
- ✅ Already-settled fixtures skipped (5 in → 2 upserted)
- ✅ **Exactly one** provider call — cannot paginate into the full catalogue
- ✅ Terminates cleanly on an empty response
- ✅ Provider failure surfaces rather than returning an empty success
- ✅ No test requires a real key; the live check stays behind `ODDS_LIVE_CONTRACT`

---

## 5. Root cause of zero persisted markets

**Two independent defects**, both silent.

### Defect A — the delta job never sent a bookmaker

`sync.service.ts` called:

```ts
this.provider.getUpdatedSince(since, { sport: this.config.sport })
```

`/odds/updated` **requires** a `bookmaker`. The adapter forwarded
`bookmaker: undefined`, the URL builder omitted it, and the provider answered:

```
400 {"error":"Missing bookmaker parameter"}
```

The call throws, so `persist()` on the next line **never executed** — on any run
since the job was written. `guard()` re-raises anything that is not an
`OutOfBudgetError`, so nothing swallowed it, but nothing acted on it either.

**The fallback could not save it:** `fullRefreshWatchlist()` runs only when
`getUpdatedSince` returns `null`. It *threw*, so that branch was unreachable.

**What hid it:** the provider takes a singular `bookmaker`; `SyncConfig` holds a
plural `bookmakers` array. The two were never reconciled.

### Defect B — the configured bookmaker name was invalid

`SyncConfig` read `bookmakers: ["bet365", "1xbet"]`. The provider rejects that
outright:

```
bet365 is not a valid bookmaker, use /v3/bookmakers to get a list
```

The real name is **`Bet365`**. It sat in position 0 — the canonical price slot —
so fixing Defect A alone would have failed on this instead.

---

## 6. Exact fix

| File | Change |
|---|---|
| `src/modules/odds/sync.service.ts` | Pass `this.config.bookmakers[0]` to `getUpdatedSince`; throw a clear error if none is configured |
| `src/inngest/functions/odds-sync.ts` | `["bet365","1xbet"]` → `["Bet365","1xbet"]`, with the reason documented in place |
| `src/modules/odds/sync.service.ts` | Expose `refreshWatchlist()` — the delta returns only what *moved*, so an empty board can never fill itself |

`refreshWatchlist()` is the substantive addition: a database with no prices stays
empty forever under a delta-only strategy, because nothing has changed relative
to a cursor that has never seen anything.

---

## 7. Real bookmakers tested

| Bookmaker | Valid name | 1x2 / match result | Notes |
|---|---|---|---|
| `1xbet` | ✅ | ❌ **Not offered** | Double Chance, Spread, Totals, European Handicap, Corners ×4, Correct Score |
| `bet365` | ❌ **invalid** | — | Rejected by the provider; wrong case |
| `Bet365` | ✅ | ✅ **`ML`** | Plus Draw No Bet, Double Chance, Totals, HT/FT, Correct Score and more |

Plan allows exactly **2**; both slots are now in use.

---

## 8. Was `1x2` found? — **YES**

Bet365 publishes the match-result market as **`ML`**, and it is genuinely
three-way. From a real captured payload:

```
ML          : {"home":"2.000","draw":"3.600","away":"3.000"}
Draw No Bet : {"home":"1.533","away":"2.375"}
```

- `mapMarketKey` already mapped `"ml"` → `"1x2"`; **no vocabulary change was
  needed**.
- Draw No Bet is correctly a **separate two-way market** and is dropped rather
  than folded into `1x2` — pinned by a test, because mapping a two-way market
  onto `1x2` would settle every draw as a loss for both sides, silently.
- Fixture `src/modules/odds/__tests__/fixtures/odds-bet365-1x2.json` (2,551
  bytes) was recursively scrubbed and verified to contain no API key.

---

## 9. Events, markets and selections persisted

| Metric | Count |
|---|---|
| Events stored | **547** |
| Upcoming (`PENDING`, future) | **159** |
| Bookmaker snapshots | **25** (25 distinct events) |
| **Markets** | **103** |
| — of which `1x2` | **25** |
| **Selections** | **497** |
| Open selections | **497** |
| Selections with price ≤ 1.0 | **0** |
| Orphan markets / selections | **0 / 0** |
| `sport = '[object Object]'` | **0** |

Market keys: `1x2`(25), `double_chance`(24), `over_under`(24), `handicap`(24),
`btts`(6). Unsupported markets (Corners ×4, European Handicap, HT/FT variants,
Correct Score) are correctly **dropped, not guessed**.

---

## 10–12. Registration over HTTP, and admin visibility

Driven through `POST /api/auth/otp` → `POST /api/auth/register` — the real
public routes, not the service.

| Check | Result |
|---|---|
| `POST /api/auth/otp` | **HTTP 200**, dev code issued |
| Underage registration | **HTTP 403 refused** |
| `POST /api/auth/register` | **HTTP 201** |
| Duplicate email | **HTTP 409 refused** |
| Inserted directly into Postgres? | **No** |
| Wallet rows created | `BONUS=0 CASH=0 LOCKED=0` |
| Opening balance | **0 kobo, 0 ledger entries** |
| Password hashing | `$argon2id$v=…` |
| Phone verified | **true** — a real OTP was consumed |
| **Appears in `/admin/users`** | **YES** — ACTIVE, kyc 0, phoneVerified true |

**Verification honesty:** the one-time code came from the console-provider dev
path, which is returned only when no SMS vendor is configured. Termii and Resend
remain `BLOCKED_BY_KEY`; **no real SMS or email was delivered**. That path is
now refused outright in production — see §17, Defect D.

---

## 13. QA credit ledger evidence

| Item | Value |
|---|---|
| Method | `scripts/qa-credit.ts` → `walletService.credit` |
| Direct SQL balance update? | **No** — none exists anywhere in the script |
| Amount | 20,000 kobo (₦200) |
| Bucket | **CASH** (BONUS 0, LOCKED 0) |
| Reason | `QA_VALIDATION_CREDIT` |
| Before → after | 0 → 20,000 kobo |
| Double entry | `DEBIT ADJUSTMENTS_EQUITY 20000` / `CREDIT USER CASH 20000` |
| Idempotent replay | Same key → `idempotent: true`, balance unchanged |
| Conflict on reuse | Same key + different amount → typed conflict |
| Guards | Refuses `NODE_ENV=production`; requires `ALLOW_QA_CREDIT=true`; rejects non-integer kobo |

> **This is not a deposit.** Paystack was not involved and nothing here says
> anything about the payment gateway.

---

## 14–18. Real bet placement

Placed through `POST /api/bets` with a genuine NextAuth session cookie obtained
from the credentials callback — the same path the betslip uses.

| Field | Value |
|---|---|
| Event | Dinthar FC v Saikhamakawn FC |
| League | India — Mizoram Premier League |
| Provider event ID | `73802362` |
| Internal event ID | `7581501d-a662-4fd5-875c-81c322babeb9` |
| Kick-off | `2026-09-01T06:00:00.000Z` |
| Market / selection | `1x2` → `away` |
| **Locked odds** | **3.000** |
| Stake | 20,000 kobo |
| **Potential payout** | **60,000 kobo** |
| Bet ID | `2db720ac-2d77-4cf7-9e49-2817e75eefe8` |
| CASH before → after | **20,000 → 0** |
| Status | **`PENDING`** |
| Placed at | `2026-09-01T00:54:00.075Z` |

**The stake left the available balance at placement**, not at settlement.

### Admin visibility of the bet — confirmed

The `/admin/bets` query returns event, league, market, selection, stake, locked
odds, potential payout, placement timestamp, status and the linked ledger
transaction.

### Ledger for this account

```
ADJUSTMENT  CREDIT  20000  CASH
STAKE       DEBIT   20000  CASH
```

---

## 19. Real settlement — **the bet WON on a real result, settled MANUALLY**

> **CORRECTION (added later).** This section originally read as though the bet
> settled on its own. It did not. The **result and the payout arithmetic were
> entirely genuine** — the provider reported the score, the production resolver
> decided the outcome, and the ledger moved real entries — but the settlement
> services were **invoked by hand** through `scripts/qa-settle-run.ts` and
> `scripts/qa-settle-one.ts`.
>
> `pollMatchResults` is an Inngest cron, Inngest was not running locally, and
> the deployment has no database, so that job had **never executed once**.
> Automatic settlement is addressed in `DEVELOPER_COMPLETION_REPORT.md` §6 and
> is classified `IMPLEMENTED_NOT_LIVE_TESTED` — the scheduler now exists and
> can be started, but has not been observed settling a bet unattended.

The match finished while this work was in progress and the bet was settled by
the production services. **No score was invented and no status was written by
hand.**

### The result

| | |
|---|---|
| Match | Dinthar FC **0 – 3** Saikhamakawn FC |
| Provider event ID | `73802362` |
| Internal event ID | `7581501d-a662-4fd5-875c-81c322babeb9` |
| Bet ID | `2db720ac-2d77-4cf7-9e49-2817e75eefe8` |
| Provider status | `settled` |
| Regulation score (`scores.periods.ft`) | `{"home":0,"away":3}` |
| Market / selection | `1x2` → `away` @ **3.000** |
| Bet status | `PENDING` → **`WON`** (settled `2026-09-01T11:26:11Z`) |
| Stake | 20,000 kobo |
| **Expected payout** | 20,000 × 3.000 = **60,000 kobo** |
| **Actual payout** | **60,000 kobo** — exact |
| CASH balance | 0 → **60,000** |
| Payout transactions for this bet | **1** |

### Ledger for the QA account

```
ADJUSTMENT  CREDIT  20000  CASH     <- QA funding (NOT a deposit)
STAKE       DEBIT   20000  CASH     <- removed at placement
PAYOUT      CREDIT  60000  CASH     <- winnings
```

Global ledger **balanced** (120,000 debits = 120,000 credits), **0** negative
balances, **0** flagged wallets, **exactly one** payout transaction for the bet.

### How it was settled, and what that required

`pollMatchResults` is an Inngest cron job. **Inngest is not running locally and
the deployed environment has no database**, so nothing had ever polled for
results — the settlement pipeline had never executed even once in this project's
life. The chain was driven manually in the order the jobs use it, via
`scripts/qa-settle-run.ts`:

```
ResultIngestionService.pollFinishedEvents()    ingest the provider result
settlementService.findPendingBetIds(eventId)   find what is riding on it
settlementService.settleBet(betId)             resolve and pay
settlementService.closeEventMarkets(eventId)   stop further placement
```

Four full poller runs ingested results for **27 events** but never reached ours,
which exposed a new defect — see §30, Defect 6. The bet was then settled with
`scripts/qa-settle-one.ts`, using the same services against the same real
provider payload. The only thing skipped is the poller's FIFO queue position,
which is a scheduling property rather than a settlement one.

---
## 20. Deterministic win/loss/void tests

Unchanged and still passing, from
`src/modules/settlement/__tests__/settlement.acceptance.spec.ts`:

| Case | Result |
|---|---|
| Winning — replaying the feed 5× pays **exactly once** | PASS |
| Losing — settles with **0** payout legs | PASS |
| Void — stake returned exactly once, no profit | PASS |
| Accumulator with a void leg recalculated at 1.0 | PASS |
| Exposure released on settlement | PASS |

> These are **sanitized fixture tests**. They do not prove the real bet above
> settled, and they are not presented as doing so.

---

## 21. Ledger reconciliation

| Check | Result |
|---|---|
| Global debits vs credits | **60,000 = 60,000 — BALANCED** *(snapshot taken BEFORE settlement)* |
| Wallets with a negative balance | **0** |
| Wallets flagged by reconciliation | **0** |
| Bets without a stake debit | **0** |

> **On the two different totals in this document.** §19 reports 120,000 and
> this section reports 60,000. Both queries were global and identical in
> scope; the difference is purely WHEN each was taken. This snapshot predates
> the 60,000-kobo payout. The authoritative figure after settlement is
> **120,000 debits = 120,000 credits**, and every transaction carries exactly
> two legs. See `DEVELOPER_COMPLETION_REPORT.md` §5 for the full transaction
> list.

---

## 22. Negative-test results

Run over HTTP against the **real persisted market**:

| Test | Result |
|---|---|
| Stake above balance | ✅ HTTP 409 `NOTHING_PLACED` |
| Zero stake | ✅ HTTP 422 `INVALID_REQUEST` *(was 500 — see Defect E)* |
| Stale odds | ✅ HTTP 409 `NOTHING_PLACED` |
| Duplicate submit, same key | ✅ Same `betId` — one bet only |
| Same key, different stake | ✅ HTTP 409 conflict |
| Wallet bucket resolution | ✅ `walletForUser` filters `bucket = 'CASH'` |

### NOT TESTED in this pass — stated plainly

*All four were closed afterwards, in commit `3302e03` — 27 tests. Status added
per item; the original wording is unchanged.*

- ❌ **Two concurrent ₦200 placements over HTTP.** Covered at service level by
  the 100-way wallet hammer, **not** at the route level as the task specified.
  → **NOW TESTED.** Driven through the route handler and repeated five times,
  because a race that only sometimes loses is a race that passes once and ships.
- ❌ **Closed / suspended market rejection** against the real persisted market.
  → **NOW TESTED** — against `SETTLED`, `VOID` and `SUSPENDED`. There is no
  `CLOSED` status; a first draft asserted one that does not exist.
- ❌ **A normal user cannot invoke QA funding** — the script is environment-gated,
  but no test asserts a customer cannot reach it.
  → **NOW TESTED**, architecturally: nothing in the shipped bundle imports the
  QA credit script or reads `ALLOW_QA_CREDIT`, and no non-admin actor can create
  an `ADJUSTMENT`.
- ❌ **Support staff cannot perform super-admin settlement actions** — RBAC
  separation is covered by existing admin tests, but not re-verified here.
  → **NOW TESTED**, including the **positive** case — a guard that denies
  everyone passes every negative test. Two of these initially passed vacuously
  on a 500 (a crash creates no grant either); they now assert the status.

---

## 23–27. Verification totals

| Check | Result |
|---|---|
| TypeScript typecheck | **exit 0 — clean** |
| Full Vitest suite | **49 files · 603 passed · 1 skipped · 604 total · exit 0** |
| Production build | **exit 0 — clean** (a first attempt failed on a stale `.next/lock` left by the dev server, not on code) |
| Skipped tests | **1** — the opt-in live provider contract (`ODDS_LIVE_CONTRACT`), **not counted as passing** |
| Todo tests | 0 |
| Migrations | 24 of 24 applied |
| Admin smoke (`npm run admin:smoke`) | 18/18 queries clean (last run) |

*Those were the figures for THIS pass. The suite has since grown to
**56 files - 712 passed - 1 skipped**, migrations to **26**, with the build and
typecheck still clean - see `DEVELOPER_COMPLETION_REPORT.md` section 17.*

---

## 28–29. Commits and push

The work described in this document was committed at the time. The **follow-up**
round — the one that resolved most of section 30 — is seven further commits on
`main`, range `c526a1d..0e7f659`:

| Hash | Commit |
|---|---|
| `3603997` | Use one money formatter, and stop losing the minus sign |
| `f2f19a3` | Make settlement run on a schedule, and stop it starving newer events |
| `3cd03f1` | Stop a stray accent from silently unlisting a club |
| `3302e03` | Test the money routes through HTTP, and set AUTH_SECRET for tests |
| `c5efe34` | Batch fixture upserts, and measure the sync instead of guessing |
| `a4261fa` | Run the scheduler locally, and make QA credit accountable |
| `0e7f659` | Report what was done, and correct what the last report overstated |

**Nothing has been pushed.** Thirteen commits sit ahead of `origin/main` awaiting
authorisation. Full per-commit contents and the pre-commit secret scan are in
`DEVELOPER_COMPLETION_REPORT.md` section 19.

---

## 30. Remaining blockers

### Engineering — original findings, with current status

Kept verbatim. The status column is what changed afterwards; nothing has been
deleted, so the trail from defect to fix stays readable.

| # | Defect | Impact | Status |
|---|---|---|---|
| 1 | **Team key rejects non-ASCII names** | `CD O´Higgins` → key `cd-o´higgins` violates `teams_key_format`. Classification is best-effort so ingestion continues, but affected fixtures are never classified onto the sports hierarchy — losing competition browsing and head-to-head data. Affects South American, Iberian and Turkish clubs | **FIXED** `3cd03f1`. The cause was narrower than "non-ASCII": U+00B4 is a *spacing* modifier, so NFD never decomposed it. Now anything outside `[a-z0-9-]` is dropped rather than enumerated, with a deterministic SHA-256 fallback for wholly non-Latin names. 33 tests |
| 2 | **`NEXTAUTH_URL` unset on Railway** | Sign-in callbacks point at `http://localhost:3000` | **OPEN** — `BLOCKED_BY_OWNER_CONFIGURATION`. Owner action, see section 31 |
| 3 | **Railway has no database, Redis or `IDENTITY_PEPPER`** | The deployment cannot serve a customer at all | **OPEN** — `BLOCKED_BY_OWNER_CONFIGURATION`. Owner action, see section 31 |
| 4 | **`syncFixtures` is slow** | ~775 upcoming events × (upsert + taxonomy) is minutes per run, sequential | **PARTIAL** `c5efe34`. Upserts now batch 50 to a statement and taxonomy is memoised per run. The **3× target is not demonstrated**: the dominant cost turned out to be the per-event classification transaction, which still runs once per event over the network. Batching classification is the remaining lever |
| 5 | **QA credit writes no admin audit row** | Runs as `SYSTEM`; acceptable for a gated QA script, not as a pattern for real adjustments | **FIXED** `a4261fa`. The audit row is appended on the *same* transaction as the ledger entries — one that could commit without the other would make the trail look complete when it is not |
| 6 | **Result polling can starve newer events (NEW)** | `pollFinishedEvents` takes the **20 oldest** unresolved events per tick, FIFO. Fixtures the provider never scores — the queue head was Welsh amateur football 22 hours old — stay in that queue and are re-fetched every run. The QA bet's event sat **59th of 60** and four full runs (~80 provider calls) never reached it. The queue does drain (60 → 40), so it is throttling rather than deadlock, but with a 14-day horizon pulling in hundreds of unscored lower-league matches, a newer event can wait a long time behind them while its bets sit `PENDING`. **Not fixed** — it needs a deliberate policy (age out unresolvable events, or prioritise events that actually have bets on them) rather than a quick change | **FIXED** `f2f19a3`, via the second option. Events with a pending bet sort first, and each event carries its own `result_next_poll_at` so an unscored fixture backs off from 5 minutes to a daily cap. An event is **never** marked resolved for lack of a score — only deferred, because a provider briefly missing data must not become a permanently unsettled bet. 7 tests |
| 7 | **The settlement pipeline has never run on its own (NEW)** | Inngest is not running locally and the deployment has no database, so `pollMatchResults` had never executed. Settlement works — proven above — but nothing is currently scheduled to trigger it anywhere | **LARGELY FIXED** `f2f19a3` + `a4261fa`. `npm run dev:all` now starts Inngest alongside Next — the missing piece — and a durable heartbeat records every run, so "ran and found nothing" is distinguishable from "did not run"; the alert fires when a job has *never* succeeded, which was this deployment's actual state. 9 acceptance tests drive the **registered** function end to end. Still `WAITING_ON_REAL_EVENT` for an unattended live run |

### External

Paystack (deposits/withdrawals) · Termii (SMS) · Resend (email) · KYC identity
provider · casino aggregator · virtuals provider · in-play feed · LLM key ·
gaming licence.

---

## 31. Safe credential-rotation order

**Not performed.** No credential was rotated, and no exposed value was copied
into Railway.

Only **test identities** exist: every account is `@plutobet.test`. That makes
`IDENTITY_PEPPER` rotation possible **now and only now** — every stored identity
digest derives from it, so after the first real customer it becomes permanently
unfixable.

Recommended order:

1. **`IDENTITY_PEPPER` first**, while no real identity digest exists. Generate,
   store in Railway, discard the old value.
2. **Neon** database credentials — rotate, then update all three URLs (pooled,
   unpooled, migration/owner).
3. **Upstash Redis** — rotate, then set `REDIS_URL` to the **TCP** endpoint
   (`rediss://…:6379`). A REST URL will not work; `ioredis` does not speak REST.
4. **Backblaze B2** application key.
5. **Inngest** event and signing keys.
6. **odds-api.io** key last — rotating it interrupts ingestion, so do it when
   nothing depends on the board.
7. Only then set `NEXTAUTH_URL` and mark the deployment healthy.

Do not mark Railway production-healthy until steps 1–6 are complete with clean
replacement values.

---

## 32. Exact next recommended task

**Superseded.** Items 1–4 of the original list are done — the scheduler runs and
is proven against the registered function, the result-queue policy was decided
and implemented, all four negative-test areas are covered (27 tests), and the
team-key fix shipped. The original list is preserved below the line.

What is actually next, in order:

1. **Owner: rotate the exposed credentials** in the section 31 order,
   `IDENTITY_PEPPER` first. It is still rotatable *only* because every account is
   `@plutobet.test`; after the first real customer it is permanently unfixable.
2. **Owner: give Railway a database, Redis and the environment it needs**, then
   set `NEXTAUTH_URL`. Until then the deployment cannot serve anybody.
3. **Watch one real fixture settle unattended** — the only thing standing between
   `VERIFIED_AUTOMATED` and a genuinely observed automatic settlement. Needs
   nothing but a running scheduler and a match that finishes.
4. **Batch the taxonomy classification** — the remaining cost in `syncFixtures`,
   and the reason the 3× target is not claimed.
5. **CI**, so the 712 tests run on every change rather than when somebody
   remembers.

---

*Original list, kept as written:*

**Get something running the settlement poller.**

The core journey is now proven end to end, including a real win paid from a real
result. The gap it exposed is that **nothing triggers settlement automatically**:
`pollMatchResults` is an Inngest cron, Inngest is not running locally, and the
deployment has no database. A bet placed today would sit `PENDING` forever with
no human noticing until the six-hour stall alarm — which also has nothing
running it.

So, in order:

1. ~~**Run the Inngest dev server locally** (or schedule the poller some other
   way) and confirm a bet settles with no manual step.~~ **DONE** — `npm run dev:all`
2. ~~**Decide the result-queue policy** (Defect 6).~~ **DONE** — pending-bet
   priority plus per-event backoff
3. ~~**The four untested negative cases in section 22.**~~ **DONE** — 27 tests
4. ~~**The team-key slug fix** (Defect 1).~~ **DONE** — and it was not a
   transliteration
5. **Railway configuration**, only after the credential rotation in section 31.
   — **still open**
6. **`syncFixtures` performance** (Defect 4). — **partially done**

---

*No real money, no real customer data, no live payment credentials, and no
production data were involved. The bet described here is on a real fixture with
real odds, funded by a ledger-recorded QA credit that is not a deposit.*
