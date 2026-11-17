# PlutoBet — Core Flow Validation

> ## HISTORICAL — not the current status
>
> **For what is true today, read [`general.md`](../../general.md).** That file
> is the single source of truth; where this one disagrees with it, it is right.
>
> This document is kept because the trail from a defect to its fix is worth
> reading. Nothing has been deleted from it, and findings that were later
> resolved are still described as they were found.



## 1. Executive result

**`PARTIAL — core flow works but listed blockers remain`**

The money core is sound and the settlement engine is proven deterministically
against real captured provider shapes. Four defects were found and fixed during
this validation, two of which were launch-blocking. Live pre-match placement
against a real fixture is **BLOCKED** on the odds ingestion completing — see
§5 and §9.

`PASS` is not claimed: Phase 7 (live bet placement on a real ingested event)
did not complete within this session.

---

## 2. Environment

| | |
|---|---|
| Branch | `main` |
| Commit at start | `d14b7e05be9b2f1226c4053377c0fab9d0afcd39` |
| Working tree at start | **NOT clean** — 16 uncommitted files (prior admin-panel work, preserved as instructed) |
| Environment tested | Local against the **live Neon database**, plus the deployed Railway app |
| Database | PostgreSQL (Neon serverless), 24/24 migrations applied, 60 tables |
| Odds provider | odds-api.io v3, bookmaker `1xbet` (plan permits 2) |
| Payments | **Paystack not connected.** No deposit or withdrawal was tested |
| Date | 2026-08-31 |

### Baseline results (before any change this session)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0** — clean |
| `npx vitest run` | **45 files, 572 passed, 1 skipped (573)** — exit 0 |
| `npx next build` | exit 0 on the pre-existing tree |

**No secret values appear anywhere in this report.**

### Resolving the test-count contradiction

The status document has claimed 549/42, 559/44 and 572/45 at different points.
The measured truth at baseline:

- **45 spec files**, all under `src/modules/**` — the only path the vitest
  `include` pattern collects, so none are orphaned or silently unrun.
- **572 passing, 1 skipped, 573 total.**

The single skip is the opt-in live provider contract block, which is skipped
unless `ODDS_LIVE_CONTRACT=1` and a key are both set. **It is not counted as
passing.**

The earlier "549" and "559" figures were simply stale. However, one run in this
session produced **571 passed / 1 failed** — an intermittent concurrency
failure documented as Bug 1 below. A count alone was never sufficient evidence.

---

## 3. Evidence table

