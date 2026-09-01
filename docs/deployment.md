# Deploying PlutoBet

Works on **Railway** and **Vercel**. `npm run build` runs
`scripts/deploy-build.mjs`, which detects the host, applies migrations, and
then builds.

---

## Diagnosing a broken deployment: `/api/health`

**Open this first.** It is unauthenticated by design — a deployment that cannot
authenticate anybody is exactly when you need it — and it never reports a
configuration *value*, only whether each name is set and usable.

```
https://<your-domain>/api/health
```

```json
{
  "status": "unhealthy",
  "summary": "1 blocking problem(s): AUTH_SECRET | NEXTAUTH_SECRET",
  "checks": [
    { "name": "AUTH_SECRET | NEXTAUTH_SECRET", "state": "missing",
      "detail": "NOT SET — every page will return 500. Generate 32+ chars and set it",
      "blocking": true }
  ]
}
```

It returns **503** while anything blocking is wrong, so an uptime monitor treats
a misconfigured deployment as down rather than up.

### If every page returns "A server error occurred"

That is almost always **`AUTH_SECRET`**. NextAuth throws when its secret is
missing or under 32 characters, every page reads a session, so every page
becomes a 500 — including `/api/auth/providers`, which answers 500 with an
empty body. Static assets and the 404 page keep working, which makes it look
like the app is fine and only some pages are broken.

Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

---

## Required environment variables

### Blocking — the app returns 500 without these

| Variable | Notes |
|---|---|
| `AUTH_SECRET` | 32+ characters. `NEXTAUTH_SECRET` is accepted as an alias |
| `DATABASE_URL` | Pooled connection. `POSTGRES_URL` accepted |
| `REDIS_URL` | Rate limiting and OTP storage. `KV_URL` accepted |
| `IDENTITY_PEPPER` | **Never rotate this.** Every stored identity digest derives from it — rotating silently breaks self-exclusion for every existing account |

### Required to apply migrations at build time

| Variable | Notes |
|---|---|
| `MIGRATION_DATABASE_URL` | **Owner** role, unpooled. `DATABASE_URL_UNPOOLED` / `POSTGRES_URL_NON_POOLING` accepted |

This deliberately never falls back to `DATABASE_URL`. The runtime role must not
own the ledger tables — that separation is what stops application code from
altering a table a trigger depends on. Without an owner URL the build **warns
and skips migrations** rather than failing; `/api/health` then reports the
applied count so you can see the schema is behind.

### Strongly recommended

| Variable | Without it |
|---|---|
| `NEXTAUTH_URL` | Sign-in callbacks may redirect to the wrong host |
| `ODDS_API_KEY` | No fixtures, no prices — the board stays empty |
| `TERMII_API_KEY` + `TERMII_SENDER_ID` | OTP codes only print to the server log; **nobody can register** |
| `RESEND_API_KEY` + `RESEND_FROM` | Same, for email |
| `SENTRY_DSN` | No production error visibility |

### Money — deposits and withdrawals stay disabled without these

| Variable |
|---|
| `PAYSTACK_SECRET_KEY` |
| `PAYSTACK_PUBLIC_KEY` |

### Object storage (KYC documents)

`B2_ENDPOINT` · `B2_REGION` · `B2_BUCKET` · `B2_KEY_ID` · `B2_APPLICATION_KEY`

### Background jobs

`INNGEST_EVENT_KEY` · `INNGEST_SIGNING_KEY`

---

## Railway

Railway runs `npm run build` and sets `RAILWAY_ENVIRONMENT_NAME`, which the
build script detects to enable migrations.

1. Set the variables above in **Variables**.
2. Deploy.
3. Open `/api/health` and confirm `"status": "healthy"`.
4. Create the first admin: `npm run db:seed-admin` with `SEED_ADMIN_EMAIL` and
   `SEED_ADMIN_PASSWORD` set. There is no admin account until you do.

Railway's generated domain works, but set `NEXTAUTH_URL` to match it or
sign-in callbacks will point elsewhere.

## Vercel

Detected via `VERCEL_ENV === "production"`. The same variables apply; Vercel's
Postgres and KV integrations supply `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`
and `KV_URL`, all of which are accepted as aliases.

---

## After the first successful deploy

1. **Verify a database restore.** Neon has point-in-time restore; nothing here
   has ever restored from it, and an untested backup is not a backup.
   The procedure is written up in [`restore-runbook.md`](restore-runbook.md),
   and the verification half is implemented and tested
   (`npm run db:verify-restore`). The restore itself still needs Neon console
   access, so it remains `BLOCKED_BY_OWNER_CONFIGURATION`.
2. **Make one real low-value Paystack transfer.** The adapter is written
   against published docs and exercised only by fixtures.
3. **Select bookmakers in the odds-api.io dashboard.** With none selected,
   `/odds` answers `400 Missing bookmakers` and nothing is bettable.
4. **Rotate any credential that has been pasted into a chat or a ticket** —
   except `IDENTITY_PEPPER`, which cannot be rotated (see above).
