# PlutoBet — Owner Launch Checklist

Everything in this document needs an account holder. None of it can be done from
the codebase, and none of it has been done for you.

**No credential value appears anywhere in this file, and none should be added to
it.** Where a step needs a secret, it says where to paste it, never what it is.

Run `npm run production:check` after each section. It exits non-zero while a
launch-blocking dependency is missing and never prints a value.

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

## 13. Two decisions waiting on you

**The 400 synthetic fixtures.** `npm run db:clean-benchmark` has been run in dry
run only. It found 400 events with a `bench-<timestamp>` provider tag, and
confirmed **0 markets, 0 selections, 0 odds snapshots, 0 results, 0 bets and 0
audit rows** reference them. Teams and competitions are shared taxonomy and would
be preserved. Re-run with `--confirm` to delete. Nothing was deleted for you.

**₦230 of residual liability on one market.** A duplicate submit reserved
exposure twice, before that bug was fixed. The bug is fixed and cannot recur;
this is historical data in a money-adjacent table, so correcting it is your call
rather than something to quietly `UPDATE`. It is visible as
`unreleasedExposureMarkets` in the recovery sweep's health output.

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

## Known contamination to clear before launch

`npm run db:clean-benchmark` (dry run by default) reports **400 synthetic
fixtures** currently in the production database, created by an earlier run of the
benchmark script when it still wrote to the configured database. They carry a
`bench-<timestamp>` provider tag, have no bets against them, and would otherwise
appear on the customer-facing board as real matches.

The benchmark no longer does this — it starts its own throwaway database — but
the existing rows need removing. Review the dry run, then re-run with `--confirm`.
