# PlutoBet — Owner Launch Checklist

Everything in this document needs an account holder. None of it can be done from
the codebase, and none of it has been done for you.

**No credential value appears anywhere in this file, and none should be added to
it.** Where a step needs a secret, it says where to paste it, never what it is.

Run `npm run production:check` after each section. It exits non-zero while a
launch-blocking dependency is missing and never prints a value.

**For the state of the platform itself, read [`general.md`](general.md).** This
file is only the list of things that need an account holder.

---

## 0. Before anything else — read this

Several credentials were pasted into a chat transcript during development. Treat
every one of them as public:

- Neon database URLs (pooled, direct, migration)
- Upstash Redis URL
- Backblaze B2 application key
- Inngest event and signing keys
- odds-api.io key

They still work. That is the problem. Nothing below is safe until they are
replaced, and **step 1 stops being possible at all once a real customer
registers.**

Rotation was deliberately NOT performed for you. Rotating a live credential
breaks the running service, needs access this project does not have, and is the
owner's decision to schedule.

---

## 1. `IDENTITY_PEPPER` — FIRST, and only while it is still possible

**Why first:** every stored identity digest is derived from it. Rotating it
invalidates every existing digest. That is harmless today because every account
is a disposable test account, and permanently impossible the moment one real
customer's identity is stored.

**Prove the window is still open before touching it:**

```bash
npm run production:check          # reports the account picture
```

Then confirm in the database that every user is a test identity — every address
ending `@plutobet.test`, and no KYC record belonging to a real person. If even
one real identity exists, **stop**: the old pepper must be kept, and rotation
becomes a data-migration project rather than a config change, because each
digest has to be recomputed from source identity data you may no longer hold.

**If the window is open:**

1. Generate 32+ random characters with a password manager or
   `openssl rand -base64 32`. Do not type it into a terminal that keeps history.
2. Paste it into the Railway service variables as `IDENTITY_PEPPER`.
3. Discard the old value.
4. Re-run `npm run production:check`.

**Consequence, stated plainly:** existing test-account KYC digests and
self-exclusion hashes stop matching. For disposable test accounts that costs
nothing. For real customers it would silently break self-exclusion — a person
who excluded themselves could register again — which is why this is step one and
not step six.

---

## 2. Neon database credentials

Three URLs, all currently exposed:

| Variable | Used by |
|---|---|
| `DATABASE_URL` | pooled runtime reads |
| `DIRECT_DATABASE_URL` | the money path (unpooled, never PgBouncer) |
| `MIGRATION_DATABASE_URL` | migrations, as the table OWNER |

1. In the Neon console, reset the role password.
2. Update all three variables in Railway. They may share a password but they are
   different endpoints — the pooled one must stay the pooler, the direct one must
   stay unpooled, or `SELECT … FOR UPDATE` stops locking what you think.
3. `npm run production:check` — it reports which role each URL connects as.

**Known finding:** all three currently connect as `neondb_owner`, the owner of
the ledger tables. The money paths issue `SET LOCAL ROLE app_role` inside every
transaction, so the separation still holds where it matters, but everything
outside a money transaction runs with owner rights. Creating a dedicated
least-privilege role for `DATABASE_URL` is the stronger configuration and is
worth doing while you are already rotating.

---

## 3. Upstash Redis

1. Rotate the credential in the Upstash console.
2. Set `REDIS_URL` to the **TCP** endpoint — `rediss://…:6379`.

**The mistake to avoid:** Upstash shows the REST endpoint most prominently. This
application uses `ioredis`, which does not speak REST. A REST URL produces a
connection error at runtime, not at deploy time, so the deployment looks healthy
and rate limiting, OTP storage and the scheduler lock all fail. `npm run
production:check` detects and names this specific error.

---

## 4. Backblaze B2

