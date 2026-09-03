# PlutoBet — Core Sportsbook Flow: Implementation & Validation

> ## STATUS: SUPERSEDED IN PART
>
> **For what works today, read [`general.md`](general.md)**, which is the single
> source of truth. This document is the running log of what each pass did, and
> the sections below are kept as they were written.
>
> This document records the pass that got the first real bet placed and
> settled. It is kept as historical evidence and is **not** the current state
> of the repository. Where it is out of date, the newer figures are here:
>
> | This document says | Current truth | Where |
> |---|---|---|
> | Migrations 24 | **27** (0024 heartbeats, 0025 poll fairness, 0026 settlement outbox) | §34 |
> | Stage 7 HTTP/RBAC `NOT_IMPLEMENTED` | **Complete** — 27 tests across four areas | §9 |
> | Stage 9 fixture-sync `NOT_IMPLEMENTED` | **Batched**; target not demonstrated, limiting factor documented | §11 |
> | Registered scheduler untested | **9 acceptance tests** drive the real handler | §6 |
> | Defect 6 (poll starvation) open | **Fixed**, 7 tests | §8 |
> | Defect 1 (non-ASCII team keys) open | **Fixed**, 33 tests | §10 |
> | Stage 9 target not demonstrated | **45–49× / 7.1–8.8× measured**, both runs completed | `docs/history/PROJECT_STATUS.md` §4 |
> | CI absent | **Green on both remotes** | `docs/history/PROJECT_STATUS.md` §7 |
> | Scheduler never observed running | **Ran unattended; ingested a real result** | §33 below |
> | §33.3 settlement chain broken, cause unknown | **Four faults found and fixed; the real bet is WON and paid** | §34 below |
> | §34 "NEXTAUTH_URL is the only remaining blocker" | **Wrong framing.** Demo and real-money readiness are separate; neither passes | §35 below |
> | §34.9 residual exposure ₦230 on one market | **₦630 across TWO markets** | §35 below |
>
> **The real match result and ₦600 payout were genuine, but the earlier
> settlement services were manually invoked through QA scripts. Automatic
> scheduling is validated separately** — see `docs/history/DEVELOPER_COMPLETION_REPORT.md`
> §6, where the registered Inngest function is driven end to end.
>
> **Update, 2026-09-02:** the scheduler has since run unattended and ingested a
> real match result on its own — no script, no human. The bet riding on that
> result did **not** settle, and §33 records exactly how far the chain got and
> where it stopped. That is a new, open defect, not a regression of the above.
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
| **Documentation / report** | `docs/history/GPT.md`, `docs/history/PLUTOBET_CORE_FLOW_VALIDATION.md`, `docs/history/PLUTOBET_STATUS.md` |
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
> Automatic settlement is addressed in `docs/history/DEVELOPER_COMPLETION_REPORT.md` §6 and
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
> two legs. See `docs/history/DEVELOPER_COMPLETION_REPORT.md` §5 for the full transaction
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
typecheck still clean - see `docs/history/DEVELOPER_COMPLETION_REPORT.md` section 17.*

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
`docs/history/DEVELOPER_COMPLETION_REPORT.md` section 19.

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

---

## 33. Follow-up pass — 2026-09-02

Everything below happened after this document's original pass. It is recorded
here because §32 asked for exactly this work; the authoritative summary is
`docs/history/PROJECT_STATUS.md`.

### 33.1 What was completed

| Item | Result |
|---|---|
| Fixture-sync performance (old Defect 4) | **Done.** 45–49× at 200 events, 7.1–8.8× at 775; statements 15,500 → 96; transactions 1,550 → 8. Both benchmark runs completed — no terminated measurement is quoted |
| CI | **Done.** GitHub Actions on PR and push to main: install, whitespace, lint, typecheck, secret scan, migration validation, full suite, totals report, production build. Green on both remotes |
| Production readiness audit | **Done.** `npm run production:check` — exits non-zero while a launch-blocker remains, and never prints a value |
| Owner rotation checklist | **Done.** `OWNER_LAUNCH_CHECKLIST.md`, `IDENTITY_PEPPER` first |
| Restore drill | **Blocked** — no Neon API key. `docs/restore-runbook.md` written; the verification half is implemented and tested (`npm run db:verify-restore`, 8/8) |
| Status documents reconciled | **Done.** `docs/history/PROJECT_STATUS.md` is now the single source of truth; this file and four others are banner-marked historical |

