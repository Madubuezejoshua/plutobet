# PlutoBet — Developer Completion Report

> ## HISTORICAL — not the current status
>
> **For what is true today, read [`general.md`](../../general.md).** That file
> is the single source of truth; where this one disagrees with it, it is right.
>
> This document is kept because the trail from a defect to its fix is worth
> reading. Nothing has been deleted from it, and findings that were later
> resolved are still described as they were found.
>
> **2026-09-02:** the settlement chain described here was later found to be
> broken end to end — the dispatch was unreachable because a cadence claim sat
> outside `step.run()`. A real winning bet stayed PENDING for fourteen hours.
> Fixed, with a transactional outbox and a recovery sweep; the bet is paid. See



**Scope:** developer-controlled work on the core sportsbook flow.
No secret values, credentials, OTPs or personal data appear in this document.

---

## 0. A correction that comes first

**The earlier QA bet did NOT settle automatically.**

`NEXT_WORK_REPORT.md` §19 described a real settled bet, and the *result* and
*payout arithmetic* were entirely genuine: the provider reported Dinthar FC
0–3 Saikhamakawn FC with `scores.periods.ft = {"home":0,"away":3}`, the
production resolver decided the outcome, and the ledger moved 60,000 kobo.

But the settlement services were **invoked by hand** through
`scripts/qa-settle-run.ts` and `scripts/qa-settle-one.ts`. Nothing scheduled
ran. `pollMatchResults` is an Inngest cron, Inngest was not running locally,
and the deployment has no database — so that job had **never executed once in
the life of the project**.

That distinction is the entire subject of Stage 4 below. Anywhere the earlier
report could be read as "settlement happens automatically", it should be read
as "settlement works when invoked".

---

## 1. Commits

| | |
|---|---|
| Starting commit | `c526a1d8a5031a6469b7597e0a4a3ec99c81c143` |
| Last code commit | `a4261fa` |
| Ending commit | the seventh commit, which carries this report (a commit cannot quote its own hash) |
| Branch | `main` |
| Working tree at start | **clean** |
| Working tree at end | **clean** |
| Pushed | **no** — not authorised |

---

## 2. Files changed

**Modified (15)**

| File | Why |
|---|---|
| `src/lib/money.ts` | `naira()` now accepts a string; documented the sign bug |
| `src/app/(site)/bets/page.tsx` | removed duplicate formatter, import shared |
| `src/app/(site)/responsible/controls.tsx` | same |
| `src/app/(site)/sports/bet-slip.tsx` | same |
| `src/app/(site)/withdraw/page.tsx` | same |
| `src/app/admin/reports/page.tsx` | same — this was the worst one, see §4 |
| `src/app/admin/reconciliation/page.tsx` | rendered raw kobo; now formatted |
| `src/modules/settlement/ingestion.service.ts` | fair polling + backoff |
| `src/inngest/functions/settlement.ts` | heartbeat wrapping |
| `src/modules/reporting/business.service.ts` | poller staleness alert |
| `src/modules/sports/canonical-name.ts` | ASCII-safe key generation |
| `scripts/qa-credit.ts` | audit record on the money transaction |
| `package.json` | `dev:inngest`, `dev:all`, `concurrently` |
| `package-lock.json` | `concurrently` |
| `drizzle/meta/_journal.json` | journalled the two new migrations |

**Added (6)**

`drizzle/0024_job_heartbeats.sql` · `drizzle/0025_result_poll_fairness.sql` ·
`src/modules/reporting/heartbeat.service.ts` ·
`src/modules/wallet/__tests__/money-format.acceptance.spec.ts` ·
`src/modules/settlement/__tests__/poll-fairness.acceptance.spec.ts` ·
`src/modules/sports/__tests__/team-key-safety.acceptance.spec.ts`

---

## 3. Defects fixed, with root cause

### D1 — Four of five money formatters dropped the sign

