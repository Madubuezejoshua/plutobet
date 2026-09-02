# PlutoBet — Current Status

**This is the single source of truth for what works today.** Every other status
document in this repository is historical evidence of a particular pass and is
banner-marked as such. Where they disagree with this file, this file is right.

**Last verified:** 2026-09-02 · branch `main` · see §7 for the exact gate output.

> **Two readiness modes, and they are different questions.** `DEMO_READY` asks
> whether this can serve a test account end to end. `REAL_MONEY_READY` asks
> whether it may take a stranger's money. Neither is currently satisfied — §2c.
> A previous report said "NEXTAUTH_URL is the only remaining launch blocker";
> that was the only blocker the infrastructure checker could SEE.

> **The stranded winning bet is settled.** It was recovered by the automatic
> pipeline, not by hand: `WON`, one ₦430 payout, markets closed, ledger
> balanced. The two faults that stranded it, and a third found while proving
> it, are in §2b.

No credential value appears in this document.

---

## How to read the classifications

| Classification | Means |
|---|---|
| `VERIFIED_WORKING` | Exercised against a real database or real provider data, with a test or a recorded observation behind it |
| `VERIFIED_AUTOMATED_BY_ACCEPTANCE_TEST` | The **registered** scheduled function is driven end to end by tests. Not the same as having watched it happen unattended |
| `WAITING_ON_REAL_EVENT` | Code is ready; the proof needs a real-world occurrence nobody can hurry |
| `IMPLEMENTED_NOT_LIVE_TESTED` | Written and typechecked, never exercised against production-like conditions |
| `BLOCKED_BY_OWNER_CONFIGURATION` | Needs an account, a key, or a console the developer does not have |
| `BLOCKED_BY_KEY` | Needs a paid or approved third-party credential |
| `BLOCKED_BY_CONTRACT` | Needs a commercial agreement with a provider |
| `BLOCKED_BY_REGULATION` | Needs a licence or certification |
| `NOT_IMPLEMENTED` | Not built |

**The platform as a whole is NOT finished.** The core sportsbook flow —
register, browse, price, place, settle, pay — works. That is one flow out of a
product that also promises casino, virtuals, in-play, fantasy and more. §5 lists
everything still outstanding.

---

## 1. Core sportsbook

| Area | Status | Evidence |
|---|---|---|
| Double-entry ledger, integer kobo | `VERIFIED_WORKING` | Balanced at ₦1,205.00 debits = ₦1,205.00 credits; every transaction balances individually; 0 negative wallets |
| Wallet buckets (CASH/BONUS/LOCKED) | `VERIFIED_WORKING` | Contention tests, 100-way hammer |
| Money formatting | `VERIFIED_WORKING` | 24 tests; the sign bug that printed `₦0.-1` is fixed |
| Registration over HTTP | `VERIFIED_WORKING` | Route-level tests |
| Bet placement over HTTP | `VERIFIED_WORKING` | 15 tests incl. concurrent placement repeated 5× |
| RBAC and QA-funding isolation | `VERIFIED_WORKING` | 12 tests incl. the positive case |
| Settlement logic (win/loss/void, idempotency) | `VERIFIED_WORKING` | Deterministic tests against captured real provider shapes |
| Odds ingestion and `1x2` | `VERIFIED_WORKING` | 333 open selections on upcoming fixtures, live |
| Fixture classification performance | `VERIFIED_WORKING` | 45–49× / 7.1–8.8× faster, 15,500 → 96 statements — §4 |
| Result-poll fairness and backoff | `VERIFIED_WORKING` | 7 tests |
| Poll resilience to unknown fixtures | `VERIFIED_WORKING` | 5 tests, and observed live in the scheduler log |
| Team-key generation | `VERIFIED_WORKING` | 33 tests |
| **Automatic settlement scheduling** | `VERIFIED_AUTOMATED_BY_ACCEPTANCE_TEST` | 9 tests drive the registered Inngest function |
| **Unattended result ingestion** | `VERIFIED_WORKING` | The scheduler polled, obtained and recorded a real result on its own — §3 |
| **Unattended bet settlement** | `VERIFIED_WORKING` | The real stranded bet was recovered and paid by the pipeline — §2b, §3 |
| Settlement outbox + recovery sweep | `VERIFIED_WORKING` | 19 acceptance tests through the registered functions |
| Connection pooling for Railway | `VERIFIED_WORKING` | 14 tests, including a load check that `max: 1` serialises and the pool does not |
| Scheduler heartbeat and stall alert | `VERIFIED_WORKING` | Recorded a real failure with its cause on the first live run |
| Admin panel (18 screens) | `IMPLEMENTED_NOT_LIVE_TESTED` | `npm run admin:smoke` passes; no human has used it against production traffic |
| Backup / restore drill | `BLOCKED_BY_OWNER_CONFIGURATION` | No Neon API key. Runbook and tested verifier in `docs/restore-runbook.md` |
| Deployment | `BLOCKED_BY_OWNER_CONFIGURATION` | Railway has no database, no Redis; `NEXTAUTH_URL` points at localhost |