### 33.2 Four defects found by RUNNING the scheduler

The scheduler had never actually run. Starting it found more in twenty minutes
than two sessions of reading had, because every one of these lives at the
boundary with a real provider or a real dev server.

| # | Defect | Consequence |
|---|---|---|
| 1 | The app registered **0** functions — the SDK chose cloud mode because signing keys were present | `npm run dev:all` looked like it fixed local scheduling and had not. No cron could fire |
| 2 | One `404` aborted the whole result poll | **No bet on any event could settle** — every minute, forever, because the offending event sorted first |
| 3 | An unanswered event was never deferred | It stayed eligible and was re-fetched forever — Defect 6's fix undone by the case it did not anticipate |
| 4 | One stale id aborted the whole odds refresh (`400 eventIds not found`) | **586 upcoming fixtures had zero prices.** Not an empty board — a broken one |

A fifth came from probing the live API: `/odds/updated` wants the sport DISPLAY
NAME ("Football"), not the slug, and `since` in unix SECONDS — milliseconds
return `200 []`, a silent permanent "nothing changed". Its ~90-second window
also means this document's "delta every 5 min" budget line cannot work, which is
now stated in the code rather than assumed.

All fixed, with 9 tests, and all four confirmed live in the scheduler's own logs.

### 33.3 The unattended settlement — how far it got

Placed through the public HTTP routes, on a real fixture:

| | |
|---|---|
| Bet id | `d7d34d58-507a-4bb0-95e0-338d1626d706` |
| Fixture | Fortaleza FC v CD Once Caldas |
| Selection / stake | away @ 2.150 · ₦200 · potential ₦430 |
| Kickoff | 2026-09-02T01:00:00Z |

**What the scheduler did on its own, with nobody watching:**

- polled the provider, obtained the real result, and recorded it:
  `SETTLED, ft 1-2 (p1 1-1) via odds-api.io` at `2026-09-02T11:43:34Z`
- set the event to `SETTLED`
- recorded the run in `job_heartbeats`

No script and no human touched any of that. It is the first time result
ingestion has ever happened automatically in this project.

**What did NOT happen — a new open defect:**

The bet was on **away**, and away won 1-2. It is still `PENDING`:

| Evidence | Reading |
|---|---|
| `bets.status = PENDING`, `settled_at` null | the bet never settled |
| 0 `PAYOUT` transactions for it | nobody was paid |
| all 5 markets still `OPEN`, last touched `00:19:35` | `close-markets`, the LAST step of `settleEvent`, never ran |
| **0 `settlement/event.finished` events** in the scheduler, ever | the fan-out was never dispatched |
| `job_heartbeats.results`: `processed_count 10`, `settled_count 0` | the poll found 10 finished events and reported settling none |

So `pollFinishedEvents` did its job and the hand-off to `settleEvent` did not
occur.

> **ANSWERED in §34.** The cause was that the cadence claim sat outside
> `step.run()`, so the function's second invocation found the claim held by its
> own first invocation and returned "not due" before ever reaching the dispatch.
> The two facts below that looked contradictory are both explained by it. Kept
> as written, because the reasoning that led from here to there is the useful
> part.

**At the time of writing the cause was not yet identified**, and it was not
guessed at.
Two facts complicate the reading and are recorded rather than resolved:

- every `settlement-poll-results` run whose output could be read returned
  `{"skipped": true, "reason": "not due"}`, while the heartbeat simultaneously
  recorded a success with `processed_count: 10`. Both cannot be true of the same
  run, so at least one run is not visible in the dev server's retained history.
- the hourly provider budget was fully spent (`oddsbudget:h:...11 = 100/100`)
  and the last recorded error is `odds provider budget exhausted for the hour`.

**A related design gap, which IS certain:** the heartbeat wraps only the
ingestion step, and `settled` is hardcoded to `0` at that point. So a run can
report success and a settled count of zero while the dispatch that follows it
fails or never happens — the alert would stay quiet. `settled_count` can never
be anything but zero as the code stands.

