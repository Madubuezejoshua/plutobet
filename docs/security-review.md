# Security review and production readiness

**Phase 24.** Reviewed against the master build prompt's own checklist.

This is an honest assessment, not a sign-off. Items marked ⚠️ or ❌ are the ones
that matter — a review that reports everything green is a review nobody did.

---

## 24.1 Security review

| Area | State | Notes |
|---|---|---|
| Authentication | ✅ | argon2id, JWT sessions, status re-read on every request |
| Session revocation | ✅ | `sid` claim checked against `user_sessions`; "sign out other devices" is real, not cosmetic |
| Password reset | ✅ | Emailed OTP, single-use, attempt-capped, **no account enumeration** |
| RBAC | ✅ | 8 roles, 31 permissions, separation of duties tested |
| Step-up re-auth | ✅ | Server-held in Redis. **Never accepted from the request** |
| API input validation | ✅ | Zod at every route boundary |
| Rate limiting | ✅ | Redis-backed, per-route budgets, atomic Lua |
| CSRF | ✅ | Auth.js built-in; all mutations are POST with JSON content-type |
| XSS | ✅ | React escapes by default; no `dangerouslySetInnerHTML` in app code |
| SQL injection | ✅ | Drizzle parameterises throughout; **no string-concatenated SQL** |
| Secure cookies | ✅ | Auth.js defaults; `httpOnly`, `sameSite`, `secure` in production |
| Webhook signatures | ✅ | HMAC-SHA512 over the **raw** body, constant-time compare |
| AI permissions | ✅ | Tool registry, no dynamic dispatch, user-scoped tools take no user id |
| Admin permissions | ✅ | Every admin page and route calls `requirePermission` |
| Money paths | ✅ | Unpooled connection, row locks, DB triggers, idempotency fingerprints |
| Account enumeration | ✅ | Reset and login give identical responses for unknown accounts |
| Secrets in code | ✅ | None. `.env` gitignored; staged diffs scanned before every commit |

### Deliberate decisions worth re-reviewing

**`lookup.ts` is exempt from the `dbDirect` rule.** Documented in-file: every
function there is a single read that takes no lock, and the wallet service
re-locks before moving anything. Routing them through the unpooled pool would
exhaust it on the header balance alone. *Re-review if anything there ever writes.*

**The sandbox payment provider refuses to start in production.** It does not
verify webhook signatures — it has no secret to verify against — so running it
in production would let anyone who found the webhook URL credit themselves.
Failing to boot beats booting with an open door to the ledger.

**The AI's rules-based fallback IS safe in production**, unlike the payment
sandbox. A keyword router cannot invent a fixture, promise a certainty, or be
prompt-injected. It is limited, not dangerous, so it degrades rather than
refusing to start.

---

## 24.2 Financial reconciliation

Two independent jobs, asking different questions:

| Job | Question | Schedule |
|---|---|---|
| `reconcileWallet` | Does each balance match a replay of its own ledger entries? | Daily |
| `nightlyProductReconciliation` | Does each domain record match the money that moved for it? | Nightly 04:41 |

The second exists because a wallet can reconcile perfectly while a bet exists
whose stake was never debited. The balance is internally consistent; the
*relationship* between domain and ledger has broken, and only the second check
sees it.

Checks: bets without a stake debit · paid withdrawals without a debit ·
succeeded deposits never credited · won bets without a payout · casino payouts
without a round · **bonus grants that landed outside the BONUS bucket**.

Every finding is a bug, not a discrepancy to explain — the live constraints
already prevent all of them.

---

## 24.2a Deployment configuration ⚠️

The first deployment to Railway returned 500 on every page because
`AUTH_SECRET` was not set. That is correct behaviour — NextAuth must never
invent a signing secret, since a generated default would differ between
instances and across restarts, silently invalidating every live session — but
it was **undiagnosable from outside**. Static assets and the 404 page kept
working, so it looked like a partial outage rather than a configuration error.

Now addressed by `/api/health`, which names the failing configuration. Two
properties of that endpoint are deliberate and should survive review:

- **Unauthenticated.** A deployment that cannot authenticate anybody is exactly
  when this is needed; an auth-gated health check is unreachable at the moment
  it matters.
- **Never reports a value.** Only whether each name is set and structurally
  usable. Connection failures are reduced to an error class, because Postgres
  failure messages happily include the host, the user, and sometimes the URL.

It returns 503 while anything blocking is wrong, so uptime monitoring treats a
misconfigured deployment as down.