---

## 2. What running the scheduler for the first time found

The scheduler had never actually run in this project's life. Starting it found
four defects in twenty minutes that two sessions of reading had not, because
every one lives at the boundary with a real provider or a real dev server.

| # | Defect | Consequence | Status |
|---|---|---|---|
| 1 | App registered **0** functions with Inngest — the SDK chose cloud mode because signing keys were present | `npm run dev:all` looked like it fixed local scheduling and did not. No cron could fire | Fixed — `isDev` is explicit and opt-in |
| 2 | One 404 aborted the whole result poll | **No bet on any event could ever settle.** Every minute, forever, because the offending event sorts first | Fixed — a 404 skips one event; 429/5xx still stop the run |
| 3 | An unanswered event was never deferred | It stayed eligible and was re-fetched forever — the starvation fix undone | Fixed — every unanswered due event is backed off |
| 4 | One stale id aborted the whole odds refresh (`400 eventIds not found`) | **586 upcoming fixtures had zero prices.** Not an empty board — a broken one | Fixed — stale ids dropped, chunk retried once |

A fifth was found by probing the live API after the delta job failed on every
run: `/odds/updated` takes the sport **display name** ("Football"), not the slug,
and `since` in **unix seconds** — milliseconds return `200 []`, a silent
permanent "nothing changed". It also refuses a cursor older than ~90 seconds,
which means the documented "delta every 5 minutes" budget plan cannot work. The
adapter now returns `null` for a stale cursor so the caller falls back to a full
refresh; the cadence itself is an owner decision with a cost attached and is
documented rather than silently changed.

---

## 2b. The money-path repair

A real winning bet — `d7d34d58-507a-4bb0-95e0-338d1626d706`, away @ 2.150 on
Fortaleza FC v CD Once Caldas, which finished 1-2 — sat `PENDING` for fourteen
hours after its event was automatically marked `SETTLED`. Three faults, two that
caused it and one found while proving the fix.

### Fault 1 — the dispatch was unreachable by construction

`oddsCadence.claimIfDue` was called OUTSIDE `step.run()`, with a comment
explaining that replaying it would report "not due" and skip real work. The
reasoning was exactly inverted: code outside a step is what re-executes on every
invocation; code inside one is memoised.

Inngest invokes a handler once per step. Invocation 1 claimed the cadence slot
and ran the ingestion step. Invocation 2 replayed from the top, found the claim
**held by its own first invocation**, and returned `{skipped: "not due"}` —
never reaching the dispatch. Everything after the first step was unreachable for
every event, always.

Evidence, before the fix: every `settlement-poll-results` run whose output could
be read returned `{"skipped":true,"reason":"not due"}` with exactly one child
span, while the heartbeat simultaneously recorded a success with
`processed_count: 10`, and **zero** `settlement/event.finished` events had ever
been emitted.

### Fault 2 — a dual write with no shared commit

The result committed to PostgreSQL; the hand-off went to the scheduler over the
network. A crash between them stranded the bet permanently, because
`pollFinishedEvents` only considers events with NO stored result — once the
result exists the event is never reconsidered.

Closed with a transactional outbox: the work item is written in the SAME
transaction as the result, and a separate dispatcher drains it using only local
data. **Provider budget exhaustion can no longer stop money reaching somebody
whose result we already hold** — the state the system was in while the customer
went unpaid.