### 33.4 Exact next task

1. **Find why `settleEvent` was never dispatched.** Start by capturing the dev
   server's stdout to a file (it was discarded in this pass, which is why the
   diagnosis stops here) and letting one poll run with provider budget available
   — the hourly budget resets on the hour. Watch for `settlement/event.finished`
   in the Inngest dev server.
2. **Make the heartbeat cover the whole run, not just ingestion**, and report a
   real `settled` count. As written it cannot distinguish "settled nothing
   because nothing was due" from "settled nothing because the fan-out broke",
   which is the precise failure sitting in front of it now.
3. Then re-run the observation with the bet above, or a new one.

Do **not** close this with `qa-settle-run.ts` or `qa-settle-one.ts`. They prove a
human can settle a bet, which was never in question.

### 33.5 Two things the owner should know

- **`max: 1` is wrong for Railway.** Both database clients use it, justified for
  serverless where each invocation is its own instance. Railway runs one
  persistent container, so the whole application serialises on a single
  connection and one slow query blocks every request. The dev server wedged
  repeatedly during this pass, including with the scheduler stopped.
- **400 synthetic fixtures are in the production database**, written by an
  earlier benchmark through the shared pooled client. They would appear on the
  customer board as real matches. `npm run db:clean-benchmark` reports them
  (0 bets reference them) and deletes only with `--confirm`.

---

---

## 34. Money-path repair — 2026-09-02

§33.3 recorded that the scheduler ingested a real result but the bet on it did
not settle, and said plainly that the cause was not yet identified. It is now,
and **the bet is paid**. Authoritative summary: `docs/history/PROJECT_STATUS.md` §2b.
Operational detail: `docs/settlement-operations.md`.

**Four faults, not one.** Two caused the stranded bet; two more were found while
proving the fix, and both would have caused their own incidents later.

---

### 34.1 Fault 1 — the dispatch was unreachable by construction

`oddsCadence.claimIfDue` was called OUTSIDE `step.run()`, with a comment
explaining that replaying it would report "not due" and skip real work. The
reasoning was exactly inverted: code outside a step re-executes on every
invocation, and code inside one is memoised.

Inngest invokes a handler once per step:

```
invocation 1   claim succeeds -> ingest step runs -> results stored,
               heartbeat written, step output checkpointed
invocation 2   replays from the top; the claim is still held BY ITS OWN
               FIRST INVOCATION, returns false, function returns
               {skipped: "not due"} and never reaches step.sendEvent
```

Everything after the first step was dead code at runtime. **No bet on any event
could ever have settled.** This explains every observation in §33.3 that looked
contradictory: results ingested, heartbeat green, run output `{"skipped":true}`,
exactly one child span, and zero `settlement/event.finished` events emitted in
the project's life.

The claim now sits inside `step.run`, so the `true` replays from the checkpoint.

### 34.2 Fault 2 — a dual write with no shared commit

Even fixed, the result committed to PostgreSQL while the hand-off went to the
scheduler over the network. A crash between them stranded the bet permanently,
because `pollFinishedEvents` only considers events with NO stored result — once
the result exists, the event is never reconsidered.

`settlement_outbox` (migration 0026) records the work item in the SAME
transaction as the result: either both exist or neither does. One row per event,
enforced by a unique index rather than by convention.

A separate dispatcher drains it using ONLY local data, so **an exhausted provider
budget can no longer stop money reaching somebody whose result we already hold**.
That is not theoretical: on the day of the repair the `results` job failed 131 of
145 runs on the daily provider budget while the dispatcher ran 152 times with
**zero** failures.

### 34.3 Fault 3 — a duplicate submit reserved risk twice

Found because "exposure released" was required evidence: after the recovered bet
was paid, its market still held exactly `potential_return - stake`.

Placement detects an idempotent replay AFTER claiming exposure — it must, because
the global lock order is exposure-then-wallet and inverting it would deadlock
against settlement. A re-submitted slip therefore claimed the liability again and
created no second bet for settlement to release. Ceilings exist to cap risk, and
every double-tapped button permanently consumed a slice of one until the market
would refuse honest bets for liability nobody was carrying.

The replay path now releases precisely what that attempt claimed. A genuinely new
bet still reserves normally — understating real risk is the more dangerous
version of this mistake.