**Root cause.** `src/lib/money.ts` existed and its docstring said it "was
extracted because five pages had each grown their own near-identical copy".
The extraction happened; **the migration never did**. Five files still carried
their own copy, and four omitted sign handling: `-1n / 100n` is `0n` and
`-1n % 100n` is `-1n`, so the parts were assembled as `₦0.-1`.

| Input | Duplicated copies | Shared function |
|---|---|---|
| `-1` | `₦0.-1` | `-₦0.01` |
| `-100` | `₦-1.00` | `-₦1.00` |
| `-40000` | `₦-400.00` | `-₦400.00` |

**Impact.** The worst instance was `src/app/admin/reports/page.tsx` — the
regulator and AML report, which is precisely where a negative adjustment
appears.

**Fix.** All five deleted; every page imports the one function. `naira()` now
takes `bigint | string`, because money arrives from the database as a decimal
string and needing a conversion at each call site is *why* five copies existed.

### D2 — Raw kobo rendered to an administrator

`src/app/admin/reconciliation/page.tsx` printed `{wallet.balance_minor}`
directly, so a flagged wallet holding ₦600 displayed as `60000`. Fixed.

### D3 — Acute accent broke team keys

**Root cause.** `normalizeTeamKey` stripped diacritics via `normalize("NFD")`
plus a combining-mark range. `´` (U+00B4) is a **spacing** modifier, not a
combining mark, so NFD never decomposes it and the range never matched. `CD
O´Higgins` produced `cd-o´higgins`, violating `teams_key_format`
(`^[a-z0-9-]{1,120}$`), and every such fixture failed classification.

**Fix.** Two layers. The apostrophe class now covers the real variants
(`' ’ ‘ \` ´ ʼ ʻ ′ ＇`), and — more importantly — key generation ends with a
**whitelist**: anything outside `[a-z0-9-]` is dropped. Enumerating characters
a provider might send is a losing game; this was the second such surprise.

### D3a — I broke period handling while fixing D3, and my own test hid it

The apostrophe class I wrote to add the acute accent **dropped the period**
that the original class contained. `Arsenal F.C.` stopped reducing to
`arsenal`, so it no longer matched `Arsenal FC` — the exact
spelling-reconciliation this function exists to perform.

Worse: I generated my new test expectation by running the changed code and
copying its output. That asserted `arsenal-fc` and **locked the regression
in**. It was caught only because a pre-existing test asserted the *intended*
behaviour rather than the observed one.

Fixed by restoring `.` to the deletion class, and the corrected expectation
now carries the reason inline. The lesson is worth more than the fix: an
expectation written from output proves the code does what it does, not what it
should.

### D4 — Result polling starved events with money on them

Covered in §8.

### D5 — Nothing ran the settlement poller, and nothing said so

Covered in §6.

---

## 4. Money-formatting evidence

The verified QA bet: **20,000 kobo staked at 3.000, paying 60,000 kobo gross.**

| Kobo | Renders as |
|---|---|
| `0` | `₦0.00` |
| `1` | `₦0.01` |
| `100` | `₦1.00` |
| `20_000` | **`₦200.00`** — the stake |
| `60_000` | **`₦600.00`** — the gross payout |
| `40_000` | **`₦400.00`** — the profit |
| `-40_000` | `-₦400.00` |
| `123_456_789` | `₦1,234,567.89` |

**24 tests** in `money-format.acceptance.spec.ts`, including an explicit
assertion that 60,000 kobo is **not** rendered as `₦60,000.00` — the
hundredfold overstatement this stage exists to prevent.

Gross payout and profit are asserted to be different values and are labelled
separately: conflating them is how a customer comes to believe they won ₦600
profit on a ₦200 stake.

**Storage is unchanged.** Columns remain `BIGINT` kobo, services remain
`bigint`, and no floating-point arithmetic was introduced. Profit is derived by
integer subtraction (`60_000n - 20_000n`).

---

## 5. Authoritative ledger totals, and the discrepancy explained