| # | Requirement | Result | Command / path | Evidence |
|---|---|---|---|---|
| 1 | Registration through the real service | **PASS** | `scripts/qa-register.ts` → `registrationService.register` | user `8af6309c…` created; status ACTIVE, kyc 0 |
| 2 | Password hashed with argon2id | **PASS** | column inspection | hash begins `$argon2id$v=` |
| 3 | Age gate enforced | **PASS** | registration with a 17-year-old DOB | refused: "account holders must be at least 18 years old" |
| 4 | Duplicate email refused | **PASS** | re-register same email | refused: "an account with this email already exists" |
| 5 | Three wallet buckets created | **PASS** | `wallets` by `user_id` | `BONUS=0 CASH=0 LOCKED=0` |
| 6 | No unexplained opening balance | **PASS** | ledger entries for the new user | **0 entries**, CASH = 0 |
| 7 | Admin exists and holds correct RBAC | **PASS after fix** | `npm run db:seed-admin` | see Bug 2 — was a bootstrap deadlock |
| 8 | Admin sees the new user | **PASS** | `/admin/users` query | email, ACTIVE, kyc 0, unverified, CASH 20000 |
| 9 | QA funding via the real ledger | **PASS** | `scripts/qa-credit.ts` → `walletService.credit` | `ADJUSTMENT` 20000 kobo |
| 10 | Credit lands in CASH, not BONUS/LOCKED | **PASS** | bucket-explicit query | `CASH=20000 BONUS=0 LOCKED=0` |
| 11 | Double-entry balanced | **PASS** | ledger entries for the txn | DEBIT `ADJUSTMENTS_EQUITY` 20000 / CREDIT `USER CASH` 20000 |
| 12 | Global ledger balanced | **PASS** | sum by direction | debits 20000 = credits 20000 |
| 13 | Idempotent replay does not double-credit | **PASS** | same key twice | second call `idempotent: true`, balance still 20000 |
| 14 | Same key + different amount conflicts | **PASS** | same key, 50000 | `idempotency key was already used for a different operation` |
| 15 | QA credit refuses in production | **PASS** | `NODE_ENV=production` | REFUSED |
| 16 | QA credit requires explicit opt-in | **PASS** | without `ALLOW_QA_CREDIT` | REFUSED |
| 17 | QA credit rejects non-integer money | **PASS** | amount `200.00` | REFUSED — kobo only |
| 18 | Deterministic settlement: WON | **PASS** | `settlement.acceptance.spec.ts` | pays exactly once across 5 replays of the result feed |
| 19 | Deterministic settlement: LOST | **PASS** | same suite | status LOST, 0 payout legs |
| 20 | Deterministic settlement: VOID | **PASS** | same suite | stake returned exactly once, no profit |
| 21 | Lock contention returns a typed error | **PASS after fix** | `contention.acceptance.spec.ts` | see Bug 1 |
| 22 | Admin panel queries run against real schema | **PASS after fix** | `npm run admin:smoke` | 18/18 clean; 2 invented columns found |
| 23 | Redis reachable | **FAIL → fixed** | ioredis PING | see Bug 3 — was pointing at `localhost` |
| 24 | `/api/health` on the deployment | **BLOCKED** | `GET /api/health` | 404 — the endpoint is written but **not yet deployed** |
| 25 | `NEXTAUTH_URL` correct in production | **FAIL** | `GET /api/auth/providers` | callbacks point to `http://localhost:3000` — see Bug 4 |
| 26 | Real fixture + odds ingestion | **IN PROGRESS** | `scripts/qa-odds-sync.ts` | blocked for 25 min by Bug 3; re-run after the fix |
| 27 | `1x2` market available | **PENDING** | same | depends on #26 |
| 28 | Live pre-match bet placement | **BLOCKED** | — | depends on #26/#27 |
| 29 | Paystack deposit / withdrawal | **NOT TESTED** | — | no live credentials; explicitly out of scope |

---

## 4. Account and admin validation

**Registration works.** A QA account was created through
`registrationService.register` — the same path the public API uses — not by
inserting a row. Evidence: user id `8af6309c…`, status `ACTIVE`, `kyc_level 0`,
three wallet buckets all at zero, and **zero ledger entries**, confirming no
unexplained opening balance.

**Verification is code-complete but externally blocked.** `email_verified_at`
and `phone_verified_at` are both null. Termii and Resend hold no credentials,
so OTP codes are written to the server log rather than delivered. The
registration and OTP code paths work; **real SMS and email delivery remain
externally blocked.** No production verification bypass was added.

**The admin could not exist at all before this session** — see Bug 2. After the
fix, the seeded admin holds exactly one grant, `SUPER_ADMIN`, with an explicit
audit reason, and `must_change_password` is true.

**Admin visibility confirmed.** The `/admin/users` query returns the QA account
with correct email, status, KYC tier and CASH balance. The `/admin/ledger`
query returns the QA credit as an `ADJUSTMENT` with two entries and the reason
`QA_VALIDATION_CREDIT`.

---

## 5. Real odds validation

*(Completed after the Redis fix — see §9 for final status.)*

- **Provider:** odds-api.io v3, real configured key.
- **Bookmaker:** `1xbet`. The account plan permits **two** bookmakers; a
  request naming three returned `403 Access denied. You're allowed max 2`.