### 34.4 Fault 4 — the retry path had never once delivered

Found by watching the repaired pipeline run for an hour. Six **fully settled**
events — no pending bets, no open markets — sat in the outbox at `DISPATCHED`
with `attempts` climbing past seven, heading for the give-up threshold and an
alert about payouts that had already happened.

The dispatch event id was the work item's idempotency key, stable for the item's
whole life. Inngest deduplicates by event id, so every re-dispatch of a stale
item was silently dropped, `settleEvent` never ran again, and the step that
COMPLETES the row never ran either. The stale-item re-claim — whose entire
purpose is retrying a lost hand-off — was a no-op that incremented a counter.

The id now includes the attempt: a re-dispatch is a real delivery, while a replay
of the SAME attempt is still deduplicated. All six cleared to `COMPLETED`.

---

### 34.5 The bet, recovered automatically

```
13:56:48  SETTLEMENT_RECOVERY_ENQUEUED  recovery sweep found 1 pending bet(s)
                                        on an event with a final result
13:56:49  outbox DISPATCHED             source=RECOVERY, attempts=1
13:56:56  ledger PAYOUT CREDIT 43000
13:56:58  outbox COMPLETED
```

| Evidence | Result |
|---|---|
| Bet `d7d34d58-507a-4bb0-95e0-338d1626d706` | **WON**, `settled_at` populated |
| Payout | **exactly 1** transaction, ₦430.00 |
| CASH | ₦0 → **₦430.00** (stake ₦200, profit ₦230) |
| Markets | all 5 `SETTLED`, 0 of 68 selections open |
| Exposure | released by settlement (see §34.3 for the residue) |
| Ledger | ₦2,035.00 debits = ₦2,035.00 credits, 0 negative wallets |
| Remaining recovery candidates | **0** |
| Same sweep, wider effect | 21 stranded events recovered, 0 failures |
| Replay safety | still one payout after **152 dispatcher runs and 85 recovery runs** |

No manual settlement was used. `qa-settle-run.ts` and `qa-settle-one.ts` were
never run.

### 34.6 Monitoring that can see a settlement failure

The old heartbeat had one row and passed `settled: 0` as a literal at the point
ingestion returned. It could not report anything but zero — sitting in front of
exactly the failure it existed to catch.

Four job rows now, per-stage counts, and an `error_stage` naming where a run
stopped. `dispatch_accepted` and `settlement_completed` are separate fields so
"the scheduler took the message" can never again read as "somebody was paid".
`pending_after_run_count` is the alarm number: bets still PENDING on a result we
already hold.

A late addition, because the first version of the alert was still useless: the
recovery job logged nine failures with an EMPTY `last_error`, courtesy of Node's
`AggregateError` for a failed connection, which carries no message of its own.
Errors are now described by name, code and message with the inner error
unwrapped, and never contain a URL. The same line now reads:

```
AggregateError - code ETIMEDOUT - 6 attempt(s) failed: connect ETIMEDOUT ...
```

Those failures are transient — Neon's free-tier compute suspending — and the job
succeeds again within seconds. What was broken was the reporting, not the
recovery.

### 34.7 Also done

- **Railway pooling.** Both runtime clients used `max: 1`; on one persistent
  container that serialises the whole application, so one slow query blocked
  every unrelated request. Now 10 (reads) and 5 (money — smaller because those
  transactions take row locks). Invalid, zero, negative and excessive values are
  REFUSED at boot rather than clamped. The load test asserts ORDER, not duration:
  a fast query overtakes a slow one through a real pool and does not through a
  pool of 1, and the old behaviour is reproduced in its own test so the
  comparison is against the real thing.
- **Benchmark guard.** A destructive benchmark must now prove its target is
  disposable, and refuses to run from a shell holding production configuration —
  the condition that actually put 400 synthetic fixtures in the production
  database. Refusals never echo the value or the URL.
- **Two pre-existing test defects.** The harness propagated a listener's failure
  into the sender, which Inngest does not do — a failure mode that existed only
  in the harness, turning one unsettleable event into a failed batch. And a
  booking-code test asserted zero birthday collisions among 5000 draws from a
  31^6 space, failing about one run in seventy for a correct generator.

