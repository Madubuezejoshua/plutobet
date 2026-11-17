# Technical Topography — Online Sports Betting Platform

**Prepared for:** Federation of State Gaming Regulators of Nigeria (FSGRN)
**Addresses:** Requirement 8 (Technical topography), and supports Requirements 9–11
**Status:** Pre-certification. See "Outstanding before submission" at the end — several
items in this document are dependent on commercial agreements not yet in place, and are
marked as such rather than stated as fact.

---

## 1. General

### 1.1 Operational flow

```
                        ┌──────────────────────────┐
   Player (Android /    │  Next.js App Router      │
   low-bandwidth web) ──┤  server-rendered pages   │
                        │  + JSON API routes       │
                        └────────────┬─────────────┘
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        │                            │                            │
┌───────▼────────┐        ┌──────────▼──────────┐      ┌──────────▼─────────┐
│ Redis          │        │ Modular monolith    │      │ Inngest            │
│ (Upstash)      │        │ 15 bounded modules  │      │ durable scheduled  │
│                │        │                     │      │ + event functions  │
│ • rate limits  │        │ wallet = SOLE       │      │                    │
│ • odds budget  │        │ writer of the       │      │ 9 functions        │
│ • poller       │        │ ledger              │      │ (see §1.3)         │
│   cadence      │        └──────────┬──────────┘      └──────────┬─────────┘
└────────────────┘                   │                            │
                                     │                            │
                        ┌────────────▼────────────────────────────▼─────────┐
                        │ PostgreSQL (Neon)                                 │
                        │                                                   │
                        │  pooled endpoint  → ordinary reads                │
                        │  direct endpoint  → EVERY money transaction       │
                        │                                                   │
                        │  append-only double-entry ledger                  │
                        │  immutable audit log                              │
                        │  DB-level constraints, triggers, role grants      │
                        └───────────────────────┬───────────────────────────┘
                                                │
     ┌──────────────┬─────────────┬─────────────┴────────┬──────────────────┐
     │              │             │                      │                  │
┌────▼─────┐  ┌─────▼─────┐  ┌────▼──────┐      ┌────────▼───────┐  ┌───────▼──────┐
│ Odds     │  │ Paystack  │  │ Dojah     │      │ Casino         │  │ Backblaze B2 │
│ provider │  │ deposits, │  │ BVN / NIN │      │ aggregator     │  │ KYC docs     │
│ (feed)   │  │ transfers │  │ KYC       │      │ (certified)    │  │ private      │
└──────────┘  └───────────┘  └───────────┘      └────────────────┘  └──────────────┘
```

**Direction of trust.** Every arrow into the platform is treated as untrusted input.
Payment webhooks are signature-verified against the raw request body; casino callbacks
are authenticated by a per-session token digest; odds and result feeds are normalised
through an adapter that discards anything it cannot map with confidence.

### 1.2 Platform

| Item | Value |
|---|---|
| Hosting model | **Cloud-based** (not self-hosted) |
| Application hosting | Vercel (Vercel Pro tier) |
| Database hosting | Neon (managed PostgreSQL 16) |
| Cache / rate limiting | Upstash (managed Redis) |
| Background execution | Inngest (managed durable functions) |
| Object storage | Backblaze B2 (S3-compatible, private bucket) |
| Error monitoring | Sentry |

Hosting-company contact details are provided in the accompanying commercial annexe.

### 1.3 Scheduled and event-driven processing

There is no persistent worker process. All background work runs as durable Inngest
functions, each of which is independently retried and whose full execution history —
every run, every retry, every input — is retained as audit evidence.

| Function | Trigger | Purpose |
|---|---|---|
| `odds-sync-fixtures` | every minute, cadence-gated | Fixture list refresh |
| `odds-sync-delta` | every minute, cadence-gated | Price movement |
| `odds-sync-live` | every minute, cadence-gated | In-play prices |
| `settlement-poll-results` | every minute, cadence-gated | Detect finished matches |
| `settle-event` | event | Fan out one finished event to its bets |
| `settle-bet` | event | Settle one bet, idempotently |
| `schedule-wallet-reconciliation` | daily 02:17 | Fan out ledger replay |
| `reconcile-wallet` | event | Replay one wallet, flag drift |
| `daily-financial-reconciliation` | daily 03:23 | Provider report vs. ledger |

Poller intervals are held in Redis, not in code, so throttling near an upstream API cap
requires a configuration change rather than a redeployment.

---

## 2. Hardware

The platform is cloud-hosted and does not operate owned physical servers. The
corresponding controls are contractual and provider-managed:

| Area | Position |
|---|---|
| Servers | Ephemeral serverless compute (Vercel); no long-lived instances |
| Firewalls / routers | Provider-managed edge; platform is not exposed on raw IP |
| Redundancy | Managed multi-AZ database with point-in-time recovery (Neon); stateless compute is inherently redundant |
| DDoS / WAF | Provider edge protection, plus per-user and per-IP application rate limiting |

Provider SLAs and letters of introduction are supplied under Requirements 14 and 15.

---