- **Response shapes are pinned** by `provider-contract.acceptance.spec.ts`
  against real captured fixtures. The API key is scrubbed recursively before
  any fixture is written, and the committed fixtures were verified to contain
  no key.
- **`sport` is stored as a real slug**, not `[object Object]` — a regression
  fixed earlier and now asserted on every test run.
- **String prices are converted safely**: values arrive as strings such as
  `"1.584"`; anything non-finite or ≤ 1.0 is dropped rather than shown.
- **Corner markets do not collide with goal markets.** `Corners Totals` maps to
  `null` rather than `over_under`, so a corners bet can never settle against
  the goal count. Pinned by a test.

**`1x2` availability: see §9.** It did not appear in the one bookmaker payload
captured earlier in the project, and confirming it is a named blocker rather
than an assumption.

---

## 6. Bet and settlement evidence

### Live pre-match placement — BLOCKED

Not completed this session. Odds ingestion was blocked for ~25 minutes by the
Redis misconfiguration (Bug 3) and re-run afterwards.

### Deterministic settlement — PASS

Proven by `src/modules/settlement/__tests__/settlement.acceptance.spec.ts`,
which drives the production settlement service, real database constraints and
real ledger posting inside an isolated test database:

| Case | Assertion | Result |
|---|---|---|
| **WON** | replaying the same result feed 5 times pays exactly once | PASS |
| **LOST** | settles without paying anything (0 payout legs) | PASS |
| **VOID** | refunds the stake exactly — not the amount it would have won | PASS |
| Exposure | market exposure reserved at placement is released | PASS |
| Accumulator | a void leg is recalculated at odds 1.0 | PASS |
| Partial | a bet stays PENDING while any event has no result | PASS |
| Market closure | markets close so nothing can be placed on a finished match | PASS |

No bet status was ever changed directly in the database.

---

## 7. Admin evidence

| Admin must see | Result |
|---|---|
| New user | **YES** — email, status, KYC tier, verification state |
| QA credit | **YES** — `ADJUSTMENT`, both ledger legs, reason `QA_VALIDATION_CREDIT` |
| Pending bet | **NOT VERIFIED LIVE** — the `/admin/bets` query runs clean against the real schema, but no live bet was placed |
| Settled result / payout | **NOT VERIFIED LIVE** — proven in integration tests instead |
| Audit entry | **PARTIAL** — the ledger transaction carries the QA reason in metadata; see the caveat in §8, Bug 5 |

---

## 8. Bugs found and fixed

### Bug 1 — a lock timeout escaped as an untyped database error

**Root cause.** Money paths run with `SET LOCAL lock_timeout = '30s'`. Under
contention the `SELECT … FOR UPDATE` on the wallet row can exceed it, and
PostgreSQL raises `55P03`. Drizzle wraps driver errors and hangs the original
off `cause`, so nothing mapped it.

**Impact.** The error reached the API unmapped — an opaque 500 for a customer
placing a bet during a burst, and no way for any caller to distinguish "retry
in a moment" from a genuine fault. **Money integrity was never at risk**: the
balance still reconciled, because the transaction had not written anything.

Found by the 100-way concurrency hammer failing on run 19 of 20 — an
intermittent failure that earlier runs had missed.

**Files changed.** `src/modules/wallet/errors.ts` (new `WalletContentionError`),
`src/modules/wallet/wallet.service.ts` (map `55P03`/`40P01`, walking the
`cause` chain with a depth cap; `WALLET_LOCK_TIMEOUT` made configurable and
pattern-validated because it is string-interpolated into `SET LOCAL`).

**Tests added.** `src/modules/wallet/__tests__/contention.acceptance.spec.ts` —
3 tests: the timeout raises the typed error and writes nothing; ordinary
insufficient funds is still `InsufficientFundsError` and not swallowed; a
malformed `WALLET_LOCK_TIMEOUT` is ignored rather than injected into SQL.