### Fault 3 — a duplicate submit reserved risk twice

Found because "exposure released" is part of the required evidence. After the
recovered bet was paid, its market still held exactly `potential_return - stake`.

Placement detects an idempotent replay AFTER claiming exposure — it must, because
the global lock order is exposure-then-wallet and inverting it would deadlock
against settlement. So a re-submitted slip claimed the liability again against
every market on it and created no second bet for settlement to release. A
market's ceiling exists to cap risk; every double-tapped button permanently ate
a slice of it.

The replay path now releases precisely what that attempt claimed. A genuinely
new bet still reserves normally — understating real risk would be the more
dangerous mistake.

### How the real bet was recovered

By the pipeline, with no human in the loop:

```
13:56:48  SETTLEMENT_RECOVERY_ENQUEUED  recovery sweep found 1 pending bet(s)
                                        on an event with a final result
13:56:49  outbox DISPATCHED             source=RECOVERY, attempts=1
13:56:56  ledger PAYOUT CREDIT 43000
13:56:58  outbox COMPLETED
```

| Evidence | Result |
|---|---|
| Bet status | **WON**, `settled_at` populated |
| Payout | **exactly 1** transaction, ₦430.00 |
| CASH balance | ₦0 → **₦430.00** (profit ₦230) |
| Markets | all 5 `SETTLED`, 0 of 68 selections open |
| Ledger | ₦2,035.00 debits = ₦2,035.00 credits, 0 negative wallets |
| Remaining recovery candidates | **0** |
| Same sweep, wider effect | 21 stranded events recovered, 0 failures |

### A fourth fault, found by watching it run

After the bet was paid, six fully-settled events sat in the outbox at
`DISPATCHED` with `attempts` climbing past seven — no pending bets, no open
markets, the work demonstrably done — heading for the give-up threshold and an
alert about a payout that had already happened.

The dispatch event id was the work item's idempotency key, which is stable for
the item's whole life. Inngest deduplicates by event id, so every re-dispatch of
a stale item was silently dropped, `settleEvent` never ran again, and the step
that COMPLETES the row never ran either. The stale-item re-claim — whose entire
purpose is retrying a lost hand-off — was a no-op that incremented a counter.

The id now includes the attempt, so a re-dispatch is a real delivery while a
replay of the same attempt is still deduplicated. Verified in production: all six
cleared to `COMPLETED`, and the recovered bet is still `WON` with exactly one
payout after 79 dispatcher runs and 42 recovery runs.

**One residue, reported not repaired.** That market still holds ₦230 of
liability from the duplicate submit that predates the fix. It is historical data
in a money-adjacent table, so correcting it is an owner decision rather than
something to quietly `UPDATE`. It is now counted as
`unreleasedExposureMarkets` and surfaces in the sweep's health output.

---

---

## 2c. Readiness, security and the two questions

```bash
npm run readiness:demo          # can this serve a test account, end to end?
npm run readiness:real-money    # may this take a stranger's money?
```

### DEMO_READY — **NOT SATISFIED**, 2 blockers

| Blocker | Why |
|---|---|
| `NEXTAUTH_URL` points at localhost | sign-in callbacks send real users to their own machine |
| **runtime database role owns the ledger** | see below |

Everything else a demo needs is in place: real fixtures and odds, QA ledger
credit, bet placement over HTTP, automatic ingestion, settlement and recovery.

### REAL_MONEY_READY — **NOT SATISFIED**, 14 blockers

The two above, plus: Paystack deposits, Paystack payouts, Termii SMS, Resend
email, a KYC provider, `SENTRY_DSN`, a real deposit proof, a real withdrawal
proof, credential rotation, a verified restore drill, a gaming licence, and a
settlement bank account.

**QA ledger credit is not a deposit** and is never presented as one.

### The runtime database role — the most serious finding in this pass

`npm run db:audit-roles`, read-only, reports for all three configured URLs:

```
session_user / current_user / current_role   neondb_owner
superuser                                    no
bypasses RLS                                 YES
owns ledger tables                           YES (ledger_entries, ledger_transactions, wallets)
can DROP / ALTER / TRUNCATE ledger           YES
can grant itself more                        YES
```