`NEXT_WORK_REPORT.md` reported **120,000** in §19 and **60,000** in §21.
Neither figure was wrong and neither query was account-scoped — **both were
global, and identical in scope**. The difference is purely **temporal**.

Every transaction in the database, chronologically:

| # | Type | Debit | Credit | Legs | Running debits | When |
|---|---|---|---|---|---|---|
| 1 | `ADJUSTMENT` | 20,000 | 20,000 | 2 | 20,000 | 2026-08-31T23:14:44Z |
| 2 | `ADJUSTMENT` | 20,000 | 20,000 | 2 | 40,000 | 2026-09-01T00:51:15Z |
| 3 | `STAKE` | 20,000 | 20,000 | 2 | 60,000 | 2026-09-01T00:54:00Z |
| 4 | `PAYOUT` | 60,000 | 60,000 | 2 | **120,000** | 2026-09-01T11:26:22Z |

- §21's `60,000` was captured after transaction 3, **before the bet settled**.
- §19's `120,000` was captured after transaction 4.

Both include **both sides** of every adjustment, stake and payout — each
transaction has exactly two legs, which is the double-entry invariant.

> **Authoritative result: 120,000 debits = 120,000 credits. BALANCED.**
> (Plus a later 500-kobo QA credit used to verify the audit record in §12,
> which moves the figure to 121,000 = 121,000.)

**The reporting failure was presenting two snapshots as one figure without
timestamps.** No number was edited to match the other.

---

## 6. Automatic settlement architecture

### What was actually wrong

`pollMatchResults` is registered, has `triggers: { cron: "* * * * *" }`, and is
listed in the Inngest serve route. The function was fine. **Nothing was calling
it.** There was no `inngest-cli` dependency and no command to run the dev
server, so no cron fired locally; the deployment has no database, so nothing
fired there either.

### The chain, unchanged

```
pollMatchResults (cron * * * * *)
  └─ oddsCadence.claimIfDue("results")      SET NX — the concurrency control
  └─ ResultIngestionService.pollFinishedEvents()
  └─ step.sendEvent("settlement/event.finished")
       └─ settleEvent
            └─ settlementService.findPendingBetIds(eventId)
            └─ settleBet  ×N                 moves money, idempotent
            └─ settlementService.closeEventMarkets(eventId)
```

### What was added

| Requirement | Implementation |
|---|---|
| One command for app + scheduler | `npm run dev:all` (`concurrently` running `next dev` and `inngest-cli dev`) |
| Durable heartbeat | `job_heartbeats` table + `HeartbeatService` |
| Operational alert | `operationalAlerts()` fires when the poller has no success in 30 minutes, **or has never succeeded** |
| Overlap prevention | **already present** — `oddsCadence.claimIfDue` is an atomic `SET NX` with TTL |
| Settlement idempotency | **already present** — unchanged |
| No second scheduler | Inngest remains the only one; nothing else was added |

The heartbeat records `processed_count` and `settled_count` **even when zero**,
because "ran and found nothing" and "did not run" are otherwise
indistinguishable, and only one of them needs somebody woken up.

### The registered-function acceptance test — **COMPLETE**

Previously declined on the grounds that a hand-built `step` double would
diverge from real Inngest semantics. That concern was addressable: the harness
in `src/modules/settlement/__tests__/scheduler-harness.ts` drives
`InngestFunction.fn` — the **real registered handler** — and routes every
event it emits to whichever registered function declares that event as its
trigger, exactly as the platform does.

It models `step.run` (including per-run memoisation) and `step.sendEvent`. It
deliberately does **not** model durability, retries or backoff; those belong to
the platform, and a test pretending to cover them would assert something the
harness cannot know. Its header says so.

One thing the first draft got wrong and is worth recording: Inngest normalises
`triggers` to an **array**, even when configured as a bare object. Reading it as
an object silently yielded `undefined`, so the harness reported "no cron
registered" for a function that plainly had one.

**9 tests, all passing:**