The concurrency hammer was also corrected to assert **conservation of money**
rather than a fixed success count. Requiring exactly 60 successes assumed no
operation ever loses the lock race, which is a statement about timing, not
correctness. It now asserts the balance equals funding minus exactly the debits
that succeeded, that nothing overdrew, and that every rejection is typed — and
still requires the exact 60/0 outcome whenever no contention occurred.

**Result.** 3/3 passing.

---

### Bug 2 — the admin panel was permanently unreachable (LAUNCH-BLOCKING)

**Root cause.** `RbacService.identify` requires **both** `users.role = 'ADMIN'`
**and** a row in `admin_role_grants`. `scripts/seed-admin.ts` created only the
users row. `RbacService.grant` refuses unless the actor already holds
`SUPER_ADMIN`, and refuses self-granting outright.

**Impact.** A deadlock, not an error. On a fresh deployment the seeded admin
could sign in and was then denied **every** admin page, with no path in the
application to fix it. Confirmed on the live database: the seeded admin had
`role = ADMIN` and **zero grants**.

**Files changed.** `scripts/seed-admin.ts` — the seed now issues the initial
`SUPER_ADMIN` grant inside its existing advisory-locked transaction, with
`granted_by` set to the new admin itself and a reason recording that no other
actor existed. Guarded on there being no live super admin anywhere, so it is a
bootstrap and never a way to re-elevate a revoked account. It also repairs an
admin seeded before this fix, which is exactly the state this database was in.

**Result.** Grant present, one row, correct reason. Running the seed three
times leaves exactly one `SUPER_ADMIN` grant — idempotent.

---

### Bug 3 — Redis pointed at localhost, silently hanging the odds pipeline

**Root cause.** `REDIS_URL` was `redis://localhost:6379`. The real Upstash
instance was configured only as `UPSTASH_REDIS_REST_URL`, which `ioredis`
cannot use — it speaks the Redis TCP protocol, not the REST API.

**Impact.** `ApiBudget.spend()` calls Redis before **every** provider request.
With Redis refusing connections, the odds sync produced **zero events in 25
minutes** with no error surfaced. The same dependency backs rate limiting and
OTP storage, so both were inert.

**Fix.** `REDIS_URL` repointed to the Upstash TCP endpoint
(`rediss://…:6379`), verified with a real `PING` → `PONG`. Written only to the
gitignored `.env`; **the value does not appear in this report or in source
control.**

**Remaining action for the operator:** Railway must be given the same TCP URL.
A REST URL there will fail the same way.

---

### Bug 4 — `NEXTAUTH_URL` is wrong on the deployed app

**Evidence.** `GET /api/auth/providers` on the live deployment returns
`signinUrl` and `callbackUrl` of `http://localhost:3000/…`.

**Impact.** Sign-in callbacks point at the customer's own machine. Not fixed
here because it requires Railway variable access, which this session does not
have — see §9.

---

### Bug 5 — QA funding produces no admin audit row

**Found while validating Phase 6.** The QA credit posts a correct, balanced
`ADJUSTMENT` and carries `reason: QA_VALIDATION_CREDIT` in transaction
metadata, and it is visible in the ledger view. It does **not** write a row
attributing the action to a named administrator, because it runs as
`actor: { type: "SYSTEM" }` from a script rather than through an
authenticated admin action.

**Assessment.** Acceptable for a QA script that is disabled outside
development, and explicitly *not* acceptable as a pattern for any real
adjustment. A production wallet adjustment must run through an authenticated
admin path carrying `wallet.adjust` and a mandatory reason. Recorded rather
than fixed, because building that path is outside this validation's scope.

---

### Bug 6 — two invented column names in the new admin pages