The money paths issue `SET LOCAL ROLE app_role` inside every transaction and are
safe. **The pooled READ client does no role handling at all**, and thirty-four
files import it — every board query, every admin page, every public route. A
compromised read path inherits owner rights over the ledger.

`SET ROLE` on the pooled connection would not fix it reliably: that URL goes
through Neon's transaction-mode pooler, where a session-level role does not
dependably survive to the next transaction. The fix is a separate
least-privilege credential for `DATABASE_URL`, with the exact SQL in
`OWNER_LAUNCH_CHECKLIST.md` §13.

`production:check` now **fails** on this. It previously appeared as a note
beside a passing check, which is how a privilege problem survives a review.

**What the restricted role can and cannot do** is pinned by 12 tests that
attempt real DDL through the real runtime client against a real PostgreSQL
(`runtime-role.acceptance.spec.ts`). As `app_role`, PostgreSQL refuses `DROP`,
`ALTER`, `TRUNCATE`, `DELETE`, disabling the balance trigger, replacing the
trigger function, and creating tables in `public`; a self-`GRANT` returns
successfully but changes nothing. It retains exactly what the application uses,
including **column-level** UPDATE on `wallets` — it can write the balance and
version columns and cannot write `user_id` or `kind`, so it cannot move a
balance between people.

---

---

## 3. The unattended settlement: what was and was not proven

**Proven:**

- 13 functions register with a running scheduler, including
  `settlement-poll-results` on a one-minute cron.
- That cron **fired for the first time in this project's life** and its run was
  recorded in `job_heartbeats`.
- The failure path works: the heartbeat captured
  `odds-api.io /events/72546036 -> 404` without advancing the success clock, and
  without a human watching. That is exactly what the table was built for.
- After the fix, the same condition appears in the log as
  `provider no longer knows event …; skipping it this tick` and the poll
  continues.
- **The results job then recorded its first successful unattended run**, which
  is the end-to-end proof that the fix works and not merely that the tests pass:

  ```
  job=results  last_success=2026-09-01T23:39:42Z
  total_runs=2  total_failures=1  processed=6  settled=0
  ```

  Two runs, one failure: run 1 is the 404 that used to abort everything, run 2 is
  the same job processing six events to completion. `processed=6, settled=0` is
  exactly the "ran and found nothing yet" signal the heartbeat exists to
  distinguish from "did not run" — nothing was due for settlement at that moment,
  and the job said so rather than staying silent.
- The scheduler reports `connected: true` with all 13 functions registered.
- The board went from **0** to **333** open selections on upcoming fixtures.

**A real bet was registered, funded and placed entirely through the public HTTP
routes**, and the match has since finished.

| | |
|---|---|
| Bet id | `d7d34d58-507a-4bb0-95e0-338d1626d706` |
| Fixture | Fortaleza FC v CD Once Caldas — Colombia, Liga DIMAYOR Finalizacion |
| Provider event id | `72335078` |
| Kickoff | 2026-09-02T01:00:00Z |
| Selection | away @ 2.150 |
| Stake / potential return | ₦200.00 / ₦430.00 |
| Stake left CASH at placement | 20,000 → 0 kobo, verified |

Registration refused an underage date of birth (403) and a duplicate email (409);
placement refused an over-balance stake (409), a zero stake (422) and stale odds
(409), and a duplicate submit returned the same bet id rather than a second bet.

### The match finished, and the chain broke halfway

**What the scheduler did on its own, with nobody watching:**

- polled the provider, obtained the real result, and recorded it —
  `SETTLED, ft 1-2 (p1 1-1) via odds-api.io` at `2026-09-02T11:43:34Z`
- set the event to `SETTLED`
- recorded the run in `job_heartbeats`

That is the first time result ingestion has ever happened automatically here. No
script, no human.

**What did not happen.** The bet was on **away**, and away won 1-2. It is still
`PENDING`:

| Evidence | Reading |
|---|---|
| `bets.status = PENDING`, `settled_at` null | the bet never settled |
| 0 `PAYOUT` transactions for it | nobody was paid |
| all 5 markets still `OPEN`, last touched `00:19:35` | `close-markets`, the LAST step of `settleEvent`, never ran |
| **0 `settlement/event.finished` events** in the scheduler, ever | the fan-out was never dispatched |
| heartbeat: `processed_count 10`, `settled_count 0` | the poll found 10 finished events and settled none |