Rotate the application key and update `B2_KEY_ID` and `B2_APPLICATION_KEY`.
KYC document upload is unavailable until this is done — non-blocking for a soft
launch, blocking before you accept a withdrawal that needs identity verification.

---

## 5. Inngest

Rotate the event key and the signing key, then update `INNGEST_EVENT_KEY` and
`INNGEST_SIGNING_KEY`.

The signing key is what stops a stranger invoking your scheduled jobs — including
settlement — by posting to `/api/inngest`. Do not deploy with the exposed one.

---

## 6. odds-api.io

Rotate last. Rotating it interrupts ingestion, so pick a moment when an empty
board costs nothing. Update `ODDS_API_KEY`.

---

## 7. `NEXTAUTH_URL`

Set it to the real public HTTPS origin, e.g. `https://<your-app>.up.railway.app`,
with no trailing slash.

While it points at localhost — which is its current state — sign-in callbacks
redirect users to their own machine and nobody can log in. `npm run
production:check` treats this as launch-blocking.

---

## 8. Give Railway a database and Redis

The deployment currently has neither. Until it does it cannot serve a single
customer, and no amount of application work changes that. Set every variable
above in the Railway service, not only in a local `.env`.

---

## 9. Health and migration checks

```bash
npm run production:check -- --remote=https://<your-app>.up.railway.app
```

Then open `/api/health` on the deployment. It reports each dependency as ok,
missing, invalid or error, and never returns a value. It answers **503** while a
blocking dependency is unhealthy, so an uptime monitor treats a misconfigured
deployment as down rather than as fine.

Migrations run during deployment. If the owner URL is absent they are SKIPPED
with a warning and the build still succeeds — check the applied count on
`/api/health` rather than assuming.

---

## 10. Seed the first administrator

```bash
npm run db:seed-admin
```

Use a real password manager. Do not reuse a development password, and do not
paste the value into a chat, a ticket or a shell that records history.

---

## 11. Confirm the scheduler is actually running

This is the step most likely to be skipped and the most expensive to skip. A
sportsbook whose scheduler is not running takes bets and never pays them.

```bash
npm run production:check          # reports the scheduler heartbeat
```

The heartbeat must show a **recent success**, not merely a row. `no job has EVER
recorded a run` means nothing is triggering settlement, and every bet placed will
sit `PENDING` until a human notices.

To watch one specific bet settle without being able to influence it:

```bash
npm run settle:watch -- <betId> --follow
```

That command runs inside a `READ ONLY` transaction, so the database itself
rejects any write it might attempt.

---

## 12. Optional: connection pool sizing

Defaults are 10 pooled reads and 5 on the money path, sized for ONE persistent
Railway container. Override with `DATABASE_POOL_MAX` and
`DIRECT_DATABASE_POOL_MAX` only if you have a reason from real traffic.

Invalid, zero, negative or excessive values are **refused at boot**, not clamped:
Neon's compute has a bounded `max_connections` shared by every client, and
exhausting it fails requests outright rather than queueing them. `npm run
production:check` reports the configured sizes.

---

## 13. THE FIRST THING TO FIX: the runtime database role

**All three configured database URLs connect as `neondb_owner`, which owns the
ledger tables.** Verified, not inferred — `npm run db:audit-roles` prints the
evidence.

The money paths issue `SET LOCAL ROLE app_role` inside every transaction and
are safe. **The pooled READ client does no role handling at all**, and
thirty-four files import it: every board query, every admin page, every public
route. A SQL-injection or a compromised dependency on any of those paths
inherits the ability to `DROP`, `ALTER` or `TRUNCATE` the ledger, disable the
balance-enforcement trigger, and grant itself more.

Using `SET ROLE` on the pooled connection would NOT fix this reliably: the
pooled URL goes through Neon's transaction-mode pooler, where a session-level
`SET ROLE` does not dependably survive to the next transaction. The fix is a
separate credential.

**In the Neon SQL editor, as the owner:**

