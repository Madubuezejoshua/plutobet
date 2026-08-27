# PlutoBet — Project Status & Implementation Assessment

**Audit date:** 2026-08-27
**Auditor:** Claude (lead architect role, per Master Build Prompt)
**Repository:** `c:\Users\MXT\Documents\projects\bet` (package name `bet-platform`)
**Branch:** `main` · 5 commits · working tree clean at audit start

---

## 0. Executive summary

This repository is **not an empty project**, and it is **not a PlutoBet project either**.

What exists is a **deep, narrow vertical**: a rigorously engineered money core —
double-entry ledger, wallet concurrency, bet placement, settlement, payments
scaffolding, KYC and responsible gambling — built to a *different, smaller
specification* (an 8-phase Nigerian FSGRN-licensing brief, see
`docs/FSGRN-technical-topography.md`).

The PlutoBet Master Build Prompt describes a platform roughly **3× larger in
scope**, whose stated differentiator — **Pluto AI** — currently has
**zero implementation, zero dependencies, and zero database presence**.

| | |
|---|---|
| **Estimated completion against PlutoBet's 24 phases** | **~40%** (was ~23% at audit) |
| Phases at or above 70% | 5 of 24 (UI Foundation, Accounts, Admin/RBAC, Wallet/Ledger, Betting Engine) |
| Phases at 0% | 7 of 24 (Virtuals, Fantasy/Jackpot, Referrals, all 4 AI phases, Social) |
| Product areas with a working UI | 5 of 17 (Sports, My Bets, Wallet, Account, Home) |

**The important nuance:** the 23% that exists is the *hardest and least
forgiving* 23%. Financial ledgers, concurrency safety and settlement
correctness are where betting platforms fail catastrophically and silently.
That work appears sound and is backed by 272 passing tests across 28 suites,
including concurrency, property-based, chaos and load tests.

The remaining 77% is broader but individually less treacherous — with the
exception of the AI layer, which is entirely greenfield and carries its own
novel safety burden (Rules 12–16).

---

## 1. Confirmed technology stack

| Layer | Technology | Version | Notes |
|---|---|---|---|
| Framework | Next.js (App Router) | 16.3.2 | Server components used heavily and deliberately |
| Runtime | React / React DOM | 19.2.8 | |
| Language | TypeScript | 5.9.3 | `strict`; `tsc --noEmit` passes clean |
| ORM | Drizzle ORM | 0.45.2 | Schemas in TS; **constraints/triggers hand-written in raw SQL** |
| Driver | postgres-js | 3.4.5 | |
| Database | PostgreSQL (Neon, serverless) | — | Pooled + unpooled URLs, deliberately separated |
| Cache / limits | Redis (Upstash) via `ioredis` | 5.11.1 | TCP protocol, **not** the REST API |
| Background jobs | Inngest | 4.18.1 | 8 registered functions |
| Auth | NextAuth (Auth.js) | 4.24.15 | Credentials provider, JWT sessions |
| Password hashing | argon2 (argon2id) | 0.45.1 | |
| Validation | Zod | 4.1.5 | |
| Object storage | AWS SDK S3 → **Backblaze B2** | 3.1116 | Spec said R2; B2 chosen, interface identical |
| Errors | Sentry | 10.70.0 | Wired, **DSN not configured** |
| Styling | Tailwind CSS | 4.1.14 | Plus ~204 lines of hand-written page CSS |
| Testing | Vitest + fast-check | 3.2.7 | Real embedded Postgres + Redis, not mocks |

**No AI dependencies are installed.** No `@anthropic-ai/sdk`, no OpenAI SDK, no
vector store, no embeddings library, no RAG tooling.

**No realtime transport is installed.** No WebSocket server, no SSE
implementation, no Pusher/Ably. Live betting (Phase 9) and live odds cannot
function without one.

---

## 2. Folder structure

```
src/
├─ app/                    Next.js App Router — 12 pages, 13 API routes
│  ├─ admin/               overview · reports · kyc review
│  ├─ api/                 auth · bets · odds · wallet · withdrawals
│  │                       kyc · admin/kyc · webhooks/paystack · inngest
│  ├─ sports/ bets/ wallet/ deposit/ withdraw/ responsible/ register/ kyc/
│  └─ globals.css          204 lines, ad-hoc — NOT a design system
├─ db/                     pooled client · redis client
├─ inngest/                client + 4 function files (8 functions)
├─ lib/api/                route wrappers (public/authed/admin) · rate limiting
├─ modules/                15 domain modules  ← the real substance
└─ types/
docs/                      FSGRN-technical-topography.md (regulatory)
drizzle/                   15 hand-authored SQL migrations
legacy/                    abandoned NestJS/Prisma implementation (dead code)
scripts/                   migrate · seed · dev-stack · probe-odds
```