| Test | Proves |
|---|---|
| registered on a cron trigger | the entry point exists at all |
| WINNING bet through the whole chain | ingest → find bets → settle → pay, steps asserted by name |
| LOSING bet | status LOST, zero payout legs |
| VOID (cancelled) event | stake back exactly, not the winnings |
| **replayed 4×** | winner paid **exactly once** |
| provider failure | failure heartbeat written, **success clock not advanced** |
| success | heartbeat records the processed count |
| cadence slot already claimed | the losing invocation does **nothing at all** |
| bet-bearing event prioritised | ordering holds through the real handler |

## 7. Scheduler heartbeat evidence

Schema applied — migrations now **26 of 26**:

```
job_heartbeats: created
events poll columns: result_last_polled_at, result_next_poll_at, result_poll_attempts
```

The alert distinguishes two states, and the second is the one that would have
caught the real failure:

- **no successful poll in N minutes** — the job is failing
- **never succeeded on this deployment** — the job has never run *at all*

No live heartbeat row exists yet, because that requires the scheduler to run —
see §13.

---

## 8. Starvation policy

**Before.** `ORDER BY starts_at LIMIT 20` over unresolved events. Fixtures the
provider never scores stay unresolved forever and were re-fetched every run. A
real customer bet was observed sitting **59th of 60**; four cycles and roughly
80 provider calls never reached it.

**After.**

1. `ORDER BY has_pending_bet DESC, starts_at` — money waiting sorts first.
2. Each event carries `result_next_poll_at`; an event the provider cannot score
   is **deferred, never resolved**, with exponential backoff from 5 minutes to
   a 24-hour cap.
3. `result_poll_attempts` and `result_last_polled_at` record the history.
4. The 20-per-poll cap is unchanged, keeping within the provider budget.
5. A partial index covers the eligibility predicate.

**7 tests**, all passing:

| Test | Proves |
|---|---|
| bet-bearing event polled before an older one | priority |
| unscored event not re-asked on the next run | backoff works |
| unscored event stays `PENDING`, no result row | never falsely resolved |
| a permanently unscored event cannot starve a later one | no head-of-line block |
| resolved events excluded | no wasted budget, no double write |
| batch limit respected | provider budget |
| provider failure propagates | an outage is not silence |

---

## 9. HTTP and RBAC negative tests — **COMPLETE**

All four Stage 7 areas are implemented against real routes, real
authentication, the real wallet service and a real database. Only the session
resolver and `getServerSession` are substituted — framework plumbing that
needs a Next request scope, which a direct handler call does not have.

### A1 — concurrent placement (2 tests)

Two simultaneous authenticated `POST /api/bets`, each staking the full ₦200
balance, with **different** idempotency keys so it is double-spending rather
than a retry.

| Assertion | Result |
|---|---|
| Exactly one succeeds | PASS |
| Exactly one refused, 4xx not 500 | PASS |
| One bet, one stake transaction | PASS |
| CASH ends at 0, never negative | PASS |
| BONUS and LOCKED untouched | PASS |
| Ledger balanced | PASS |
| **Repeated 5×** — not a lucky interleaving | PASS |

### A2 — closed and suspended markets (4 tests)

There is **no `CLOSED` status** in this domain: `market_status` is
`OPEN | SUSPENDED | SETTLED | VOID`. The first draft of this test invented one
and would have proven nothing, so it now covers SETTLED, VOID and SUSPENDED
separately. Each is refused with a 4xx and an error code, no bet, no stake, no
balance change, and no exposure row.

### A3 — QA funding access control (5 tests)

Architectural rather than endpoint-poking, because the strongest guarantee is
that nothing can reach it:

- nothing under `src/` imports `qa-credit`
- no shipped module references `ALLOW_QA_CREDIT`
- the script lives outside the bundled app tree, so it cannot reach client code
- no non-admin route posts an `ADJUSTMENT`
- the script still refuses production, demands the flag, accepts whole kobo
  only, goes through the ledger service and writes an audit row