## 3. Software

### 3.1 Specifications

| Layer | Specification |
|---|---|
| Operating system | Linux (provider-managed container runtime) |
| Runtime | Node.js 20+ |
| Language | TypeScript (strict) |
| Application framework | Next.js 16 (App Router) |
| Database | **PostgreSQL 16** |
| Query layer | Drizzle ORM; money-critical constraints authored as raw SQL |
| Authentication | Auth.js, argon2id password hashing |
| Schema management | 9 versioned, forward-only migrations |

### 3.2 Module boundaries

Single deployable unit, fifteen modules with enforced boundaries:

```
auth  users  wallet  audit  kyc  payments  odds  betting
settlement  risk  responsible  casino  notifications  reporting  reconciliation
```

**The controlling rule:** only the `wallet` module writes to the ledger. No other module
holds the direct database client or the ledger schema. This is enforced by a lint rule
in addition to code review.

---

## 4. Controls relevant to GLI-33 (Requirement 11)

The certification requirement is that every money movement be **reproducible by a third
party who does not trust the operator**. The following are properties of the database,
not of application code, and therefore hold even against a defect in the application.

| Control | Mechanism |
|---|---|
| Double-entry integrity | Deferred constraint trigger verifies every transaction group sums to zero at COMMIT |
| No negative balances | `CHECK` constraint on the wallet row |
| Money precision | All amounts are integer kobo (`BIGINT`); no floating point anywhere in the money path |
| Ledger immutability | `UPDATE`, `DELETE`, `TRUNCATE` revoked from the runtime role |
| Audit immutability | Same revocations; actor, action, before, after, timestamp and IP recorded |
| Idempotency | Unique constraint on a caller-supplied key plus a request fingerprint; replay returns the original result without moving funds |
| Odds locked at placement | Stored on the bet leg; a trigger rejects any later modification |
| No re-settlement | Trigger refuses any transition out of a terminal bet state |
| Stake/bet atomicity | `bets.stake_txn_id` is `NOT NULL UNIQUE` — a bet cannot exist without its funding transaction, and two bets cannot share one |
| Balance reconstructibility | Cached balances are re-derived from the ledger daily; drift raises a critical alert |
| Privilege separation | Migrations run as an owner role; the application connects as a non-owner member of `app_role` |

**Settlement correctness.** Match-result markets settle against the regulation-time score,
never the extra-time or penalty-inclusive score. A tie won on penalties settles as a draw
for 1X2, double chance, correct score and both-teams-to-score.

**Verification.** 26 automated test suites, including concurrency tests run twenty times
per execution, property-based tests over randomly generated transaction sequences, a
chaos test that severs the database connection mid-settlement, and a load test asserting
ledger integrity under concurrent placement.

---

## 5. AML/CFT support (Requirement 12 — SCUML)

| Control | Implementation |
|---|---|
| Identity verification | BVN/NIN via licensed provider; tiered verification levels |
| Identity storage | **Raw BVN/NIN are never stored.** HMAC-SHA256 digests under a server-held pepper, enforced by a database format constraint |
| One identity, one account | Unique constraint on the identity digest |
| Withdrawal gating | Unverified accounts cannot withdraw; daily caps rise by verification tier |
| Large-transaction reporting | Threshold export with verification level shown against each movement |
| Turnover reporting | Daily deposits, withdrawals, stakes, payouts and gross gaming revenue, derived from the ledger |
| Retention | Ledger, audit log and KYC decisions are append-only |

---

## 6. Responsible gambling

Enforced on the money path, not in the interface — a control a client can bypass by
calling the API directly is not a control.

- Deposit, loss and wager limits over rolling 1/7/30-day windows, computed from the ledger.
- **Reductions apply immediately; increases take effect only after 24 hours.**
- Cooling-off periods that cannot be shortened once begun.
- **Self-exclusion registered against the verified identity, not the account**, so it
  survives re-registration under a new email address. A self-excluded identity also
  cannot complete KYC on a new account.
- All limits are player-settable in the account area, and every change is retained as
  history rather than overwritten.

---

## 7. Outstanding before submission

Stated plainly rather than omitted:

1. **Production odds feed** — a certification-grade provider (Sportradar / LSports /
   BetGenius) is required. The current development feed is not certification-grade. The
   provider interface is vendor-neutral, so this is an adapter change.
2. **Casino content** — requires a certified aggregator agreement and, per FSGRN,
   separate casino-specific technical approval. No game logic or RNG is implemented by
   the operator, and none is proposed.
3. **GLI-33 certification** — not yet undertaken. The controls in §4 are built to be
   evidenced under it; the certification itself is outstanding.
4. **ISO 9001:2015 certificates** (Requirement 9) — to be supplied by technical partners.
5. **Payment and KYC provider agreements** — commercial onboarding in progress.
6. **Physical premises** (Requirement 4.vii) — lock-up shop addresses to be confirmed;
   kiosks and mobile vendors are not permitted.

---

*This document describes the platform as built. Where an item depends on an agreement
not yet executed, it is listed in §7 rather than represented as complete.*