So `pollFinishedEvents` did its job and the hand-off to `settleEvent` did not
occur. **The cause is not yet identified and is not guessed at here.** Two facts
complicate the reading and are recorded rather than resolved:

- every `settlement-poll-results` run whose output could be read returned
  `{"skipped": true, "reason": "not due"}`, while the heartbeat simultaneously
  recorded a success with `processed_count: 10`. Both cannot be true of one run,
  so at least one run is missing from the dev server's retained history.
- the hourly provider budget was fully spent (`100/100`) and the last recorded
  error is `odds provider budget exhausted for the hour`.

**One design gap that IS certain.** The heartbeat wraps only the ingestion step,
and `settled` is hardcoded to `0` there. A run can therefore report success with
`settled_count: 0` while the dispatch after it fails or never happens, and the
stall alert stays quiet. `settled_count` cannot be anything but zero as written.

**Next diagnostic steps**, in order:

1. Capture the dev server's stdout to a file — it was discarded in this pass,
   which is exactly why the diagnosis stops here.
2. Let one poll run with provider budget available (the hourly budget resets on
   the hour) and watch for `settlement/event.finished` in the Inngest dev server.
3. Make the heartbeat cover the whole run and report a real `settled` count. As
   written it cannot tell "settled nothing because nothing was due" from "settled
   nothing because the fan-out broke" — which is the precise failure in front of
   it now.

Then re-run the observation with the bet above, or a new one. **Do not** close it
with `qa-settle-run.ts` or `qa-settle-one.ts`: they prove a human can settle a
bet, which was never in question.

**A local obstacle worth recording, because it is not only local:**

> Both database clients use `max: 1`. The comment justifies it as "a single
> connection per serverless instance avoids multiplying connection pressure
> during scale-out" — correct for Vercel-style serverless, where each invocation
> is its own instance. **Railway runs one persistent container**, so `max: 1`
> means the entire application serialises on a single connection, and one slow
> query against a cold Neon instance blocks every other request.
>
> The dev server wedged repeatedly during this session, including with the
> scheduler stopped, which is what makes this a connection-pooling problem rather
> than a scheduler-load one. It should be a launch review item for Railway
> specifically, not filed as a laptop quirk.

**Do not** close this item with `scripts/qa-settle-run.ts` or `qa-settle-one.ts`.
Those invoke settlement manually and prove only that a human can.

---

## 4. Fixture-sync performance

Measured before and after on the same dataset, same process, same database
(`npm run bench:sync`), both runs completed — no terminated measurement is quoted.

| Events | Before | After | Speedup | Statements | Transactions |
|---|---|---|---|---|---|
| 200 | 3,815–4,235 ms | 84–86 ms | **45–49×** | 4,000 → 24 (167×) | 400 → 2 |
| 775 | 12,832–15,505 ms | 1,457–2,193 ms | **7.1–8.8×** | 15,500 → 96 (162×) | 1,550 → 8 |

Ranges, not single figures: two runs of the same benchmark on the same machine
differ by that much depending on load, which is precisely why the tests assert
statement counts and not milliseconds. The statement reduction was **identical**
across runs.

Target was 3×. Statement count is the hardware-independent figure; on a hosted
database each statement is also a round trip, so the wall-clock gap is wider than
these loopback numbers show.

---

## 5. The rest of the product

Nothing here is started unless stated. **D** = developer-controlled,
**O** = owner/provider-controlled.

### Sportsbook features not built

| Item | Status | Who |
|---|---|---|
| **Cash out (full)** | `IMPLEMENTED_NOT_REACHABLE` — service + tests exist; **no API route, no caller** | D |
| **Cash out (partial)** | `IMPLEMENTED_NOT_REACHABLE` — `cashOutPartial` exists with tests; same gap | D |
| **Edit bet** | `NOT_IMPLEMENTED` — no code of any kind | D |
| Bet builder (correlated selections) | `NOT_IMPLEMENTED` — no code; also needs a pricing provider | D + O |
| Live / in-play betting | `BLOCKED_BY_CONTRACT` | O |
| Redis caching of `liveVersion` | `NOT_IMPLEMENTED` — confirmed: `liveVersion()` runs a three-table aggregate against Postgres on every `/api/live` request | D |
| Homepage / live-polling load tests | `PARTIAL` — a 500-concurrent-reader test exists for the odds read path; no HTTP-level homepage or `/api/live` load test | D |
| Prompt-injection tests for AI surfaces | `PARTIAL` — `ai/__tests__/guardrails.acceptance.spec.ts` exists; no dedicated injection corpus | D |