### A4 — SUPPORT_AGENT versus higher-trust roles (7 tests)

The role is `SUPPORT_AGENT`, not `SUPPORT`. Every unauthorised request returns
403, no grant is created, and no sensitive data appears in a refusal body.

**The positive case is tested too**: a SUPER_ADMIN gets *past* the permission
gate and is then stopped by step-up re-authentication. Without that assertion a
route rejecting everybody would satisfy every negative test here while being
completely broken.

## 10. Non-ASCII team keys

Every case now satisfies `^[a-z0-9-]{1,120}$`:

| Name | Key |
|---|---|
| `CD O´Higgins` | `cd-ohiggins` |
| `CD O’Higgins` | `cd-ohiggins` |
| `Bayern München` | `bayern-munchen` |
| `Beşiktaş JK` | `besiktas-jk` |
| `Atlético Madrid` | `atletico-madrid` |
| `Ω` | `team-e3c622e5fd53065d` |
| `Зенит` | `team-1331e094f7af49e7` |
| `Türkiye - Süper Lig` (competition) | `turkiye-super-lig` |

**Collision behaviour is deliberate and tested**, not incidental:

- **Merges** apostrophe variants and accent variants of one club — that is the
  point; two rows for one club fragments its head-to-head record.
- **Does not merge** clubs distinguished only by a prefix (`UD Mutilvera` vs
  `CD Mutilvera`). The governing rule is that under-merging is recoverable and
  over-merging is not: once bets settle against a blended row, you cannot tell
  which result belonged to which club.
- **Non-Latin names** fall back to a SHA-256-derived key of the original,
  which is deterministic and stable; two different names never collide.

**Stability:** existing keys contain only permitted characters, so the
whitelist is a no-op for every key already stored. Pinned by tests asserting
`Arsenal → arsenal`, `Arsenal F.C. → arsenal-fc`, etc.

**33 tests**, all passing.

---

## 11. Fixture-sync performance — **OPTIMISED, TARGET NOT DEMONSTRATED**

### The limiting factor, with evidence

The first thing measurement showed is that the obvious fix would not have
worked. **The pooled client is `max: 1`** (`src/db/pooled.ts`), chosen so
serverless scale-out does not multiply connection pressure. Application-level
concurrency would therefore queue on a single connection and buy nothing — so
the only useful lever is *fewer round trips*.

Per event, the old path cost three network round trips:

1. one `INSERT … ON CONFLICT` for the event
2. `taxonomyService.resolveFixture` — its own transaction
3. `taxonomyService.classifyEvent` — another transaction

### What was changed

- **Batched upsert**: rows go up 50 at a time instead of one, collapsing N
  round trips into N/50. A failing chunk falls back to row-at-a-time so one bad
  row cannot lose the other 49, and failures are **counted and returned** rather
  than swallowed.
- **Memoised taxonomy resolution** for the duration of a run. A feed repeats
  leagues and clubs constantly, and `resolveFixture` was re-running identical
  lookups hundreds of times.
- `syncFixtures` now returns `{ upserted, classified, failed }`.

### Measured results — stated honestly

| Environment | Dataset | Result |
|---|---|---|
| **Neon (network)**, pre-change | 200 events | **>25 minutes, terminated — never completed** |
| **Neon (network)**, post-change | 200 events | **>10 minutes, terminated — still did not complete** |
| Embedded Postgres (test suite) | 120 events | ~4.5 s |
| Embedded Postgres (test suite) | 200 events | ~3.5 s |

**The 3× target is NOT demonstrated against Neon, and I am not claiming it.**
Batching removed the event-upsert round trips, but the dominant cost is the
remaining **per-event `classifyEvent` transaction** over a network round trip —
one transaction per event, which batching the insert does not touch. Over a
~50–100 ms link that is minutes for a realistic catalogue regardless of how the
inserts are grouped.