**155 TypeScript/TSX source files. 28 test suites.**

### `legacy/` is dead weight
Seven directories of an abandoned NestJS + Prisma implementation
(`nest-prisma`, `nestjs-odds`, `nestjs-wallet`, `prisma-schema`, …). It is not
imported by anything. It should be deleted or archived — it will confuse every
future audit and every new contributor.

---

## 3. Domain modules — what actually exists

| Module | Files | Tests | Assessment |
|---|---|---|---|
| `wallet` | 10 | 6 suites | **Strongest.** Double-entry, append-only, DB-trigger-enforced |
| `betting` | 8 | 5 suites | Placement, pricing, cashout, exposure caps |
| `settlement` | 5 | 4 suites | Poll → resolve → settle, idempotent, chaos-tested |
| `odds` | 9 | 3 suites | Provider adapter, canonical selection, budget limiter |
| `payments` | 6 | 3 suites | Deposits, withdrawals, state machine, Paystack webhook |
| `responsible` | 4 | 1 suite | Limits, cool-off, self-exclusion |
| `kyc` | 4 | 1 suite | Identity hashing, B2 storage, review workflow |
| `notifications` | 7 | 2 suites | OTP, phone normalisation, Termii/Resend adapters |
| `casino` | 4 | 1 suite | Callback handling only — **no provider, no UI** |
| `reporting` | 2 | 1 suite | Daily turnover, GGR, large transactions |
| `users` | 8 | 2 suites | Registration, age gate, profile, sessions, password reset, referral codes |
| `auth` | 5 | — | Session, admin, password, email |
| `risk` | 1 | — | Exposure + heuristic signals |
| `reconciliation` | 1 | — | Financial reconciliation |
| `audit` | 2 | — | Append-only audit log with DB-enforced reason on admin actions |

---

## 4. Phase-by-phase assessment against the PlutoBet Master Build Prompt

> **Note on numbering:** the existing code was built to a *different* 8-phase
> brief. Those phase numbers do **not** map onto PlutoBet's 24. This table is
> the authoritative mapping from here on.

| # | Phase | % | Status |
|---|---|---|---|
| 1 | Project Audit + UI Foundation | **100%** ✅ | Audit (this doc), dark design system, navigation registry, 17 product areas, homepage, mobile bottom bar + drawer |
| 2 | Authentication + User Account | **90%** ✅ | Age gate, full user model, 6 statuses, password reset, revocable device sessions, profile, preferences. Email verification UI outstanding |
| 3 | Admin Platform Foundation | **85%** ✅ | 8 roles, 31 permissions, server-held step-up reauth, audited grants, permission-filtered sidebar, 8 admin screens |
| 4 | **Wallet + Immutable Ledger** | **100%** ✅ | Cash/bonus/locked segregation as wallet rows, DB-enforced cash-only withdrawal, bucket transfers reconcile |
| 5 | Payments, Deposits, Withdrawals | **85%** ✅ | Paystack adapter, payout worker, transfer webhooks, finance admin screens. Still needs live keys + a real end-to-end transfer |
| 6 | Sports Data Foundation | **80%** ✅ | Sport/Competition/Team entities, conservative name canonicalisation + alias table, head-to-head, sport & competition browsing |
| 7 | Odds Engine + Betslip | **85%** ✅ | Booking codes, decimal/fractional/American formats applied live, per-customer odds-change policy read server-side |
| 8 | **Sportsbook Betting Engine** | **70%** | **Strong.** Singles + accumulators, locked odds, exposure caps. No system bets, bankers, bet builder |
| 9 | Live Betting + Cashout + Settlement | **40%** | Settlement + cashout good. **No live feed, no realtime layer**, no resettlement, no edit bet |
| 10 | Livescore + Results + Statistics | **5%** | Scores ingested for settlement only. No user-facing anything |
| 11 | Casino + Live Casino | **15%** | Callback handler exists. **No aggregator, no lobby, no games, no UI** |
| 12 | Virtuals + Instant Games | **0%** | Not started |
| 13 | Fantasy + Jackpot + Draw | **0%** | Not started |
| 14 | Promotions + Bonuses + Loyalty | **3%** | `BONUS` ledger type + `BONUS_LIABILITY` account exist as hooks only |
| 15 | Referrals + Affiliates | **0%** | Not started |
| 16 | **Pluto AI Foundation** | **0%** | **Not started — no dependency, no code, no schema** |
| 17 | Pluto AI Betting + Financial Actions | **0%** | Not started |
| 18 | AI Match Analysis + Prediction | **0%** | Not started |
| 19 | AI RAG + Personalization | **0%** | Not started |
| 20 | KYC + Risk + Fraud + Responsible Gaming | **65%** | KYC + RG genuinely good. Age verification **added in Phase 2**. Fraud detection still shallow |
| 21 | Notifications + Support | **20%** | OTP delivery only, unconfigured. No in-app/push, no support system |
| 22 | Social + Community | **0%** | Not started |
| 23 | Analytics + Admin AI + Monitoring | **20%** | Reporting service + Sentry. No health monitoring, no alerts, no admin AI |
| 24 | Security, Reconciliation, QA, Production | **45%** | Reconciliation + 245 tests + rate limits. No security review, backups, or DR |

