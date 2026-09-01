# Bet Platform

[![CI](https://github.com/plutobet-ai/plutobet_ai/actions/workflows/ci.yml/badge.svg)](https://github.com/plutobet-ai/plutobet_ai/actions/workflows/ci.yml)

**Current status: [`PROJECT_STATUS.md`](PROJECT_STATUS.md)** — the single source
of truth for what works, what is waiting on a real event, and what is blocked on
an owner decision. Other status documents in this repository are historical.

**Before launching: [`OWNER_LAUNCH_CHECKLIST.md`](OWNER_LAUNCH_CHECKLIST.md).**

Phase 1 of the Nigerian sports-betting platform: an auditable wallet,
append-only double-entry ledger, authentication foundation, and durable daily
reconciliation. Later betting, payments, odds, KYC, and casino phases are
intentionally not mixed into this money foundation.

## Money-path guarantees

- All amounts are `bigint` kobo in TypeScript and `BIGINT` in PostgreSQL.
- Each movement creates one immutable transaction header, balanced debit and
  credit legs, the exact resulting user balance, and audit evidence atomically.
- Deferred PostgreSQL triggers reject empty, unbalanced, malformed, or
  cache-divergent ledger commits.
- User wallet rows are locked with `SELECT ... FOR UPDATE` under explicit
  `READ COMMITTED` transactions. Transfers lock both wallets in UUID order.
- Caller-supplied idempotency keys are serialized across instances with
  transaction-scoped PostgreSQL advisory locks. An exact replay returns the
  original result; reusing a key for a different operation raises a typed
  conflict instead of falsely reporting that the new operation succeeded.
- Money code uses only an unpooled database URL; ordinary reads and Auth.js use
  a pooled URL. Vercel's generated Postgres and Neon aliases are supported.
- Daily Inngest reconciliation replays each wallet independently and emits a
  critical Sentry event for any drift.

The public module boundary is `src/modules/wallet/index.ts`. Ledger schemas and
the direct client are deliberately private to that module, reinforced by
ESLint import restrictions and database role permissions.

## Local setup

Requirements: Node.js 20.9+ and Docker for the development database.

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`, replace `AUTH_SECRET`, and set the two admin
   seed values only when you are ready to provision the first admin.
3. Start PostgreSQL with `docker compose up -d postgres`.
4. Apply the owner migration with `npm run db:migrate`.
5. Seed the first admin with `npm run db:seed-admin`.
6. Start Next.js with `npm run dev`.

The Docker credentials are local-only. Production must use three concerns:

- `DATABASE_URL`: pooled Neon URL for ordinary reads.
- `DIRECT_DATABASE_URL`: unpooled Neon URL for wallet transactions.
- `MIGRATION_DATABASE_URL`: table-owner URL used only by migrations.

Vercel integrations are also supported without renaming their generated
variables: `POSTGRES_URL` for pooled reads,
`DATABASE_URL_UNPOOLED`/`POSTGRES_URL_NON_POOLING` for direct and owner work,
and `KV_URL` as an alternative to `REDIS_URL`. Generated integration aliases
take precedence over the local-development names when both are present.

Production Vercel builds apply pending Drizzle migrations before compiling the
application. Preview and local builds never migrate a database automatically.

The two runtime logins must be non-owners and members of `app_role`. Set
`APP_DATABASE_ROLE` and run `npm run db:grant-role` when provisioning a new
runtime login.

## Verification

`npm test` launches a disposable embedded PostgreSQL 16 cluster and applies the
real migration. It exercises the 20-run 100-debit hammer, 50-way idempotency,
opposite-direction transfer contention, commit-time balance constraints,
append-only permissions, rollback coupling, ledger replay, reconciliation,
and fast-check operation sequences.

Run the complete local gate with:

```text
npm run typecheck
npm run lint
npm test
npm run build
```

The migration SQL contains hand-maintained triggers, role grants, and system
wallet seeds that Drizzle's schema DSL cannot represent. Review those custom
sections whenever generating a future migration.