### 34.8 Verification and delivery

63 files · **795 passed · 0 failed · 1 skipped · 0 todo**. Typecheck 0, lint 0
errors, build 0, migrations 27/27 against a clean database (62 tables), ledger
balanced, admin smoke clean, secret scan clean over 390 files, `git diff --check`
clean.

Eleven commits, `de3eb16..4445c6e`, pushed fast-forward to both remotes with no
force-push. CI passing on both.

**That is not the project's final commit.** It was followed by `363c937`
(report accuracy) and then the launch-hygiene pass in §35. Rather than naming a
hash that goes stale the moment anything lands, read it from the repository:
`git rev-parse --short HEAD`. `docs/history/PROJECT_STATUS.md` §7c is the source of truth.

GitHub push protection blocked the first attempt: a guard test used a fake
`sk_live_`-shaped fixture that GitHub classified as a Stripe API Key. It was
never a credential — it exists so a test can assert the refusal does not echo it.
The owner chose rewriting the unpushed commits over whitelisting a Stripe-shaped
string in the repository's secret-scanning history. The string is absent from
every commit, verified with `git log --all -S`.

### 34.9 Still open, and deliberately not touched

- The **400 synthetic fixtures** remain. `npm run db:clean-benchmark` was run in
  **dry run only**: 400 events, and 0 markets, 0 selections, 0 snapshots, 0
  results, 0 bets and 0 audit rows reference them. Teams and competitions would
  be preserved. Deletion awaits owner approval.
- **₦230 of residual liability** on one market, from a duplicate submit predating
  the §34.3 fix. The bug cannot recur; this is historical data in a
  money-adjacent table, so correcting it is an owner decision rather than a
  quiet `UPDATE`. Now visible as `unreleasedExposureMarkets`.
- `NEXTAUTH_URL` is the only remaining launch blocker in `production:check`.

---

---

## 35. Launch-hygiene and truthfulness pass — 2026-09-02

A safety pass over the now-proven money path: production privilege, database
hygiene and accurate launch status. **The money path was not rewritten** — the
recovered bet is still `WON` with exactly one ₦430 payout after 433 dispatcher
and 228 recovery runs.

Authoritative status: `docs/history/PROJECT_STATUS.md` §2c and §7c. Owner actions:
`OWNER_LAUNCH_CHECKLIST.md` §13–§16.

### 35.1 The most serious finding: the runtime database role

`npm run db:audit-roles` — read-only, no credential printed — reports the same
answer for all three configured URLs:

```
session_user / current_user / current_role   neondb_owner
superuser  no          bypasses RLS  YES
owns ledger tables     YES (ledger_entries, ledger_transactions, wallets)
can DROP / ALTER / TRUNCATE ledger  YES
can grant itself more  YES
```

A previous pass recorded this as a NOTE beside a passing check. It is not a
note. It is the difference between "a compromised read route leaks data" and "a
compromised read route can drop the ledger".

The money paths issue `SET LOCAL ROLE app_role` inside every transaction and are
safe. **The pooled READ client does no role handling at all**, and thirty-four
files import it — every board query, every admin page, every public route.

`SET ROLE` on that connection would not fix it reliably: the pooled URL goes
through Neon's transaction-mode pooler, where a session-level role does not
dependably survive to the next transaction. **The fix is a separate
least-privilege credential for `DATABASE_URL`**, with the exact SQL in the owner
checklist §13. `production:check` now FAILS while the runtime role owns the
ledger.

12 tests attempt real DDL through the real runtime client against a real
PostgreSQL, each in a transaction that is rolled back regardless. As `app_role`,
PostgreSQL refuses `DROP`, `ALTER`, `TRUNCATE`, `DELETE`, disabling the balance
trigger, replacing the trigger function and creating tables in `public`; a
self-`GRANT` returns successfully and changes nothing. Two of those tests were
wrong at first and both taught something: they matched Drizzle's "Failed query"
wrapper rather than PostgreSQL's own words — which would have passed on a syntax
error — and `GRANT` without grant option emits a WARNING rather than an error, so
the assertion had to be about whether privileges actually changed.

