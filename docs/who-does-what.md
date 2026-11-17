# Who does what

Everything remaining, split by **who can actually do it**. Nothing here is
blocked on writing more code unless it says so.

The distinction that matters: a developer cannot buy a Paystack contract, and a
business owner cannot fix an odds parser. Most stalled launches are a list where
those two are mixed together.

---

## THE BOSS — money, contracts, accounts

None of this is engineering. It cannot be delegated to a developer, because it
needs a company, a bank account, or a signature.

### Before anyone can register or bet

| # | Do this | Why it blocks everything | Cost |
|---|---|---|---|
| B1 | **Set `AUTH_SECRET` in Railway** | The site returns 500 on every page right now. This one variable is the whole fix | Free, 2 min |
| B2 | **Buy Termii credits** (`TERMII_API_KEY`, `TERMII_SENDER_ID`) | OTP codes print to a server log. **Nobody can register** | Small |
| B3 | **Create a Resend account** (`RESEND_API_KEY`, `RESEND_FROM`) | Same, for email and password reset | Free tier works |
| B4 | **Paystack live keys** (`PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`) | No deposits, no withdrawals. The money loop is inert | Needs a registered business |

To generate B1's value:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Before real customers

| # | Do this | Why |
|---|---|---|
| B5 | **Send one real ₦100 Paystack transfer end to end** | The payout adapter has never moved real money. Fixtures are not proof |
| B6 | **Rotate every credential shared in chat or a ticket** | Neon, Upstash, Backblaze, Inngest, odds-api.io are all compromised. **`IDENTITY_PEPPER` is the exception — it cannot be rotated**, because every stored identity digest derives from it. Move it to managed secret storage instead |
| B7 | **Confirm Neon's plan includes point-in-time restore**, and decide the acceptable data-loss window | Without it there is no recovery story |
| B8 | **Upgrade the odds-api.io plan** if you want more than 2 bookmakers | The current plan caps selection at two. One bookmaker means one price and no market comparison |

### Commercial contracts — each unlocks a whole product

These are built and waiting. The UI says "not connected" rather than showing
fake tiles, so nothing misleads a customer while you negotiate.

| Product | Needs | State |
|---|---|---|
| **Casino / Live Casino** | An aggregator contract (Softswiss, EveryMatrix, Pragmatic…) | Interface, sandbox adapter, catalogue and lobby all built |
| **Virtuals** | A virtuals provider | Rounds already model as sportsbook events, so pricing and settlement are reused |
| **Live (in-play) betting** | A real in-play feed | Currently **display-only** — prices show, placement is refused. A tappable price the server would reject is worse than no price |
| **Bet Builder** | A provider that prices *correlated* legs | Not implemented. Multiplying odds on the same match is how a book gets arbitraged |
| **Pluto AI** | An LLM API key | Runs a keyword router today. Registry, guardrails and draft flow are built and tested — connecting a model is an adapter swap |

### Regulatory — start early, these are slow

- **FSGRN / state gaming licence.** The compliance groundwork is built (age gate, KYC tiers, self-exclusion, responsible-gambling limits, audit trail, regulator reporting) but a licence is a legal process, not a feature.
- **Company registration and a settlement bank account**, required before Paystack will issue live keys.

---

## THE DEVELOPER — code and operations

### Do first

| # | Task | Notes |
|---|---|---|
| D1 | **Verify a database restore** | Restore Neon PITR into a scratch branch and confirm the ledger reconciles. *An untested backup is not a backup.* This is the one that gets skipped and the one that matters on the worst day |
| D2 | **Seed the first admin** | `SEED_ADMIN_EMAIL` + `SEED_ADMIN_PASSWORD`, then `npm run db:seed-admin`. **There is no admin account yet** |
| D3 | **Confirm `1x2` parses from a real payload** | The match-result market — the most commonly bet one — did not appear in the one bookmaker captured. Add a second bookmaker, run `npm run odds:capture`, confirm `1x2` appears |
| D4 | **Set `SENTRY_DSN`** | Wired but unconfigured. Currently blind to production errors |

### Then

| # | Task | Notes |
|---|---|---|
| D5 | **Backfill dates of birth** | Accounts predating the age gate are flagged but not blocked. **Needs a policy decision from the boss first**: block them, or ask at next login? |
| D6 | **Edit bet** | Cash-out and resettlement are done; this is the remaining leg of Phase 9 |
| D7 | **Cache `liveVersion` in Redis** | The live feed answers 304 when nothing changed but still runs a query per poll. Fine now, wrong at scale |
| D8 | **Load-test the untested paths** | Covered: bet placement under contention. Not covered: homepage, casino callbacks, live-feed polling at scale, Pluto AI concurrency |
| D9 | **Personalisation** (Phase 19) and **Admin AI** (Phase 23) | Both greenfield. The data they need already exists |
| D10 | **Fantasy and Lucky Numbers** | Not started. Real feature work, not integration |

### Standing operational duties

- **Run `npm run odds:contract` on a schedule.** It checks the live provider's response shape. If odds-api.io moves `scores.periods.ft`, bets stop settling — silently.
- **Watch the `Settlement` alert on the admin dashboard.** It fires when a finished match with pending bets has had no result for six hours. That is the signature of a provider shape change in production.
- **Never add a `wallets` query without `bucket = 'CASH'`.** Each account has three wallet rows; a bucket-blind query matches all three and takes whichever the planner returns first. This bug once hit six queries and the ledger stayed perfectly balanced the whole time — the money just landed where the customer could not spend it.

---

## What is genuinely finished

So nobody re-does it:

- **The money core.** Double-entry ledger, integer kobo, DB triggers, row locks, idempotency with request fingerprints. The runtime role cannot alter ledger tables.
- **Settlement**, including partial cash-out and resettlement by compensating entries.
- **Sportsbook**: singles, accumulators, system bets with bankers, booking codes.
- **RBAC**: 8 roles, 31 permissions, separation of duties, server-held step-up re-auth.
- **Compliance**: age gate, KYC tiers, self-exclusion that survives re-registration, RG limits.
- **AI safety layer**: tool registry with no dynamic dispatch, draft-only money actions, probabilities from arithmetic rather than a model.
- **Provider contract tests** against real captured responses, plus a production stall alarm.

**572 tests across 45 suites. Typecheck and production build clean. 24 of 24
migrations applied.**

---

## The honest one-line summary

**The boss is the bottleneck, not the developer.** Four purchases (B1–B4) turn
this from a demo into a working business. Everything on the developer list makes
it better or safer, and none of it is what is stopping you today.