**Unweighted mean: ~40%** (was ~23% at audit)

---

## 5. What genuinely works today

These are verified, not assumed — each is covered by passing tests, and several
were confirmed by driving the running application manually.

- **Money is never wrong.** Integer kobo (`BIGINT`) end to end. No floats anywhere in a money path.
- **The ledger cannot be corrupted from application code.** Deferred PostgreSQL triggers reject unbalanced, empty, malformed or cache-divergent commits. Database role separation means the runtime role *cannot* own or alter ledger tables.
- **Concurrency is safe.** `SELECT … FOR UPDATE` on wallet rows; transfers lock both wallets in UUID order to avoid deadlock. Proven by a concurrency suite that races real transactions.
- **Idempotency is real.** Keys carry a SHA-256 request fingerprint, so replaying a key with *different* parameters raises a typed conflict rather than silently succeeding.
- **Odds are locked at placement.** Settlement reads `bet_legs.locked_odds_decimal`, never the current price.
- **Self-exclusion survives re-registration.** Keyed to an HMAC digest of BVN/NIN under a server-held pepper, not to an email address.
- **RG limits are asymmetric.** Lowering a limit applies immediately; raising one waits 24 hours. Verified live.
- **Unverified accounts cannot withdraw.** Tier 0 → ₦0 daily cap, enforced in the service and reflected in the UI.
- **Bet placement is atomic and idempotent.** A double-tap returns the original bet rather than placing a second one or erroring.

---

## 6. What is broken, missing, or dangerous

### 🔴 Blockers — the platform cannot operate

| Issue | Consequence |
|---|---|
| **No Paystack keys** | No deposits, no withdrawals. The entire money loop is inert |
| ~~No age verification~~ | ✅ **Fixed in Phase 2.** `date_of_birth` is collected at registration and enforced by both the service and a database trigger. Accounts predating it are flagged on their account page |
| **No realtime layer** | Live betting, live odds, and live scores (Phases 9, 10) cannot be built until this exists |
| **Migration 0009 not applied** | KYC review workflow is written and typechecks, but the database does not have it yet — this environment cannot reach Neon (see §9) |

### 🟠 Serious gaps

- ~~**No RBAC.**~~ ✅ **Fixed in Phase 3.** 8 roles with enforced separation of duties; a support agent is read-only and cannot touch money or account status.
- ~~**No bonus wallet.**~~ ✅ **Fixed in Phase 4.** Cash, bonus and locked are separate wallet rows, so every existing ledger invariant covers them unchanged. Wagering-requirement logic still belongs to phase 14.
- ~~**Withdrawals never actually pay out.**~~ ✅ **Fixed in Phase 5.** Paystack adapter, a payout worker that submits approved withdrawals, and transfer webhooks that settle them. Needs live keys and one real low-value transfer to verify.
- ~~**Sports hierarchy is flat.**~~ ✅ **Fixed in Phase 6.** Sport → Competition → Event with Team entities and an alias table. Head-to-head is now queryable, which is what phase 18's analysis needs.
- **Casino is a callback handler with nothing attached.** No aggregator adapter, no game catalogue, no lobby.
- **Notification providers unconfigured.** Termii and Resend adapters exist but are **unverified against live traffic** and have no credentials — OTP codes currently print to the server console. Nobody can actually receive a code.
- **`legacy/` contains an entire abandoned codebase.**

### 🟡 Correctness risk worth naming

**Wallet lookups must always name a bucket.** Phase 4 gave each account three
wallet rows (CASH/BONUS/LOCKED). Any query resolving "the user's wallet" by
`(user_id, kind, currency)` now matches three rows and takes whichever the
planner returns first. Six such queries existed — deposits, settlement payouts,
casino payouts, casino balance, withdrawal refunds and cash-out — and all were
crediting an arbitrary bucket. Fixed in Phase 5 and pinned by a regression test,
but any NEW query against `wallets` must include `bucket = 'CASH'`.

### 🟡 Correctness risk worth naming

**The odds provider adapter has been validated exactly once, by a manual probe.**
`probe.txt` confirms the live odds-api.io response contains `scores.periods.ft`,
which is what settlement reads to decide match outcomes. That is the single
highest-consequence parse in the system — if the provider changes that shape,
bets settle wrongly and money moves wrongly. There is **no automated contract
test** guarding it.