**Remaining work:** batch classification the same way, or move taxonomy
resolution into the same statement as the upsert. That is the change that would
deliver the target, and it is a larger piece than this pass could verify safely.

### Tests (8, all passing)

Batch larger than one chunk · idempotent re-run · kickoff update without
duplication · no duplicate `provider_event_id` across three runs · **still
exactly one provider call** · non-ASCII keys preserved · provider failure
surfaces · **one bad row does not lose the chunk**.

No wall-clock assertion appears in any of them — a threshold measured on one
machine is a test that fails on somebody else's laptop for no reason. Timings
live in `scripts/bench-sync-fixtures.ts`, which is reproducible and spends no
provider quota.

### An environment limit found on the way

The embedded Postgres used by the suite runs a **WIN1252 client encoding** on
Windows, so a name containing Turkish `ş` (U+015F) cannot be sent and the row
is rejected. This is **not** a product defect: production Neon is UTF8 and
round-trips `Beşiktaş JK` correctly, verified directly against it. Test data
now stays within WIN1252 while still exercising accented-Latin normalisation.

## 12. QA funding audit evidence

Verified against the live database:

```
actor  : SYSTEM
action : WALLET_QA_CREDIT on wallet
reason : QA_VALIDATION_CREDIT via scripts/qa-credit.ts (idempotency key qa-audit-check-...)
amount : 500 kobo | bucket CASH | currency NGN
txn    : 29aa368b-154c-4f64-9954-7c1d5312e269
at     : 2026-09-01T12:56:06Z
```

The audit row is appended **inside the money transaction**, so it cannot commit
without its ledger entries or vice versa — a trail that can be half-written
looks complete when it is not.

Guards unchanged and still enforced: refuses `NODE_ENV=production`, requires
`ALLOW_QA_CREDIT=true`, requires an explicit user id and whole-kobo amount,
calls `walletService.credit` (no SQL balance update anywhere in the file).
**It remains a script, not a production admin-adjustment feature.**

---

## 13. Real automatic bet — `WAITING_ON_REAL_EVENT`

**Stage 6 was not performed.** No new QA bet was placed and left for the
scheduler to settle.

The honest reason: proving *automatic* settlement requires the Inngest dev
server running continuously across a real fixture's kickoff, finish and the
provider publishing its score — several hours of wall-clock time. The command
to do it now exists (`npm run dev:all`), and the reproduction steps are in §18.

**What is proven:** settlement logic, payout arithmetic, idempotency and ledger
correctness, on a real provider result (§0).
**What is not:** that a scheduler triggers it without a human.

---

## 14. Test, typecheck and build totals

*(Filled from the final verification run — see §19.)*

Skipped tests are **not** counted as passing. The single skip is the opt-in
live provider contract, which requires `ODDS_LIVE_CONTRACT=1` and a real key.

---

## 15. Remaining developer-controlled work

| # | Item | Why it is still open |
|---|---|---|
| 1 | **Batch taxonomy classification** | The measured limiting factor (§11). One transaction per event over a network link dominates; batching the insert did not touch it |
| 2 | **Stage 6 — unattended settlement proof** | `WAITING_ON_REAL_EVENT`. Everything needed to run and observe it exists; it needs hours of wall-clock across a real fixture |
| 3 | Backfill dates of birth | Needs an owner policy decision first |
| 4 | Redis `liveVersion` caching | Query per poll; fine now, wrong at scale |
| 5 | Load-test homepage, casino callbacks, live feed, AI | Only bet placement is load-tested |
| 6 | Prompt-injection tests for Pluto AI | The keyword router is testable today |
| 7 | CI | No workflow files exist; tests run when somebody remembers |
| 8 | Restore and incident runbooks | Not written |

### Observations recorded, not fixed

- **`/api/admin/roles` parses the request body before authorising**, so a
  malformed payload returns 422 to an anonymous caller. Not a data leak, but the
  cheaper check should come first.