The permitted side is pinned too: `app_role` holds **column-level** UPDATE on
`wallets`, so it can write the balance and version columns and **cannot** write
`user_id` or `kind`. It cannot move a balance between people, and widening that
to a table-level grant now fails a test.

### 35.2 "The only remaining launch blocker" was the wrong sentence

§34 and earlier reports said `NEXTAUTH_URL` was the only remaining blocker. It
was the only blocker the infrastructure checker could SEE, which is a different
claim, and the gap between them is where a platform gets launched before it is
legal to operate.

Two modes now:

```bash
npm run readiness:demo          # can this serve a test account, end to end?
npm run readiness:real-money    # may this take a stranger's money?
```

| | Result |
|---|---|
| **DEMO_READY** | **NOT satisfied** — 2 blockers: `NEXTAUTH_URL`, runtime DB role |
| **REAL_MONEY_READY** | **NOT satisfied** — 14 blockers |

The other twelve: Paystack deposits, Paystack payouts, Termii SMS, Resend email,
a KYC provider, `SENTRY_DSN`, a real deposit proof, a real withdrawal proof,
credential rotation, a verified restore drill, a gaming licence, and a settlement
bank account.

Several cannot be settled by reading an environment variable. Those report
`UNVERIFIED` and still block, because "we have not checked" and "it is fine" are
not the same claim. **QA ledger credit is never presented as a deposit.**

### 35.3 `NEXTAUTH_URL` — `BLOCKED_BY_OWNER_CONFIGURATION`

The Railway CLI is installed but **not authenticated**, and `railway login` is
interactive. The domain used as an example in `scripts/push-env-railway.ts`
returns Railway's *"Application not found"*, so it is not a live deployment.

**No hostname was invented and nothing is claimed fixed.** Set `NEXTAUTH_URL` to
the real public HTTPS origin with no trailing path, then run
`npm run production:check -- --remote=<url>`.

### 35.4 Corrected: the residual exposure is ₦630, not ₦230

§34.9 reported one market. A full audit found **two**:

| Market | Fixture | Residual |
|---|---|---|
| `701daa4f-8b00-4d36-bf97-5ef236a3e52a` | Dinthar FC v Saikhamakawn FC | ₦400.00 |
| `822cfe03-f701-4251-86e4-3a3e7842baed` | Fortaleza FC v CD Once Caldas | ₦230.00 |

Each equals `potential_return - stake` for its single bet. **No money is
involved**, verified before any repair was written: exposure is a risk LIMIT, the
ledger nets to zero, each bet has exactly one payout, and both markets are
already `SETTLED`.

`npm run db:repair-exposure` is dry-run by default and **refuses `--confirm`
without a fingerprint from a dry run**, and again if the data has since changed.
**Not applied** — approval block in the checklist §16.

### 35.5 Synthetic fixtures — evidence gathered, nothing deleted

`npm run db:verify-cleanup` re-derives the target list INDEPENDENTLY of the
cleanup script, because a safety review performed by the thing being reviewed
agrees with itself. 11 of 11 checks pass: 400 events across two `bench-` tags,
zero markets, selections, snapshots, results, bets or audit rows referencing
them, `odds-api.io` present and **not matched** by the filter, and 1,697 teams
and 212 competitions preserved. **Not deleted** — approval block §15.

### 35.6 Neon reliability, and two defects in my own fix

§34.6 improved failure messages from blank to useful. Doing so **published the
database endpoint** into a table an operator screenshots:

```
code CONNECT_TIMEOUT - write CONNECT_TIMEOUT ep-steep-mode-xxxx...neon.tech:5432
```

Its own comment claimed it interpolated "only a name, a code and a message" and
treated that as sufficient. The MESSAGE is where postgres-js writes the host.
Useful and safe are separate properties and both are required.

**The first scrub silently did nothing.** Its regexes were written through a
Python heredoc that turned `\b` into a literal BACKSPACE character, so every
pattern matched a control character that is never present. It typechecked and
looked correct in review. The tests caught it; a repo-wide scan confirms no other
file carries the same corruption.

Retries now use bounded exponential backoff with jitter. The stale window was a
flat 600 seconds, so a stuck item burned all ten attempts in under two hours and
a backlog became eligible in one instant — a thundering herd against a database
already struggling. A transient failure returns an item to `PENDING` with its
error kept, never to `COMPLETED`.