### Compliance and identity

| Item | Status | Who |
|---|---|---|
| DOB capture and enforcement | `VERIFIED_WORKING` — `users.date_of_birth` exists, `age.ts` validates, registration refuses underage with 403 | D |
| DOB **backfill** | `NOT_IMPLEMENTED` — the column is NULLABLE and **1 of 7 accounts has no DOB**; enforcement is not structural until it is NOT NULL | D + O |
| KYC identity verification | `BLOCKED_BY_CONTRACT` — no provider | O |
| Regulatory licensing | `BLOCKED_BY_REGULATION` | O |
| Independent RNG / platform certification | `BLOCKED_BY_REGULATION` | O |

### Third-party integrations

| Item | Status | Who |
|---|---|---|
| Paystack real deposit proof | `BLOCKED_BY_KEY` | O |
| Paystack real withdrawal proof | `BLOCKED_BY_KEY` | O |
| Termii real SMS proof | `BLOCKED_BY_KEY` | O |
| Resend real email / password-reset proof | `BLOCKED_BY_KEY` | O |
| Casino provider | `BLOCKED_BY_CONTRACT` | O |
| Live Casino provider | `BLOCKED_BY_CONTRACT` | O |
| Virtuals provider | `BLOCKED_BY_CONTRACT` | O |
| LLM provider for Pluto AI | `BLOCKED_BY_KEY` | O |
| Casino-callback load and security testing | `NOT_IMPLEMENTED` — needs the provider first | D + O |
| Pluto AI concurrency / load testing | `NOT_IMPLEMENTED` — needs a real model | D + O |

### Product surfaces not built

| Item | Status | Who |
|---|---|---|
| Fantasy | `NOT_IMPLEMENTED` — a `ComingSoon` stub page and a nav entry, no product | D |
| Lucky Numbers | `NOT_IMPLEMENTED` — no code | D |
| Personalisation | `NOT_IMPLEMENTED` — no code | D |
| Admin AI | `NOT_IMPLEMENTED` — no code | D |

### Operations

| Item | Status | Who |
|---|---|---|
| CI | `VERIFIED_WORKING` — see §7 | D |
| Settlement outbox, dispatcher, recovery sweep | `VERIFIED_WORKING` — §2b | D |
| Honest per-stage heartbeats and alerts | `VERIFIED_WORKING` — `docs/settlement-operations.md` | D |
| Railway connection pooling | `VERIFIED_WORKING` — was `max: 1`, now 10/5, validated | D |
| Benchmark ephemeral-database guard | `VERIFIED_WORKING` — 18 tests | D |
| Sentry production configuration | `BLOCKED_BY_OWNER_CONFIGURATION` — `SENTRY_DSN` unset | O |
| Credential rotation | `BLOCKED_BY_OWNER_CONFIGURATION` — see `OWNER_LAUNCH_CHECKLIST.md` | O |
| Restore drill | `BLOCKED_BY_OWNER_CONFIGURATION` — `docs/restore-runbook.md` | O |
| Railway database, Redis, `NEXTAUTH_URL` | `BLOCKED_BY_OWNER_CONFIGURATION` | O |
| ~~`max: 1` connection review for Railway~~ | **DONE** — §2b, `docs/settlement-operations.md` | D |
| Residual exposure on one market (₦230) | Needs owner decision — §2b | O |
| 400 synthetic fixtures in production | Cleanup ready, not run — `npm run db:clean-benchmark` | O approves, D runs |

---

## 6. Known contamination

An earlier version of the benchmark wrote through the shared pooled client, so
**400 invented fixtures** are in the production database and would appear on the
customer-facing board as real matches. They carry a `bench-<timestamp>` provider
tag and have **no bets against them** (verified).