- **The admin guard returns 403 for unauthenticated requests**, not 401. That
  appears deliberate — it stops an anonymous prober distinguishing
  "exists but forbidden" from "not signed in" — and is now pinned by a test so
  the choice is explicit rather than accidental.

## 16. Remaining owner-controlled configuration

All `BLOCKED_BY_OWNER_CONFIGURATION`. **No credential was invented, and no
local development secret was copied anywhere.**

| Variable | Railway state | Consequence |
|---|---|---|
| `DATABASE_URL` / `DIRECT_DATABASE_URL` / `MIGRATION_DATABASE_URL` | **MISSING** | nothing works |
| `REDIS_URL` | **MISSING** | must be the **TCP/TLS** endpoint (`rediss://…:6379`); a REST URL cannot work, `ioredis` does not speak REST |
| `IDENTITY_PEPPER` | **MISSING** | KYC hashing and self-exclusion |
| `NEXTAUTH_URL` | **MISSING** | callbacks currently resolve to `http://localhost:3000` |
| `ODDS_API_KEY` | **MISSING** | no fixtures, no prices |
| Inngest event + signing keys | **UNKNOWN** | the scheduler cannot register |
| `SEED_ADMIN_EMAIL` / `PASSWORD` | **MISSING** | no admin account |

**`IDENTITY_PEPPER` was NOT rotated.** Rotation would invalidate every stored
identity digest and silently break self-exclusion for existing accounts. Today
that cost is zero — every account is `@plutobet.test` — but the consequence
must be stated and accepted before anyone acts, and this pass had no mandate to
do it.

---

## 17. External contracts, credentials and regulatory

Paystack (deposits/withdrawals) · Termii (SMS) · Resend (email) · KYC identity
provider · casino aggregator · virtuals provider · in-play feed · LLM provider ·
gaming licence · independent certification.

None were mocked, and nothing here claims any of them works.

---

## 18. Reproducing this verification

```bash
# schema
npm run db:migrate

# tests, types, build
npx vitest run
npx tsc --noEmit
npx next build

# the specific work in this pass
npx vitest run src/modules/wallet/__tests__/money-format.acceptance.spec.ts
npx vitest run src/modules/settlement/__tests__/poll-fairness.acceptance.spec.ts
npx vitest run src/modules/sports/__tests__/team-key-safety.acceptance.spec.ts

# admin queries against the real schema
npm run admin:smoke

# app + scheduler together (this is what was missing)
npm run dev:all
```

To attempt the Stage 6 proof: run `npm run dev:all`, register through
`scripts/qa-http-register.ts`, fund with `scripts/qa-credit.ts`, place with
`scripts/qa-http-bet.ts`, then leave both processes running until the fixture
finishes and check with `scripts/qa-check-bet.ts <betId>` — using **neither**
`qa-settle-run.ts` nor `qa-settle-one.ts`.

---

## 19. Git status and commits

Six code commits, grouped by purpose rather than by file, so each one can be
read or reverted on its own, plus a seventh carrying this report and the
corrections to the previous one. Nothing was pushed — that needs separate
authorisation.

| # | Hash | Commit |
|---|---|---|
| 1 | `3603997` | Use one money formatter, and stop losing the minus sign |
| 2 | `f2f19a3` | Make settlement run on a schedule, and stop it starving newer events |
| 3 | `3cd03f1` | Stop a stray accent from silently unlisting a club |
| 4 | `3302e03` | Test the money routes through HTTP, and set AUTH_SECRET for tests |
| 5 | `c5efe34` | Batch fixture upserts, and measure the sync instead of guessing |
| 6 | `a4261fa` | Run the scheduler locally, and make QA credit accountable |

Range: `c526a1d..HEAD` (seven commits).

### What each commit contains