**Assessment: the free Neon plan is NOT suitable for real-money operation.**
11 of 228 recovery runs failed on compute suspension. They self-heal and no
payout was affected, but a paid plan without auto-suspend is required before
taking deposits. `max_connections` is 901, so the 10/5 pools are conservative.

### 35.7 Backlog corrected against the code, not against the report

**The cash-out contradiction is resolved, and both sides were half right.**
`cashout.service.ts` implements FULL and PARTIAL cash-out with tests — and there
is **no API route and no caller anywhere outside those tests**. So it is
`IMPLEMENTED_NOT_REACHABLE`: a finished feature no customer can use, which is
neither "implemented" nor "not implemented".

| Item | Audited status |
|---|---|
| Cash out (full and partial) | `IMPLEMENTED_NOT_REACHABLE` — no route, no caller |
| Edit bet | `NOT_IMPLEMENTED` — no code of any kind |
| `liveVersion` Redis cache | `NOT_IMPLEMENTED` — confirmed: a three-table aggregate on every `/api/live` request |
| DOB capture and enforcement | `VERIFIED_WORKING` — registration refuses underage with 403 |
| DOB backfill | `NOT_IMPLEMENTED` — column is NULLABLE and **1 of 7 accounts has none** |
| Homepage / live load tests | `PARTIAL` — a 500-reader test covers the odds path, nothing covers HTTP |
| Prompt-injection tests | `PARTIAL` — guardrail tests exist, no injection corpus |
| Fantasy | `NOT_IMPLEMENTED` — a `ComingSoon` stub and a nav entry |
| Lucky Numbers, Personalisation, Admin AI, Bet Builder | `NOT_IMPLEMENTED` — no code |

### 35.8 Exact next developer backlog, in priority order

1. **Least-privilege `DATABASE_URL`** — blocks both readiness modes (§35.1).
2. **`NEXTAUTH_URL`** — blocks both (§35.3).
3. **Expose cash-out over HTTP** — a finished, tested feature nobody can reach.
4. **DOB backfill, then `NOT NULL`** — enforcement is not structural until then.
5. **Redis-cache `liveVersion`** — the board's hottest query, uncached.
6. **HTTP-level load tests** for the homepage and `/api/live`.
7. **Prompt-injection corpus** for the AI surfaces.
8. Edit bet, then personalisation, admin AI, fantasy, lucky numbers.

### 35.9 Verification

64 files · **815 passed · 0 failed · 1 skipped · 0 todo**. Typecheck 0, lint 0
errors, build 0, migrations 27/27 against a clean database, ledger
₦2,035.00 = ₦2,035.00, admin smoke clean, secret scan clean, `git diff --check`
clean.

CI is **completed / success on both remotes** for every commit in this pass,
including the one carrying this section — confirmed per-SHA through the API, not
by reading a badge. A passing badge reflects the latest COMPLETED run on the
branch, which is not necessarily the newest commit, and treating the two as the
same is how a red tip hides behind a green shield.

The commit list lives in `docs/history/PROJECT_STATUS.md` §7c rather than here, so it has one
home instead of two that drift apart.

**Nothing destructive was run.** The 400 synthetic fixtures are still present and
the ₦630 residual exposure is still there, both awaiting owner approval.

---

## 36. Interface redesign and reporting consolidation — 2026-09-02

Branch `ui/plutobet-sportsbook-redesign`. **Not merged, not deployed.** It stops
at a review build and screenshots, which is where the instruction said to stop.

Two things changed about reporting, and they matter more than any single fix
below.

### 36.1 There is now one report

`general.md` at the repository root is the single source of truth. Five status
documents each answered "what is the state of PlutoBet" as of a different day
and disagreed with one another; they were read in full, their still-true content
is in `general.md`, and they now live in `docs/history/` with banners pointing
at it. Nothing was deleted — the trail from a defect to its fix is worth
reading, and tidying a directory is not a reason to destroy evidence.

`CLAUDE.md` now carries the standing instruction: after every implementation,
test, repair, deployment or audit task, update `general.md` with evidence-backed
current status before reporting completion.

This report stays. It is the running log of what each pass did; `general.md` is
what is true now.