```sql
CREATE ROLE plutobet_app LOGIN PASSWORD '<generate a strong one>';
GRANT app_role TO plutobet_app;
GRANT USAGE ON SCHEMA public TO plutobet_app;
ALTER ROLE plutobet_app SET role = 'app_role';
```

Then set **`DATABASE_URL`** (the pooled runtime URL, and only that one) to
connect as `plutobet_app`. Leave `DIRECT_DATABASE_URL` and
`MIGRATION_DATABASE_URL` as they are — the money path needs the unpooled
endpoint, and migrations legitimately need the owner.

Verify:

```bash
npm run db:audit-roles          # runtime row must show: owns ledger tables  no
npm run production:check        # "runtime db role" must be PRESENT
```

`production:check` now **fails** while the runtime role owns the ledger. It used
to report this beside a passing check, as a note. It is not a note.

---

## 14. Two readiness modes, and why the difference matters

```bash
npm run readiness:demo          # can this serve a test account, end to end?
npm run readiness:real-money    # may this take a stranger's money?
```

A previous report said "NEXTAUTH_URL is the only remaining launch blocker". That
was the only blocker the infrastructure checker could SEE, which is a very
different sentence. Real-money launch is additionally blocked by payment
credentials, notification delivery, identity verification, credential rotation,
a proven restore, error reporting and a gaming licence — none of which is
implied by the demo passing.

**QA ledger credit is not a deposit and must never be presented as one.**

---

## 15. APPROVAL BLOCK — delete the 400 synthetic fixtures

Nothing has been deleted. This is the evidence; the decision is yours.

**Verify immediately before approving** (read-only, changes nothing):

```bash
npm run db:verify-cleanup
```

| | |
|---|---|
| Exact count to delete | **400 events** |
| Predicate | `provider ~ '^bench-[0-9]+$'` |
| Matched tags | `bench-1788273932228` (200), `bench-1788276430186` (200) |
| Other providers in table | `odds-api.io` — **does not match the filter** |
| Tables affected | `events`, plus their `markets`, `selections`, `odds_snapshots`, `event_results` (all currently **0**) |
| Tables preserved | `teams` (1,697), `competitions` (212), `bets`, `ledger_*`, `wallets`, `users`, `audit_log` |

**Pre-deletion checks, all currently passing:** 0 markets, 0 selections, 0 odds
snapshots, 0 results, 0 bets and 0 audit rows reference them; every matched tag
is a benchmark tag; no legitimate provider matches the filter.

**Recovery method:** Neon point-in-time restore to a scratch branch. The
synthetic rows were created `2026-09-01T14:45:50Z`, so any restore point before
that recovers the pre-contamination state. See `docs/restore-runbook.md`.

**To approve and run:**

```bash
npm run db:verify-cleanup       # confirm all checks still pass
npm run db:clean-benchmark -- --confirm
npm run db:verify-cleanup       # post-deletion: expect 0 synthetic events
```

The cleanup **refuses** if any bet references them, and never touches teams or
competitions — a real fixture may legitimately reference the same club.

---

## 16. APPROVAL BLOCK — repair ₦630 of residual exposure

**Corrected figure.** An earlier report said ₦230 on one market. The full audit
found **two** markets totalling **₦630**.

| Market | Fixture | Residual |
|---|---|---|
| `701daa4f-8b00-4d36-bf97-5ef236a3e52a` | Dinthar FC v Saikhamakawn FC `1x2` | ₦400.00 |
| `822cfe03-f701-4251-86e4-3a3e7842baed` | Fortaleza FC v CD Once Caldas `1x2` | ₦230.00 |

**What happened.** Placement claims exposure BEFORE it can detect an idempotent
replay — it must, because the global lock order is exposure-then-wallet and
inverting it would deadlock against settlement. A re-submitted slip therefore
claimed the liability twice and created no second bet for settlement to release.
Each residual is exactly `potential_return - stake` for its one bet.