`npm run db:clean-benchmark` reports them and changes nothing; `--confirm`
deletes them. It refuses outright if any bet references them, because that would
be a data-integrity problem and deleting the evidence would be the wrong
response. The benchmark no longer writes to a configured database — it boots its
own throwaway cluster.

---

## 7. Verification gates

Every figure below is from the final run on the pushed commit.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm run lint` | exit 0 — 0 errors, 15 pre-existing warnings |
| `npx vitest run` | **64 files, 810 passed, 0 failed, 1 skipped, 0 todo**, exit 0 |
| The 1 skip | the opt-in live provider contract (`ODDS_LIVE_CONTRACT`) — **not counted as passing** |
| `npm run build` | exit 0 |
| `node scripts/check-migrations.mjs` | 27 of 27 applied to a **clean** database, 62 tables |
| `npm run db:verify-restore` | 8 of 8 pass; ledger ₦2,035.00 debits = ₦2,035.00 credits, 0 negative wallets |
| `npm run admin:smoke` | all admin queries clean |
| `node scripts/secret-scan.mjs` | clean, 396 files, 15 rules |
| `git diff --check` | clean |
| `npm run bench:sync` | completed at 200 and 775 events — §4 |
| `npm run readiness:demo` | **exit 1**, correctly: `NEXTAUTH_URL` and the runtime database role — §2c |
| `npm run readiness:real-money` | **exit 1**, correctly: 14 blockers — §2c |
| `npm run db:audit-roles` | **exit 1**, correctly: runtime role owns the ledger — §2c |
| **GitHub Actions CI** | **completed / success on both remotes** at `363c937`, verified per-SHA via the API (not the badge) |

Test count rose from 736 to 810 across this work: +26 outbox, recovery, backoff
and transient-failure, +14 connection pool, +18 ephemeral guard, +12 runtime
role, +3 exposure replay, plus the replay regression test.

---

## 7b. Commits in this pass

Eleven commits, `de3eb16..4445c6e`, pushed fast-forward to both remotes. No
force-push, no rewrite of anything previously pushed.

| Hash | Commit |
|---|---|
| `8db76d3` | Make the dispatch reachable, and stop losing it between two systems |
| `60371ff` | Test the replay that every previous test was blind to |
| `e73e907` | Stop a double-tapped bet slip from eating a market's ceiling |
| `658742b` | Stop one slow query blocking the whole application on Railway |
| `c85c3eb` | Make the benchmark prove its target is disposable |
| `8b9e5e3` | Report the repair, and what the real bet actually did |
| `49c7472` | Allow the two fake values the guard tests assert are never echoed |
| `8a3b793` | Give each dispatch attempt its own delivery id |
| `67c0e8c` | Stop the booking-code test failing one run in seventy |
| `05d6275` | Record the fourth fault, which only appeared under real load |
| `4445c6e` | Make a failure alert say something |

**One thing needed an owner decision and got one.** GitHub push protection
blocked the first push: a guard test used a fake `sk_live_`-shaped fixture,
which GitHub classified as a Stripe API Key. It was never a credential — it
exists so a test can assert the refusal message does not echo it — but the
choice was between rewriting the unpushed commits and whitelisting a
Stripe-shaped string in the repository's secret-scanning history. The owner
chose the rewrite. The string is now absent from every commit, verified with
`git log --all -S`.

---

## 8. What the owner should do next, in order

1. **Rotate `IDENTITY_PEPPER`** — possible only while every account is a test
   account, permanently impossible after the first real customer.
2. Rotate Neon, Upstash, B2, Inngest, then odds-api.io.
3. Give Railway a database, Redis, and a real `NEXTAUTH_URL`.
4. Run `npm run production:check -- --remote=<url>` until it exits 0.
5. Seed the first administrator.
6. Approve the synthetic-fixture cleanup (§6).
7. Perform the restore drill (`docs/restore-runbook.md`) and record the numbers.
8. Decide the odds cadence now that the delta endpoint's real constraints are
   known (§2).
9. Resolve licensing before taking money from anybody.

Full detail and the exact order: `OWNER_LAUNCH_CHECKLIST.md`.