---

## 7. Compliance with the Master Build Prompt's own rules

| Rule | Status |
|---|---|
| 7 — Security before convenience | ✅ All authoritative decisions server-side |
| 8 — No floating-point money | ✅ Integer kobo throughout |
| 9 — Database transactions | ✅ Atomic, with rollback, DB-enforced |
| 10 — Idempotency | ✅ With fingerprinting, exceeds the requirement |
| 11 — Provider abstraction | 🟡 Odds/payments/casino/SMS abstracted; sports data not |
| 12–16 — AI rules | ⬜ Not applicable yet — no AI exists |
| **Prohibited: fake wallet balance** | ✅ Never |
| **Prohibited: trust frontend payment** | ✅ Webhook-verified with signature |
| **Prohibited: negative balance race** | ✅ Structurally prevented |
| **Prohibited: plain-text passwords** | ✅ argon2id |
| **Prohibited: duplicate webhooks** | ✅ Idempotent |
| **Prohibited: support = super admin** | ✅ Fixed in Phase 3 — enforced and tested |
| **Prohibited: unmarked mock data** | ✅ Console providers clearly labelled as fallbacks |

---

## 8. Environment variables

**Configured:** `DATABASE_URL` · `DIRECT_DATABASE_URL` · `MIGRATION_DATABASE_URL` ·
`APP_DATABASE_ROLE` · `REDIS_URL` · `AUTH_SECRET` · `NEXTAUTH_URL` ·
`IDENTITY_PEPPER` · `ODDS_API_KEY` · `B2_ENDPOINT` · `B2_REGION` · `B2_BUCKET` ·
`B2_KEY_ID` · `B2_APPLICATION_KEY` · `INNGEST_EVENT_KEY` · `INNGEST_SIGNING_KEY` ·
`UPSTASH_REDIS_REST_URL` · `UPSTASH_REDIS_REST_TOKEN`

**Still required:**

| Variable | Blocks |
|---|---|
| `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY` | **All deposits and withdrawals** |
| `TERMII_API_KEY` / `TERMII_SENDER_ID` | Real SMS OTP delivery |
| `RESEND_API_KEY` / `RESEND_FROM` | Real email delivery |
| `SENTRY_DSN` | Production error visibility |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | First admin account (self-chosen) |

**Not yet needed, but required by later phases:** casino aggregator credentials
(Phase 11), virtuals provider (12), fantasy/jackpot provider (13), an AI model
API key (16), a realtime transport (9).

### ⚠️ Credential hygiene
Neon, Upstash, Backblaze, Inngest and odds-api.io credentials were pasted into
a chat transcript during setup. **They should be rotated before real user data
exists.** The `IDENTITY_PEPPER` is the exception — it *cannot* be rotated, since
every stored identity digest derives from it; it must be moved to managed
secret storage instead.

---

## 9. Current environment limitation

This session **cannot reach the network** for database or git traffic. DNS
resolves and `Test-NetConnection` to Neon:5432 and github.com:443 both succeed,
but every actual Postgres connection and every `git fetch`/`push` times out —
across Bash and PowerShell, sandboxed and unsandboxed, pooled and direct.

**Consequences:**
- Migration `0009_kyc_review.sql` is written and typechecks but **is not applied**
- Nothing has been pushed to `github.com/Madubuezejoshua/plutobet.git`

Both need to be run from a normal terminal:
```bash
npm run db:migrate
git push origin main
```

---

## 10. Recommended sequence

The Master Build Prompt's phase order is sound, with **three deviations I would
argue for**:

1. ~~Add date-of-birth and age verification immediately.~~ ✅ **Done in Phase 2.**

2. ~~Bring the bonus/locked/pending wallet split forward into Phase 4.~~ ✅ **Done in Phase 4.**

3. ~~Build the sports hierarchy before the AI phases.~~ ✅ **Done in Phase 6.**

**Immediate next step per the Master Build Prompt: Phase 1 — UI Foundation.**
The current interface is four functional pages sharing 204 lines of ad-hoc CSS.
PlutoBet specifies 17 product areas, a mobile-first bottom navigation, and a
consistent design system. That work has effectively not begun.

---

## 11. Honest bottom line

You have an unusually good **foundation** and an unusually small **product**.

The parts that are hard to fix later — money integrity, concurrency, settlement,
audit trail — are done, and done properly. The parts that are visible to users
— navigation, homepage, casino, virtuals, promotions, and the entire Pluto AI
layer that is meant to be the differentiator — are largely absent.

Nothing built so far needs to be thrown away. The gap is breadth, not quality.