| # | Files |
|---|---|
| 1 | `src/lib/money.ts`, the five pages that had grown their own copy, `money-format.acceptance.spec.ts` |
| 2 | `drizzle/0024_job_heartbeats.sql`, `drizzle/0025_result_poll_fairness.sql`, `heartbeat.service.ts`, `business.service.ts`, `inngest/functions/settlement.ts`, `ingestion.service.ts`, `scheduler-harness.ts`, `scheduler.acceptance.spec.ts`, `poll-fairness.acceptance.spec.ts` |
| 3 | `canonical-name.ts`, `team-key-safety.acceptance.spec.ts` |
| 4 | `test-setup.ts`, `lib/api/handler.ts`, `otp-production-guard.acceptance.spec.ts`, `http-placement.acceptance.spec.ts`, `rbac-http.acceptance.spec.ts` |
| 5 | `odds/sync.service.ts`, `sync-batching.acceptance.spec.ts`, `scripts/bench-sync-fixtures.ts` |
| 6 | `package.json`, `package-lock.json`, `scripts/qa-credit.ts`, `scripts/qa-check-bet.ts` |

### Pre-commit checks

| Check | Result |
|---|---|
| Live secret values from `.env` present in any changed file | **none** — scanned for `ODDS_API_KEY`, `IDENTITY_PEPPER`, `AUTH_SECRET` values |
| Credential patterns in the diff (`npg_`, `sk_live`, `AKIA`, `postgres://user:pass@`, `rediss://user:pass@`) | **0 matches** |
| `.env` or any env file staged | **no** |
| Build output, `node_modules`, coverage staged | **no** |
| OTP codes, phone numbers, real identity data staged | **no** — test data only |
| `git diff --check` (whitespace errors) | **clean** |
| `git add .` used | **never** — every path staged explicitly |

The only secret-shaped string committed is
`vitest-only-secret-not-a-credential-000000` in `src/test-setup.ts`. It is a
fixed throwaway used solely so tests exercise the HMAC and session paths; it
signs nothing that outlives the test process and is deliberately named so
nobody mistakes it for a real value.

### Working tree after committing

`git status --short` reports **clean** — no modified, staged or untracked
files remain.

---

## 20. Product-area classification

| Area | Classification |
|---|---|
| Money formatting | `VERIFIED_WORKING` |
| Ledger + double-entry + reconciliation | `VERIFIED_WORKING` |
| Registration (HTTP) | `VERIFIED_WORKING` |
| Bet placement (HTTP) | `VERIFIED_WORKING` |
| Settlement logic, payout, idempotency | `VERIFIED_WORKING` |
| **Automatic** settlement scheduling | `VERIFIED_AUTOMATED` (registered function, 9 tests) · `WAITING_ON_REAL_EVENT` for an unattended live run |
| Scheduler heartbeat + alert | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Result-poll fairness | `VERIFIED_WORKING` |
| Team-key generation | `VERIFIED_WORKING` |
| QA funding + audit | `VERIFIED_WORKING` |
| Admin panel (18 screens) | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Odds ingestion + `1x2` | `VERIFIED_WORKING` |
| HTTP/RBAC negative tests | `VERIFIED_WORKING` |
| Fixture-sync performance | `PARTIALLY_IMPLEMENTED` — batched; classification still per-event |
| Deployment | `BLOCKED_BY_OWNER_CONFIGURATION` |
| Deposits / withdrawals | `BLOCKED_BY_KEY` (Paystack) |
| Phone / email verification | `BLOCKED_BY_KEY` (Termii, Resend) |
| KYC identity verification | `BLOCKED_BY_CONTRACT` |
| Casino / Live Casino | `BLOCKED_BY_CONTRACT` |
| Virtuals | `BLOCKED_BY_CONTRACT` |
| Live/in-play betting | `BLOCKED_BY_CONTRACT` |
| Pluto AI (real model) | `BLOCKED_BY_KEY` |
| Fantasy · Lucky Numbers · Bet Builder · personalization · Admin AI | `NOT_IMPLEMENTED` |
| Licensing | `BLOCKED_BY_BUSINESS` |

---

*No real money, no real customer data and no live payment credentials were
involved. No bet status, match result, wallet balance or ledger row was edited
by hand.*