**The code defect is fixed** (the replay path now releases exactly what that
attempt claimed, with tests). These are the rows it left behind.

**No money is involved.** Exposure is a RISK LIMIT, not a balance: it caps what
the book may stand to lose on one market. Verified before proposing any repair —
the ledger nets to zero, every affected bet has exactly one payout, and both
markets are already `SETTLED`. **No wallet or ledger row will be touched.**

**The invariant after repair:** a market with no `PENDING` bets holds zero
liability.

**To approve and run:**

```bash
npm run db:repair-exposure                                   # dry run, prints a fingerprint
npm run db:repair-exposure -- --expect=<fingerprint> --confirm
```

The confirmed run **refuses without the fingerprint from a dry run**, and
refuses again if the data has changed since — approving a repair you have read
and applying one you have not are different acts. It runs in one transaction,
locks each row, re-checks the pending-bet condition under the lock, skips any
market where a bet has since been placed, writes an audit row, and reconciles
afterwards.

---

## Still blocked, and not by anything in this checklist

| Item | Blocked by |
|---|---|
| Deposits and withdrawals | Paystack account and keys |
| SMS one-time codes | Termii account and keys |
| Email and password reset | Resend account and domain verification |
| KYC identity verification | No provider contracted |
| Casino, Live Casino, Virtuals, In-play, Bet Builder | No provider contracted |
| Pluto AI (real model) | No LLM key |
| Error reporting | `SENTRY_DSN` unset |
| Operating legally | Licensing and independent certification |

The last row is not a software task. Taking real money from Nigerian customers
without the appropriate licence is a legal exposure that no amount of test
coverage addresses, and it should be resolved before, not after, a public launch.

---

## Decisions only you can make

These are **not** blocked on a key, a contract or effort. They are blocked
because building them means deciding the financial or responsible-gambling rules
of a money feature, and a developer inventing those is how a betting product
acquires rules nobody chose. Each is recorded in `general.md` as
`BLOCKED_BY_PRODUCT_DECISION` with the same questions.

### Edit bet

Nothing in the repository defines it. Needed before it can be built:

1. **Eligibility** — which bets, how long after placement, before or after
   kick-off.
2. **Fees** — is there a charge, and is it a percentage or a flat amount.
3. **Odds-change consent** — a rebooked bet is priced again. Does the customer
   agree to the new price, and how is that agreement recorded.
4. **Promotional stakes** — a bonus-funded bet edited into a different one is a
   wagering-requirement question, not a betting one.

### Personalisation

The data exists and it needs no model. What does not exist:

1. **What is surfaced** — a fixture, a market, or a stake size. A recommended
   *stake* is a different product, and a different regulatory object, from a
   recommended fixture.
2. **On what signal.** Betting history is the obvious one, and it is also the
   signal that most reliably identifies somebody losing.
3. **When it is suppressed** — for a customer under a deposit limit, in
   cool-off, showing loss-chasing behaviour, or flagged by the risk console. A
   recommender with no suppression rule pushes hardest at the customer it should
   push at least.
4. **Whether it counts as marketing.** `user_preferences.marketing_emails`
   already records a consent this would have to respect, and Nigerian rules on
   gambling advertising bear on the answer.

### Admin AI

Additionally blocked by the absence of an LLM key. Beyond that: **which admin
actions may an assistant take** over a console that approves withdrawals,
adjusts exposure and settles bets. That needs its own tool registry and
permission model, and the list is yours to set.

---

## Known contamination to clear before launch

`npm run db:clean-benchmark` (dry run by default) reports **400 synthetic
fixtures** currently in the production database, created by an earlier run of the
benchmark script when it still wrote to the configured database. They carry a
`bench-<timestamp>` provider tag, have no bets against them, and would otherwise
appear on the customer-facing board as real matches.

The benchmark no longer does this — it starts its own throwaway database — but
the existing rows need removing. Review the dry run, then re-run with `--confirm`.
