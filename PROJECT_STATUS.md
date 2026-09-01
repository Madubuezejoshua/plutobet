# PlutoBet — Current Status

**This is the single source of truth for what works today.** Every other status
document in this repository is historical evidence of a particular pass and is
banner-marked as such. Where they disagree with this file, this file is right.

**Last verified:** 2026-09-01 · branch `main` · see §7 for the exact gate output.

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
| **An unattended real settlement** | `WAITING_ON_REAL_EVENT` | Real bet placed and waiting — bet id and command in §3 |
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
- The board went from **0** to **333** open selections on upcoming fixtures.

**Placed, and now waiting on the match:** a real bet was registered, funded and
placed entirely through the public HTTP routes during this session.

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

**Why this is still `WAITING_ON_REAL_EVENT`:** the poller only considers an event
three hours after kickoff, so this bet becomes eligible at about
2026-09-02T04:00Z. Nobody has yet watched it settle, and until somebody has, the
claim is not made.

To watch it — the command runs in a `READ ONLY` transaction and cannot settle
anything:

```bash
npm run dev:all                                                    # app + scheduler
npm run settle:watch -- d7d34d58-507a-4bb0-95e0-338d1626d706 --follow
```

Expected on success: status `WON` or `LOST`, exactly one `PAYOUT` transaction if
it wins and none if it loses, the scheduler heartbeat showing a recent success,
and the ledger still balanced.

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
| Edit bet / cash out | `NOT_IMPLEMENTED` | D |
| Bet builder (correlated selections) | `NOT_IMPLEMENTED` · needs a pricing provider | D + O |
| Live / in-play betting | `BLOCKED_BY_CONTRACT` | O |
| Redis caching of `liveVersion` | `NOT_IMPLEMENTED` — every board read hits Postgres | D |
| Homepage and live-polling load tests | `NOT_IMPLEMENTED` | D |
| Prompt-injection tests for AI surfaces | `NOT_IMPLEMENTED` | D |

### Compliance and identity

| Item | Status | Who |
|---|---|---|
| DOB capture backfill and enforcement | `NOT_IMPLEMENTED` — needs an owner decision on existing accounts | D + O |
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
| Fantasy | `NOT_IMPLEMENTED` | D |
| Lucky Numbers | `NOT_IMPLEMENTED` | D |
| Personalisation | `NOT_IMPLEMENTED` | D |
| Admin AI | `NOT_IMPLEMENTED` | D |

### Operations

| Item | Status | Who |
|---|---|---|
| CI | `VERIFIED_WORKING` — see §7 | D |
| Sentry production configuration | `BLOCKED_BY_OWNER_CONFIGURATION` — `SENTRY_DSN` unset | O |
| Credential rotation | `BLOCKED_BY_OWNER_CONFIGURATION` — see `OWNER_LAUNCH_CHECKLIST.md` | O |
| Restore drill | `BLOCKED_BY_OWNER_CONFIGURATION` — `docs/restore-runbook.md` | O |
| Railway database, Redis, `NEXTAUTH_URL` | `BLOCKED_BY_OWNER_CONFIGURATION` | O |
| `max: 1` connection review for Railway | `NOT_IMPLEMENTED` — see §3 | D |
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

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm run lint` | exit 0 — 0 errors, 15 pre-existing warnings |
| `npx vitest run` | **59 files, 736 passed, 1 skipped, 0 todo**, exit 0 |
| The 1 skip | the opt-in live provider contract (`ODDS_LIVE_CONTRACT`) — **not counted as passing** |
| `npm run build` | exit 0 |
| `node scripts/check-migrations.mjs` | 26 of 26 applied to a **clean** database, 61 tables |
| `npm run db:verify-restore` | 8 of 8 checks pass; ledger ₦1,205.00 debits = ₦1,205.00 credits |
| `npm run admin:smoke` | all admin queries clean |
| `node scripts/secret-scan.mjs` | clean, 373 files, 15 rules |
| `git diff --check` | clean |
| `npm run bench:sync` | completed at 200 and 775 events — §4 |
| `npm run production:check` | **exit 1**, correctly: `NEXTAUTH_URL` points at localhost |
| **GitHub Actions CI** | **green on both remotes**, every step, first run |

The ledger figure above was taken before the QA bet in §3; after it the ledger
reads ₦1,605.00 debits = ₦1,605.00 credits, still balanced with 0 negative
wallets.

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