### 36.2 The customer-facing interface was rebuilt

The homepage is the odds board rather than a marketing hero over product tiles
that mostly link to products which do not exist. Dark chrome over a light, dense
canvas. Two header rows instead of seventeen products in one. A three-column
sportsbook that becomes a bottom sheet at 1180px and a bottom bar at 900px.
Branded sign-in, registration and password reset. The full detail is in
`UI_REDESIGN_REPORT.md`.

Removed, deliberately: the footer's **"Nigeria · Licensed operator"** claim
(there is no licence, and publishing one before it exists is the kind of claim
that ends an application), every **"arrives in phase N"** label, and the emoji
navigation icons.

### 36.3 Seven dead controls

Each looked like it worked and did not.

| Was | Now |
|---|---|
| Two links per board row to `/sports/event/<id>` — **a route that did not exist** | The event page exists, listing every open market |
| Header search linked to a query parameter nothing read | A real search that filters the board |
| League and fixture stars toggled a colour and forgot it | Persist per browser and pin what they mark |
| "Sign in" after a password reset called `signIn` with **no password** — a call that can only fail | A link to the sign-in form |
| Casino tiles linked to a launch route that does not exist | Non-linking cards that say why |
| "+0" on fixtures with no extra markets | A chevron to the event page |
| The referral link was text to select by hand | Copy and Share buttons |

### 36.4 The redesign was invisible, and every gate passed

The four sportsbook stylesheets were imported **below** Tailwind's `@source`
directive in `globals.css`. CSS requires `@import` to precede every other rule
except `@charset` and `@layer`, so all four were invalid and were dropped.

`tsc` clean, `eslint` clean, every test green, `next build` exit 0 — none of them
reads CSS ordering. The only symptom was a screenshot of unstyled HTML.

Fixed, and pinned by `stylesheet-imports.acceptance.spec.ts`.

Four responsive rules were also losing on source order — the Over/Under column
hide, the responsive board template, the duplicate statistics icon, and the
minimum width of the markets chip. All four are equal-specificity conflicts
where the rule inside the media query came first and lost. Each now carries a
parent selector so it wins regardless of the order a bundler emits.

**One correction to how this was found.** The screenshots that started the hunt
showed the board overflowing badly on a phone, and that part was a measurement
error: Chrome's `--headless --window-size --screenshot` sets the capture size,
not the layout viewport, so a desktop layout was being cropped to 390px and
looked like a responsive bug. The capture script now drives DevTools and sets
device metrics properly. The four CSS conflicts are real and were confirmed by
reading the cascade — the overflow that prompted the search was not.

**Everything in this section was found by looking at the product, not by running
the gates.** That is the reusable lesson from this pass.

### 36.5 Cash-out was examined and deliberately not shipped

The instruction was to expose it **only** if every money invariant was complete.
One is not: a partial cash-out releases a proportional slice of a market's
liability and settlement later releases the whole of it again, so the liability
is released twice for the portion already bought back. The service also does not
check account status, which a route would have to add.

Neither misplaces money — exposure is a risk ceiling, not a balance — but the
instruction said every invariant. No control was added. `general.md` §15 has the
detail. This supersedes item 3 of §35.8, which said to expose cash-out next: the
exposure defect comes first.

### 36.6 Verification

68 files · **844 passed · 0 failed · 1 skipped**. Typecheck 0, lint 0 errors
(15 pre-existing warnings), build 0, with `/signin` and `/sports/event/[id]`
emitted. Secret scan clean, `git diff --check` clean.

29 tests added: betslip arithmetic, the sign-in open-redirect guard, the
navigation registry's honesty rules, and the stylesheet ordering above. **No
existing test was weakened, skipped or deleted.**

Screenshots were captured against a local disposable database seeded with
`npm run db:seed-demo`, never against production and never against the 400
synthetic benchmark fixtures. They are in `artifacts/ui-review/`, which is
git-ignored.

**Nothing destructive was run.** The 400 synthetic fixtures are still present and
the ₦630 residual exposure is still there, both awaiting owner approval.

---

*No real money, no real customer data, no live payment credentials, and no
production data were involved. The bet described here is on a real fixture with
real odds, funded by a ledger-recorded QA credit that is not a deposit.*