**Related fix:** `AUTH_SECRET ?? NEXTAUTH_SECRET` retained an empty string,
since `""` is neither null nor undefined — a variable declared in a hosting
dashboard but left blank never fell through to the alias. Now treated as absent.

---

## 24.3 Backups and disaster recovery ❌

**Not implemented. This is a genuine gap.**

Neon provides point-in-time restore on paid plans, but nothing here verifies it,
and *an untested backup is not a backup*. Before real customers:

1. Confirm PITR is enabled and note the retention window
2. **Perform a restore into a scratch branch and verify the ledger reconciles**
3. Document the runbook: who restores, from where, and what they check
4. Decide the acceptable data-loss window and confirm PITR actually meets it

Step 2 is the one that gets skipped and the one that matters.

---

## 24.4 / 24.5 Performance and load

**Tested:** bet placement under sustained concurrency (`load.acceptance.spec.ts`)
— money invariants hold under contention, which is the property that breaks
silently. Odds browsing makes zero upstream provider calls by design.

**Not tested:** homepage under load, casino callback throughput, live-feed
polling at scale, Pluto AI under concurrency.

The live feed is the one to watch. It polls with conditional requests, so an
unchanged board costs a 304 — but `liveVersion` still runs a query per poll.
At scale that wants caching in Redis with a short TTL.

---

## 24.6 User journey coverage

### Provider contract ✅

Settlement's read of `scores.periods.ft` is the highest-consequence parse in the
system. It is now pinned by `provider-contract.acceptance.spec.ts` against **real
captured responses** (refresh: `npx tsx scripts/capture-odds-fixtures.ts`), by an
opt-in live check against the provider itself (`ODDS_LIVE_CONTRACT=1`), and in
production by a `Settlement` operational alert.

The alert exists because the failure mode is *silent*. Ingestion correctly
refuses to record a finished match with no regulation score — but refusing
throws nothing, so bets simply stay `PENDING`. The alarm fires when a finished
match **with pending bets** has had no result for six hours.

Writing the test found a live defect: `sport` arrives as `{name, slug}`, and
`String()` on it produced `"[object Object]"` — truthy, non-empty, and therefore
past every null check into the database. No events had been synced yet, so
nothing needed repairing.

| Journey | Automated | Notes |
|---|---|---|
| Register → verify → login | ✅ | Including the age gate |
| Deposit → webhook → ledger | ✅ | Idempotency and signature verification |
| Bet → settle → payout | ✅ | Including chaos and concurrency |
| System bet expansion | ✅ | Combinatorics proven exact |
| Cash-out, full and partial | ✅ | Settlement pays remaining stake only |
| Resettlement | ✅ | Compensating entries, clawback shortfall |
| Withdrawal → payout → webhook | ⚠️ | Unit-tested; **never run against live Paystack** |
| Casino round | ⚠️ | Callbacks tested; **no aggregator connected** |
| Pluto AI | ✅ | Guardrails, prediction, retrieval |

---

## Before real customers

**Blocking:**

1. **Paystack keys.** No deposits or withdrawals without them.
2. **One real low-value transfer, end to end.** The Paystack adapter is written
   against published docs and exercised only by fixtures. Same caveat as the
   odds adapter, and it matters more here.
3. **Verify a database restore** (24.3).
4. **Rotate the credentials pasted into chat during setup** — Neon, Upstash,
   Backblaze, Inngest, odds-api.io. `IDENTITY_PEPPER` is the exception: it
   *cannot* be rotated, since every stored identity digest derives from it. Move
   it to managed secret storage instead.

**Strongly recommended:**

5. **Termii and Resend keys.** Without them OTP codes only print to the server
   log — nobody can register or reset a password.
6. **Sentry DSN.** Currently flying blind on production errors.
7. **Backfill dates of birth** for accounts created before the age gate. They are
   flagged on the account page but not blocked.
8. **Delete `legacy/`** — an abandoned NestJS implementation that confuses every
   audit.

---

## Known limitations, stated plainly

- **Live betting is display-only.** Prices show; placing in-play needs a real
  in-play feed driving suspend-on-incident. A tappable price the server would
  refuse is worse than no price.
- **Casino, virtuals, fantasy and draw games have no provider.** The
  integrations are built and the lobbies say so rather than showing fake tiles.
- **Pluto AI runs a keyword router**, not a language model. The registry,
  guardrails and draft flow — the parts that must be right — are built and
  tested, so connecting a model is an adapter swap.
- **Bet Builder is not implemented.** It needs a provider that prices correlated
  legs; naively multiplying odds on the same match is how a book gets arbitraged.
- **Fantasy and Lucky Numbers are not started.**