Found by executing every admin query against the real schema rather than
trusting typecheck: `bets.bet_type` and `casino_providers.status` do not exist
(the real schema has `slip_id`/`combination_index`, and `active`). Both
typechecked cleanly, because SQL inside a template literal is not checked.

**Fix.** Bet type is now derived from leg count and combination index; the
casino query uses `active`. `npm run admin:smoke` executes all 18 admin queries
against the live database and is the regression guard.

---

## 9. Remaining external blockers

| Blocker | Owner | Detail |
|---|---|---|
| **Paystack live keys** | Business | No deposit or withdrawal was tested, and none can be. `PAYSTACK_SECRET_KEY` is empty |
| **Termii** | Business | SMS OTP prints to the server log; nobody can verify a phone |
| **Resend** | Business | Same for email verification and password reset |
| **Railway variable access** | Business | `NEXTAUTH_URL` (Bug 4) and `REDIS_URL` (Bug 3) must be set in Railway. The CLI could not be installed in this session; a stuck `postinstall` held the install directory and the retry was interrupted |
| **`/api/health` not deployed** | Engineering | The endpoint exists in the working tree but is uncommitted, so the deployment still returns 404 |
| **Odds plan bookmaker coverage** | Business | The plan permits 2 bookmakers. If `1x2` is absent from `1xbet`, a second bookmaker or a plan upgrade is required |
| **KYC provider** | Business | Not exercised in this validation |
| **Licensing** | Business | FSGRN/state licence is a legal process, unaffected by this work |

---

## 10. Conference-call explanation

Plain language, for a non-technical reading.

**How a user registers.** Someone enters their email, phone, date of birth and
a password. We check they are at least 18 — a 17-year-old is refused, and we
tested that. The password is never stored; we store a one-way scramble of it,
so even we cannot read it back. Three wallets are created for them — cash,
bonus and locked — all starting at zero. We confirmed a brand-new account has
no money in it and no transactions.

**How the admin sees the user.** Every account appears in the admin panel with
their status, verification state and balance. Before this review the admin
panel could not be opened **at all** — the account that was supposed to run the
business had no permissions and there was no way to give it any. That is fixed.

**How real odds enter PlutoBet.** A scheduled job asks our odds supplier for
real upcoming matches and their prices, and stores them. During this review we
found the job had been silently doing nothing, because it checks a usage
counter stored in a service that was pointed at the wrong address. That is
fixed.

**How the user's stake is removed.** The moment a bet is accepted the stake
leaves their spendable balance — not when the match finishes. If someone has
₦200 and bets ₦200, their balance is ₦0 immediately. They cannot spend the same
money twice, and we tested a hundred simultaneous attempts to do exactly that.

**How the locked odds are stored.** The price shown when the bet is placed is
frozen onto that bet. If the price moves afterwards, the customer's bet is
unaffected — settlement reads the frozen price, never the current one.

**What happens when the user loses.** The bet is marked lost and nothing is
paid. The stake had already left their balance, so nothing further changes.

**What happens when the user wins.** We multiply their stake by the frozen
odds and pay exactly that into their cash wallet. We tested processing the same
result five times over: they are paid **once**. A cancelled match returns the
stake exactly — no profit, and not twice.

**How the ledger prevents unexplained money.** Every movement is recorded
twice, as a matching pair — money leaving one place and arriving in another.
The database itself rejects any entry that does not balance, so money cannot be
created or destroyed even by faulty code. Corrections are never edits; they are
new offsetting entries, so history cannot be rewritten.

**What remains before real deposits and withdrawals.** Paystack keys, which
need the registered business. Until then no real money can move, and nothing in
this review tested it. Termii and Resend are also needed before customers can
verify a phone or email. Two settings must be corrected in the hosting
dashboard: the site's public address, and the address of the usage-counter
service.

---

*Validation performed 2026-08-31 against branch `main` at
`d14b7e05be9b2f1226c4053377c0fab9d0afcd39`. No real customer data, no real
money, and no live payment credentials were used.*
