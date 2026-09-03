# PlutoBet — general status

**This file is the single source of truth for the state of this project.**
Every other document in the repository is either a runbook, an owner checklist,
or historical evidence of one pass. Where any of them disagrees with this file,
this file is right.

**Last updated:** 2026-09-02
**Branch described:** `ui/plutobet-sportsbook-redesign` (branched from `main`)
**Merged to `main`:** no. **Deployed:** no. Awaiting visual review.

**No credential, connection string, one-time code, personal detail or other
secret value appears anywhere in this document, and none may be added to it.**
Environment variables are named and reported only as set / missing / blocked.

---

## Contents

| § | Section |
|---|---|
| 1 | [What this document is, and the rules it follows](#1-what-this-document-is-and-the-rules-it-follows) |
| 2 | [How to read the status labels](#2-how-to-read-the-status-labels) |
| 3 | [Where the project stands, in one page](#3-where-the-project-stands-in-one-page) |
| 4 | [Verification gates and their last results](#4-verification-gates-and-their-last-results) |
| 5 | [The customer-facing interface](#5-the-customer-facing-interface) |
| 6 | [Complete interaction inventory](#6-complete-interaction-inventory) |
| 7 | [Design system](#7-design-system) |
| 8 | [Accessibility and mobile](#8-accessibility-and-mobile) |
| 9 | [Authentication and account](#9-authentication-and-account) |
| 10 | [The money core](#10-the-money-core) |
| 11 | [Deposits and withdrawals](#11-deposits-and-withdrawals) |
| 12 | [Betting: pricing, placement, exposure](#12-betting-pricing-placement-exposure) |
| 13 | [Settlement](#13-settlement) |
| 14 | [The real bet that proved the pipeline](#14-the-real-bet-that-proved-the-pipeline) |
| 15 | [Cash-out: built, and deliberately unreachable](#15-cash-out-built-and-deliberately-unreachable) |
| 16 | [Responsible gambling, KYC and compliance](#16-responsible-gambling-kyc-and-compliance) |
| 17 | [Admin console](#17-admin-console) |
| 18 | [Background jobs and scheduling](#18-background-jobs-and-scheduling) |
| 19 | [Database, migrations and roles](#19-database-migrations-and-roles) |
| 20 | [Security posture and known exposure](#20-security-posture-and-known-exposure) |
| 21 | [Performance](#21-performance) |
| 22 | [Known contamination and pending destructive operations](#22-known-contamination-and-pending-destructive-operations) |
| 23 | [Blocked work, by what blocks it](#23-blocked-work-by-what-blocks-it) |
| 24 | [What the owner should do next, in order](#24-what-the-owner-should-do-next-in-order) |
| 25 | [Document map](#25-document-map) |

---

## 1. What this document is, and the rules it follows

It is the report that gets updated after every piece of work, so that "what is
the state of PlutoBet" has exactly one answer instead of six documents that
each answered it on a different day.

Rules it follows, and which the reports it replaced did not always follow:

1. **A claim carries its evidence, or it is not made.** "Tested" means a named
   test; "works" means an observed run.
2. **Passing tests are never presented as proof that an external service
   works.** Every payments test uses fixtures. Nothing here has contacted
   Paystack, Termii or Resend.
3. **A single completion percentage is not used.** It averaged "a screen is
   missing" against "no casino provider exists" and could not express that a
   customer cannot place a bet.
4. **Nothing is described as automatic that was invoked by hand.**
5. **Secrets, personal data and one-time codes are never written here.**
6. **A finding that was later fixed keeps its trail.** The detail lives in
   `docs/history/`; §25 says where.

**Standing instruction:** after every implementation, test, repair, deployment
or audit task, update this file with evidence-backed current status before
reporting completion. That instruction is also recorded in `AGENTS.md`.

---

## 2. How to read the status labels

| Label | Means |
|---|---|
| `VERIFIED_WORKING` | Exercised against a real database or real provider data, with a test or a recorded observation behind it |
| `VERIFIED_AUTOMATED_BY_ACCEPTANCE_TEST` | The **registered** function is driven end to end by tests. Not the same as having watched it happen unattended |
| `WAITING_ON_REAL_EVENT` | Code is ready; the proof needs a real-world occurrence nobody can hurry |
| `IMPLEMENTED_NOT_LIVE_TESTED` | Written and typechecked, never exercised against production-like conditions |
| `IMPLEMENTED_NOT_REACHABLE` | The logic exists and is tested, but nothing in the product can call it |
| `BLOCKED_BY_OWNER_CONFIGURATION` | Needs an account, a key, or a console the developer does not have |
| `BLOCKED_BY_KEY` | Needs a paid or approved third-party credential |
| `BLOCKED_BY_CONTRACT` | Needs a commercial agreement with a provider |
| `BLOCKED_BY_REGULATION` | Needs a licence or certification |
| `NOT_IMPLEMENTED` | Not built |

**The platform as a whole is not finished.** The core sportsbook flow —
register, browse, price, place, settle, pay — works. That is one flow out of a
product that also promises casino, virtuals, in-play, fantasy and more.

---

## 3. Where the project stands, in one page

| Question | Answer |
|---|---|
| Can a test account complete a bet end to end? | **Yes**, locally and against the dev database |
| Can a stranger's real money enter or leave? | **No.** No payment credentials exist |
| Does a winning bet get paid without a human? | **Yes** — proven once on a real fixture, §14 |
| Is the customer interface finished? | **Redesigned and complete for review**, §5. Not merged, not deployed |
| Is the deployment usable? | **No.** `NEXTAUTH_URL` and the runtime database role remain, §23 |
| Is it legal to operate? | **No.** No licence, §16 |

Two readiness questions, and they are different:

```bash
npm run readiness:demo          # can this serve a test account, end to end?
npm run readiness:real-money    # may this take a stranger's money?
```

- **`DEMO_READY` — not satisfied**, 2 blockers: `NEXTAUTH_URL` points at
  localhost, and the runtime database role owns the ledger (§20).
- **`REAL_MONEY_READY` — not satisfied**, 14 blockers: the two above plus
  Paystack deposits, Paystack payouts, Termii SMS, Resend email, a KYC
  provider, `SENTRY_DSN`, a real deposit proof, a real withdrawal proof,
  credential rotation, a verified restore drill, a gaming licence and a
  settlement bank account.

**QA ledger credit is not a deposit** and is never presented as one anywhere in
this product or its reporting.

---

## 4. Verification gates and their last results

Run from the repository root. Every figure below is from the run on the branch
described at the top of this file.

| Gate | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | **exit 0** |
| Lint | `npm run lint` | **exit 0** — 0 errors, 15 pre-existing warnings (unused imports in modules untouched by this pass) |
| Tests | `npx vitest run` | **68 files, 844 passed, 1 skipped, 0 failed** |
| The 1 skip | — | the opt-in live provider contract (`ODDS_LIVE_CONTRACT`) — **not counted as passing** |
| Build | `npx next build` | **exit 0** |
| Secret scan | `node scripts/secret-scan.mjs` | clean |
| Whitespace | `git diff --check` | clean |
| Migrations | `node scripts/check-migrations.mjs` | 27 of 27 applied to a clean database, 62 tables |
| Restore verifier | `npm run db:verify-restore` | 8 of 8 pass; ledger balanced, 0 negative wallets |
| Admin queries | `npm run admin:smoke` | clean |
| Sync benchmark | `npm run bench:sync` | completed at 200 and 775 events — §21 |
| Demo readiness | `npm run readiness:demo` | **exit 1**, correctly — §3 |
| Real-money readiness | `npm run readiness:real-money` | **exit 1**, correctly — §3 |
| Database roles | `npm run db:audit-roles` | **exit 1**, correctly — §20 |
| CI | GitHub Actions | green on both remotes for `main` |

Test count rose from 815 to 844 in this pass: +29 covering the betslip
arithmetic, the sign-in redirect guard, the navigation registry (§6) and the
stylesheet-import ordering that hid the whole redesign (§5 of
`UI_REDESIGN_REPORT.md`).

---

## 5. The customer-facing interface

Status: **redesigned, complete for review, not merged and not deployed.**

### What changed and why

| Before | Now |
|---|---|
| Homepage opened with a marketing hero and a grid of product tiles, most linking to products that do not exist | **The homepage is the odds board.** Prices are in the first viewport |
| One dark palette everywhere, including the match list | **Dark chrome over a light, dense canvas** — the grammar every sportsbook uses, because a wall of white rows is what makes odds scannable |
| Sign-in was NextAuth's built-in unbranded page | A branded `/signin` with the same credentials provider underneath |
| Registration was one narrow column on a wide empty page | A balanced two-panel layout that collapses to one column on a phone |
| Navigation carried emoji icons and "arrives in phase 13" | Icons are drawn glyphs; no internal build-phase number is shown to a customer |
| The footer claimed "Nigeria · Licensed operator" | **Removed.** A licence claim is a regulatory assertion, not decoration |
| Seventeen products in one header row, overflowing below desktop | Two rows: destinations, then sports |
| Two controls per board row led to `/sports/event/<id>`, which did not exist | The event page exists, listing every open market |

### The shape of it

```
┌───────────────────────────────────────────────────────────────┐
│  header: brand · destinations · search · balance · deposit    │  dark
│  sub-header: sports                                           │  dark
├───────────┬───────────────────────────────────┬───────────────┤
│ league    │  date/filters                     │  betslip      │
│ rail      │  league-grouped match board       │  (sticky)     │
│ (sticky)  │  1 X 2 · O/U 2.5 · +N markets     │               │
└───────────┴───────────────────────────────────┴───────────────┘
   <1180px: the betslip becomes a bottom sheet
   <900px:  the rail collapses; a bottom bar appears
```

### Files

| Area | Files |
|---|---|
| Tokens and surfaces | `src/styles/tokens.css`, `src/styles/sportsbook.css`, `src/styles/surfaces.css`, `src/styles/legacy-bridge.css` |
| Shell | `src/components/sportsbook/shell.tsx`, `header.tsx`, `footer.tsx`, `mobile-bar.tsx`, `page-shell.tsx` |
| Board | `board-page.tsx`, `match-board.tsx`, `odds-button.tsx`, `league-rail.tsx`, `date-strip.tsx` |
| Betslip | `betslip-store.tsx`, `betslip-panel.tsx`, `slip-math.ts`, `browser-store.ts` |
| Event page | `src/app/(site)/sports/event/[id]/page.tsx`, `event-markets.tsx` |
| Auth | `src/app/(site)/signin/`, `register/`, `forgot-password/` |

### What was deliberately NOT changed

Wallet accounting, the ledger, bet placement, settlement, locked odds,
exposure, provider ingestion, the database schema, payment logic, RBAC,
authentication validation, API response contracts, idempotency and the existing
security controls. This was a frontend pass. The one server-side addition is a
read-only query, `getEventView`, which the new event page needs and which
touches none of the above.

### The legacy bridge, and its end date

`src/styles/legacy-bridge.css` re-points the old design system's variables at
the new tokens, scoped to the `.sb` shell, so pages still carrying legacy
classes render in the new palette without a find-and-replace across money
forms. It is a migration aid with an end date: **delete it when no page inside
`.sb` uses a legacy class.** It is deliberately scoped so the admin console,
which renders outside that shell, is untouched.

---

## 6. Complete interaction inventory

Every visible control on a customer-facing page, what it does, and its status.
`VERIFIED_FUNCTIONAL` means the control reaches real behaviour — a route that
exists, a request that is answered, or state that persists.

### Header and global chrome

| Control | Does | Status |
|---|---|---|
| Brand mark | Navigates to `/` | `VERIFIED_FUNCTIONAL` |
| Sports / Live / Jackpot / Promotions | Navigate to those pages | `VERIFIED_FUNCTIONAL` |
| More ▾ | Opens a menu built from the navigation registry; entries not yet built are labelled "Not yet". Closes on outside click and on Escape | `VERIFIED_FUNCTIONAL` |
| Pluto AI | Navigates to `/pluto` | `VERIFIED_FUNCTIONAL` |
| Search | Expands in place; submitting navigates to `/sports?q=…`, which filters the board by team or competition. An empty query is a no-op rather than a pointless navigation | `VERIFIED_FUNCTIONAL` |
| Balance | Navigates to `/wallet`; shows the server-resolved balance, or `—` if it could not be read | `VERIFIED_FUNCTIONAL` |
| Deposit | Navigates to `/deposit` | `VERIFIED_FUNCTIONAL` |
| Account icon | Navigates to `/account` | `VERIFIED_FUNCTIONAL` |
| Sign in / Register | Navigate to `/signin`, `/register` | `VERIFIED_FUNCTIONAL` |
| Sports tabs (second row) | Navigate to `/sports?sport=…` | `VERIFIED_FUNCTIONAL` |
| Footer links | 13 links to real pages | `VERIFIED_FUNCTIONAL` |

### League rail (desktop)

| Control | Does | Status |
|---|---|---|
| Competition search | Filters the rail as you type | `VERIFIED_FUNCTIONAL` |
| Today / Upcoming / Live now | Navigate with the matching query | `VERIFIED_FUNCTIONAL` |
| League link | Filters the board to that competition | `VERIFIED_FUNCTIONAL` |
| Favourite star | Persists to `localStorage` and pins that competition to a "Your competitions" group at the top. Survives reload; syncs across tabs | `VERIFIED_FUNCTIONAL` |
| Country group | Expands and collapses | `VERIFIED_FUNCTIONAL` |

### Match board

| Control | Does | Status |
|---|---|---|
| League header | Collapses and expands that league | `VERIFIED_FUNCTIONAL` |
| Fixture star | Persists to `localStorage` and pins the match to a "Your matches" group at the top of the board | `VERIFIED_FUNCTIONAL` |
| Odds tile (1 / X / 2 / O2.5 / U2.5) | Adds or removes the selection from the betslip. Disabled when suspended, closed or unavailable, and renders `—` rather than inventing a price | `VERIFIED_FUNCTIONAL` |
| Statistics icon | Opens `/sports/event/<providerEventId>` | `VERIFIED_FUNCTIONAL` — the route was created in this pass |
| "+N" more markets | Same destination | `VERIFIED_FUNCTIONAL` — same |
| Filter chips (All upcoming / Today / Live / Jackpot / Clear) | Real links with real query parameters, so a filter can be bookmarked and shared | `VERIFIED_FUNCTIONAL` |

### Event page

| Control | Does | Status |
|---|---|---|
| Market header | Collapses and expands that market | `VERIFIED_FUNCTIONAL` |
| Every selection tile | Adds to the betslip at the stored price | `VERIFIED_FUNCTIONAL` |
| Back to competition | Returns to the filtered board | `VERIFIED_FUNCTIONAL` |

### Betslip

| Control | Does | Status |
|---|---|---|
| Betslip / My Bets tabs | Switch panes | `VERIFIED_FUNCTIONAL` |
| Remove selection | Removes it | `VERIFIED_FUNCTIONAL` |
| Stake field | Parsed to integer kobo; rejects anything that is not a plain naira amount | `VERIFIED_FUNCTIONAL` — 11 tests |
| Quick stakes (₦100/500/1,000/5,000) | Set the stake | `VERIFIED_FUNCTIONAL` |
| Place bet → Confirm | `POST /api/bets` with a fresh idempotency key; disabled while in flight; a success is only claimed for a response carrying a real bet id | `VERIFIED_FUNCTIONAL` |
| Clear all | Empties the slip | `VERIFIED_FUNCTIONAL` |
| Sign in to place bet | Shown instead of the submit when signed out | `VERIFIED_FUNCTIONAL` |
| Odds-moved warning | Compares the price now against the price when added | `VERIFIED_FUNCTIONAL` |
| Open My Bets / View in My Bets | Navigate to `/bets` | `VERIFIED_FUNCTIONAL` |
| Set a limit | Navigates to `/responsible` | `VERIFIED_FUNCTIONAL` |

The slip persists in `sessionStorage` and is the single source of truth for
picks and stake — there is no second copy in component state to drift from it.

### Mobile bar and sheet (under 900px)

| Control | Does | Status |
|---|---|---|
| Home / Sports / Live / Account | Navigate | `VERIFIED_FUNCTIONAL` |
| Betslip | Opens the bottom sheet; badge shows the selection count; Escape and the scrim close it; the page behind does not scroll | `VERIFIED_FUNCTIONAL` |

### Authentication

| Control | Does | Status |
|---|---|---|
| Sign-in form | `signIn("credentials", { redirect: false })`, then routes to a validated same-site callback | `VERIFIED_FUNCTIONAL` |
| Show / hide password | Toggles the field type | `VERIFIED_FUNCTIONAL` |
| Forgot password | Navigates to `/forgot-password` | `VERIFIED_FUNCTIONAL` |
| Register step 1 → Send code | `POST /api/auth/otp` | `BLOCKED_BY_KEY` — the request is real; **delivery** needs Termii |
| Register step 2 → Create account | `POST /api/auth/register`, then signs in through the ordinary credentials flow | `VERIFIED_FUNCTIONAL` |
| Change details | Returns to step 1 and clears the code | `VERIFIED_FUNCTIONAL` |
| Reset: send code | `POST /api/auth/password-reset` — always advances, so the page cannot be used to discover which addresses have accounts | `BLOCKED_BY_KEY` — delivery needs Resend |
| Reset: set new password | `PUT /api/auth/password-reset` | `VERIFIED_FUNCTIONAL` |
| Sign in with your new password | A link to `/signin`. **Fixed in this pass**: it used to call `signIn` with no password, which can only fail | `VERIFIED_FUNCTIONAL` |

### Account, wallet and money

| Control | Does | Status |
|---|---|---|
| Wallet: Deposit / Withdraw / My bets | Navigate | `VERIFIED_FUNCTIONAL` |
| Deposit: account number panel | Displays the dedicated NUBAN. There is deliberately no amount field — the customer transfers what they like and the webhook attributes it | `BLOCKED_BY_KEY` — needs Paystack to issue the account |
| Withdraw form | `POST /api/withdrawals` with an idempotency key; refuses under the minimum, over the balance, over the daily cap | `BLOCKED_BY_KEY` for the payout leg |
| Verify identity | Navigates to `/kyc` | `VERIFIED_FUNCTIONAL` (upload and review; no identity provider — §16) |
| Account: 9 manage tiles | Navigate to real pages | `VERIFIED_FUNCTIONAL` |
| Account: verify email | `POST /api/account/email-verify` | `BLOCKED_BY_KEY` — needs Resend |
| Security: change password | `POST /api/account/password` | `VERIFIED_FUNCTIONAL` |
| Security: sign out a device / all devices | `DELETE /api/account/sessions` — a revoked session is downgraded on its next request | `VERIFIED_FUNCTIONAL` |
| Preferences: odds format, notifications | `PUT /api/account/preferences` | `VERIFIED_FUNCTIONAL` |
| Safer gambling: set a limit | `POST /api/responsible` — lowering applies immediately, raising waits 24 hours | `VERIFIED_FUNCTIONAL` |
| Safer gambling: cool-off, self-exclude | Same route | `VERIFIED_FUNCTIONAL` |
| Referrals: copy link / share | Clipboard, and the Web Share sheet where the browser has one. **Added in this pass** — the link was previously printed as text for the customer to select by hand | `VERIFIED_FUNCTIONAL` |
| Rewards: see promotions | Navigates | `VERIFIED_FUNCTIONAL` |

### Controls that are deliberately inert, and say so

| Control | Why | Status |
|---|---|---|
| Live board prices | Shown for information. In-play placement needs a real in-play feed; a tappable price the server would refuse is worse than none | `BLOCKED_BY_CONTRACT` |
| Casino game cards | **No longer links.** They pointed at `/casino/play/<id>`, which does not exist; the only configured provider is the development sandbox, whose own launch URL returns an explainer rather than a game. The page now says the games cannot be opened | `BLOCKED_BY_CONTRACT` |
| Cash out | No control is shown anywhere — see §15 | `IMPLEMENTED_NOT_REACHABLE` |
| Fantasy / Live Casino / Lucky Numbers | An honest unavailable page with routes to what does work | `NOT_IMPLEMENTED` |

### Dead controls found and closed in this pass

| Was | Now |
|---|---|
| `/sports/event/<id>` — two links per board row, both 404 | The page exists and lists every open market |
| Header search linked to `/sports?focus=search`, which nothing read | A real search that filters the board |
| League and fixture stars toggled a colour and forgot it | Persist and pin |
| "Sign in" after a password reset called `signIn` with no password | A link to the sign-in form |
| Casino tiles linked to a launch route that does not exist | Non-linking cards with an explanation |
| The More menu labelled Results and Livescore "Soon" although both work | Labels come from the registry's real status |
| Referral link printed as text | Copy and share buttons |

---

## 7. Design system

Tokens live in `src/styles/tokens.css` and nothing outside that file names a
colour. Names are semantic (`--sb-odds-bg`) rather than descriptive
(`--green-500`): a descriptive name says what it looks like, a semantic one says
when to use it, which is the question a component author actually has.

| Group | Notes |
|---|---|
| Brand | `#00c968` with a stronger `#00a957` for text and small elements; `--sb-brand-ink` is the only colour placed on top of it and meets AA against both |
| Chrome | Five dark values for the header, footer, balance panel and menus |
| Canvas | Off-white page, white surfaces, two greys, two border weights |
| Status | Live, warn, danger, up, down — every one paired with a word in the interface, so meaning survives greyscale and colour blindness |
| Odds tile | Its own group, because a price has nine states and they must be reviewable side by side |
| Spacing | A 4px/8px rhythm, ten steps |
| Type | Six sizes. Six is enough for a sportsbook and removes the argument about 13px versus 13.5px |
| Controls | Four heights, of which `--sb-h-touch: 44px` is a floor, not a suggestion |
| Focus | One ring, defined twice — for the light canvas and the dark chrome |
| Motion | Reduced to zero under `prefers-reduced-motion`; nothing carries meaning through motion alone |

The odds tile is written as plain CSS against `data-state` rather than as
utility classes, because expressing nine states as class strings inside JSX
makes them impossible to review together.

---

## 8. Accessibility and mobile

| Concern | How it is handled |
|---|---|
| Touch targets | 44px minimum, set through a token rather than left to whatever an icon measures |
| Odds tiles | `aria-pressed` for selection; the accessible name carries label, price and state, because "2.10" alone tells a screen-reader user nothing |
| Unavailable prices | Rendered as `—` and disabled, never as a plausible number |
| Collapsible groups | `aria-expanded` plus `aria-controls` on every league and market header |
| Betslip sheet | `role="dialog"`, `aria-modal`, Escape to close, background scroll locked |
| Forms | Every field has a real `<label>`; errors use `role="alert"` and `aria-describedby`; invalid fields carry `aria-invalid` |
| Inputs on iOS | 16px font on every text input, or Safari zooms the page on focus |
| Colour | Never the only signal — every status pill carries its own word |
| Motion | `prefers-reduced-motion` zeroes the durations and stops the live pulse and skeleton shimmer |
| Safe areas | The mobile bar and betslip sheet respect `env(safe-area-inset-bottom)` |
| Wide content | Tables and boards scroll inside their own container; the page body never scrolls sideways |

Breakpoints: 1180px drops the betslip to a sheet, 900px collapses the rail and
raises the bottom bar, 720px hides the Over/Under columns, 600px and 480px tune
padding and figure sizes, 440px stacks paired form fields.

---

## 9. Authentication and account

| Item | Status |
|---|---|
| Registration over HTTP, age gate, duplicate refusal | `VERIFIED_WORKING` |
| Password hashing (argon2id) | `VERIFIED_WORKING` |
| Sign-in through the credentials provider | `VERIFIED_WORKING` |
| Branded sign-in page | `VERIFIED_WORKING` — presentation only; `authOptions.pages.signIn` points at it, and `authorize()` is unchanged |
| Same-site redirect guard | `VERIFIED_WORKING` — 7 tests; rejects another origin, protocol-relative, backslash, non-rooted and control-character callbacks |
| Session revocation ("sign out my other device") | `VERIFIED_WORKING` |
| Re-read of role and status on every request | `VERIFIED_WORKING` — suspension takes effect on the next request, not at token expiry |
| Phone verification delivery | `BLOCKED_BY_KEY` — Termii |
| Email verification delivery | `BLOCKED_BY_KEY` — Resend |

The sign-in page shows one failure message for a wrong password, an unknown
address, a suspended account and a self-excluded one, because `authorize()`
returns the same `null` for all four. A more helpful message would re-introduce
the account-enumeration oracle the server was careful to remove.

---

## 10. The money core

| Property | Status |
|---|---|
| Integer kobo (`BIGINT`) end to end, no float in any money path | `VERIFIED_WORKING` |
| Double-entry, append-only ledger; deferred triggers reject unbalanced, empty, malformed or cache-divergent commits | `VERIFIED_WORKING` |
| Three wallet rows per account (CASH / BONUS / LOCKED) as rows, not columns, so every trigger covers them unchanged | `VERIFIED_WORKING` |
| Row locks (`SELECT … FOR UPDATE`); transfers lock both wallets in UUID order | `VERIFIED_WORKING` — 100-way hammer |
| Idempotency with SHA-256 request fingerprints — a replayed key with different parameters raises a typed conflict | `VERIFIED_WORKING` |
| Bonus credit cannot be withdrawn — refused by a database trigger, not a service check | `VERIFIED_WORKING` |
| Corrections are compensating entries, never edits | `VERIFIED_WORKING` |
| Money formatting, including negatives | `VERIFIED_WORKING` — 24 tests |

**Any new query against `wallets` must name a bucket.** Six queries once
resolved "the user's wallet" by `(user_id, kind, currency)`, matched all three
rows and took whichever the planner returned first — the ledger stayed
balanced and the money landed where the customer could not spend it.

---

## 11. Deposits and withdrawals

| Item | Status |
|---|---|
| Paystack adapter, webhook signature validation (HMAC-SHA512 over the raw body, constant-time) | `VERIFIED_AUTOMATED_BY_ACCEPTANCE_TEST` on fixtures |
| Deposit idempotency | `VERIFIED_WORKING` |
| Withdrawal balance reservation, KYC caps, manual approval | `VERIFIED_WORKING` in tests |
| A real deposit | `BLOCKED_BY_KEY` |
| A real payout | `BLOCKED_BY_KEY` |

**Not one byte has ever been exchanged with Paystack.** The adapter is written
against published documentation and exercised only by fixtures.

The withdrawal form still asks for a numeric bank code rather than offering a
list. That is deliberate: the codes route real money, so they have to come from
the provider's own bank list through a server route, not from a table typed out
by hand. Recorded as outstanding work rather than guessed at.

---

## 12. Betting: pricing, placement, exposure

| Item | Status |
|---|---|
| Odds ingestion and `1x2` | `VERIFIED_WORKING` — 333 open selections on upcoming fixtures |
| Provider response parsing | `VERIFIED_WORKING` — pinned against real captured payloads, plus an opt-in live check |
| Bet placement over HTTP | `VERIFIED_WORKING` — 15 tests including concurrent placement repeated 5× |
| Stake debited at placement, not at settlement | `VERIFIED_WORKING` |
| Odds locked at placement | `VERIFIED_WORKING` — settlement reads `bet_legs.locked_odds_decimal`, never the current price |
| Exposure claimed per market at placement | `VERIFIED_WORKING` |
| Idempotent replay releases exactly what that attempt claimed | `VERIFIED_WORKING` — see §22 for the rows the pre-fix behaviour left behind |
| Singles, accumulators, system bets, bankers, booking codes | `VERIFIED_AUTOMATED_BY_ACCEPTANCE_TEST` |
| Bet builder (correlated legs) | `NOT_IMPLEMENTED` — also needs a pricing provider |
| Edit bet | `NOT_IMPLEMENTED` |

---

## 13. Settlement

The chain, and what makes each part reliable:

```
pollMatchResults (cron * * * * *)
  └─ ingest the provider result, and in the SAME transaction
     write a settlement_outbox row                       ← closes the dual write
dispatchSettlementOutbox (cron * * * * *)
  └─ claim due items FOR UPDATE SKIP LOCKED
  └─ send settlement/event.finished, id = key + attempt   ← so a retry delivers
settleEvent
  └─ settleBet ×N   (idempotent, moves money)
  └─ close the event's markets
recoverStrandedSettlements (cron */2 * * * *)
  └─ level-triggered sweep: any PENDING bet on an event with a final result
```

| Item | Status |
|---|---|
| Win / loss / void / partial settlement, idempotency | `VERIFIED_WORKING` |
| Automatic settlement scheduling | `VERIFIED_AUTOMATED_BY_ACCEPTANCE_TEST` — 9 tests through the registered function |
| Unattended result ingestion | `VERIFIED_WORKING` — observed, §14 |
| Unattended bet settlement | `VERIFIED_WORKING` — observed, §14 |
| Transactional outbox, dispatcher, recovery sweep | `VERIFIED_WORKING` — 19 acceptance tests |
| Per-stage heartbeats and stall alerts | `VERIFIED_WORKING` — recorded a real failure with its cause on the first live run |
| Result-poll fairness and backoff | `VERIFIED_WORKING` — money waiting sorts first; an unscorable event is deferred, never resolved |

Three design points worth keeping in mind before changing any of this:

1. **Inngest invokes a handler once per step.** Code inside `step.run` is
   memoised; code outside it re-executes on every invocation. A cadence claim
   placed outside a step made the entire dispatch unreachable for every event,
   always.
2. **The recovery sweep is level-triggered on purpose.** It asks "is any
   PENDING bet sitting on a finished event", not "did a message get lost". That
   is why it recovered a bet no edge-triggered retry could have.
3. **A dispatch id must include the attempt.** Inngest deduplicates by event id,
   so a stable id meant every re-dispatch was silently dropped and the retry
   path had never once delivered.

---

## 14. The real bet that proved the pipeline

| | |
|---|---|
| Bet | `d7d34d58-507a-4bb0-95e0-338d1626d706` |
| Fixture | Fortaleza FC v CD Once Caldas — Colombia, Liga DIMAYOR Finalizacion |
| Selection | away @ 2.150 |
| Stake / gross return | ₦200.00 / ₦430.00 |
| Result | 1–2 — the away side won |

Registered, funded and placed entirely through the public HTTP routes.
Registration refused an underage date of birth (403) and a duplicate email
(409); placement refused an over-balance stake (409), a zero stake (422) and
stale odds (409), and a duplicate submit returned the same bet id rather than a
second bet.

The match finished, the scheduler ingested the real result on its own — and the
bet then sat `PENDING` for fourteen hours because the hand-off to settlement
was unreachable. After the repair it was recovered **by the pipeline, with no
human in the loop**:

```
13:56:48  SETTLEMENT_RECOVERY_ENQUEUED  1 pending bet on an event with a final result
13:56:49  outbox DISPATCHED             source=RECOVERY, attempts=1
13:56:56  ledger PAYOUT CREDIT 43000
13:56:58  outbox COMPLETED
```

| Evidence | Result |
|---|---|
| Bet status | **WON**, `settled_at` populated |
| Payout | **exactly one** transaction, ₦430.00 |
| CASH balance | ₦0 → ₦430.00 |
| Markets | all 5 `SETTLED`, 0 of 68 selections open |
| Ledger | ₦2,035.00 debits = ₦2,035.00 credits, 0 negative wallets |
| Remaining recovery candidates | **0** |
| Same sweep, wider effect | 21 stranded events recovered, 0 failures |
| Stability | still `WON` with exactly one payout after 433 dispatcher and 228 recovery runs |

---

## 15. Cash-out: built, and deliberately unreachable

Status: **`IMPLEMENTED_NOT_REACHABLE`. No control is shown, and none should be
added until the defect below is fixed.**

`src/modules/betting/cashout.service.ts` implements full and partial cash-out
with tests. It is well constructed: the offer is re-priced under the bet's row
lock rather than trusting a quoted figure, a lower re-price is refused so the
customer is never paid less than they accepted, a higher one is paid in full,
the lock order matches placement and settlement, and settlement already pays on
the stake still at risk so a partially cashed-out bet cannot be paid twice for
the same portion.

**There is no API route and no caller.** Two things must be true before one is
added, and one of them is not:

| Invariant | State |
|---|---|
| Full cash-out releases exposure exactly once | **Holds.** The bet becomes `CASHED_OUT` and never reaches settlement |
| Settlement pays only the stake still at risk after a partial | **Holds.** `settlement.service.ts` subtracts `cashed_out_stake_minor` |
| **Partial cash-out releases exposure exactly once** | **DOES NOT HOLD.** The partial releases a proportional slice, and settlement later releases the full `potential_return − stake` again. The market's liability is therefore over-released — floored at zero by `GREATEST`, so it can read as no exposure while other bets still carry real liability |
| The service refuses a suspended, self-excluded or closed account | **Not present in the service.** Placement and withdrawal gate on account status; cash-out does not, so a route would have to add that check |

No money is misplaced by either gap — exposure is a risk ceiling, not a
balance, and the status check would sit in the route rather than the ledger.
Both are nonetheless money-adjacent, and the instruction for this pass was to
ship cash-out only if **every** invariant was complete. It is not, so the
feature stays unreachable and the defect is recorded here rather than papered
over with a button.

---

## 16. Responsible gambling, KYC and compliance

| Control | Status |
|---|---|
| Age gate — refused at registration and again by a database trigger | `VERIFIED_WORKING` |
| Date-of-birth backfill for accounts predating the gate | `NOT_IMPLEMENTED` — the column is nullable; enforcement is not structural until it is not |
| Deposit, loss and stake limits — lowering immediate, raising delayed 24 hours | `VERIFIED_WORKING` |
| Self-exclusion, surviving re-registration via an identity digest under a server-held pepper | `VERIFIED_WORKING` |
| Unverified accounts cannot withdraw (tier 0 → ₦0 daily cap) | `VERIFIED_WORKING` |
| KYC document upload and review | `VERIFIED_WORKING` |
| **BVN/NIN verification against a registry** | **`NOT_IMPLEMENTED`.** A digest is stored; it is never checked against anything. "KYC tier" is an internal authorisation model — it decides what a tier may do, not whether anybody is who they say they are |
| Bank-account name matching | `NOT_IMPLEMENTED` |
| Gaming licence | `BLOCKED_BY_REGULATION` |
| Independent RNG / platform certification | `BLOCKED_BY_REGULATION` |

The footer no longer claims a licence. Taking real money from Nigerian
customers without one is a legal exposure that no amount of test coverage
addresses.

---

## 17. Admin console

18 screens, RBAC with 8 roles and 31 permissions, step-up re-authentication held
server-side in Redis and failing closed, and an audit trail with a
database-enforced reason.

Status: `IMPLEMENTED_NOT_LIVE_TESTED`. `npm run admin:smoke` executes every
admin query against a real schema and passes; no human has used the console
against production traffic.

**The admin console was not part of the interface redesign.** It renders
outside the `.sb` shell and keeps the dark system deliberately: it is an
internal tool, and re-skinning it here would have been an unreviewed change to
screens that approve withdrawals.

---

## 18. Background jobs and scheduling

13 Inngest functions register with a running scheduler. Cadence is claimed
through an atomic `SET NX` with a TTL, so two instances cannot both run one job.

`job_heartbeats` records every run — including the ones that find nothing,
because "ran and found nothing" and "did not run" are otherwise
indistinguishable and only one of them needs somebody woken up. The alert
distinguishes "no successful poll in N minutes" from "never succeeded on this
deployment"; the second is the one that catches a job nobody ever started.

Error messages written to that table are scrubbed of URLs, hostnames and IP
addresses before storage, so an improved error message cannot start publishing
the database endpoint.

Local development needs the scheduler explicitly enabled: `INNGEST_DEV=1`, via
`npm run dev:local`. Without it the SDK chooses cloud mode whenever signing keys
are present, registers zero functions, and no cron fires — which once looked
exactly like a working setup.

---

## 19. Database, migrations and roles

| Item | Value |
|---|---|
| Engine | PostgreSQL (Neon serverless) |
| Migrations | 27, all applied to a clean database, 62 tables |
| Pooled connection | `DATABASE_URL` — ordinary reads through Neon's pooler, `prepare: false` |
| Unpooled connection | `DIRECT_DATABASE_URL` — money paths only, because row locks and `SET LOCAL ROLE` are session-scoped and unsafe through a transaction pooler |
| Owner connection | `MIGRATION_DATABASE_URL` — migrations only |
| Pool sizing | 10 pooled / 5 direct, configurable, refusing rather than clamping an out-of-range value. Was `max: 1`, which serialised the entire application on Railway's single persistent container |

`SET LOCAL ROLE app_role` is issued inside every money transaction. What that
role can and cannot do is pinned by 12 tests that attempt real DDL through the
real runtime client: PostgreSQL refuses `DROP`, `ALTER`, `TRUNCATE`, `DELETE`,
disabling the balance trigger, replacing the trigger function and creating
tables in `public`. It keeps **column-level** UPDATE on `wallets` — it can write
the balance and version columns and cannot write `user_id` or `kind`, so it
cannot move a balance between people.

---

## 20. Security posture and known exposure

### The most serious open finding

`npm run db:audit-roles` reports, read-only, for all three configured URLs:

```
session_user / current_user / current_role   neondb_owner
superuser                                    no
bypasses RLS                                 YES
owns ledger tables                           YES (ledger_entries, ledger_transactions, wallets)
can DROP / ALTER / TRUNCATE ledger           YES
can grant itself more                        YES
```

The money paths are safe — they set the restricted role per transaction. **The
pooled READ client does no role handling at all**, and thirty-four files import
it: every board query, every admin page, every public route. A compromised read
path inherits owner rights over the ledger.

`SET ROLE` on the pooled connection is not a reliable fix: that URL goes through
a transaction-mode pooler where a session-level role does not dependably survive
to the next transaction. The fix is a separate least-privilege credential for
`DATABASE_URL`; the exact SQL is in `OWNER_LAUNCH_CHECKLIST.md` §13.
`production:check` **fails** on this rather than noting it beside a passing
check, which is how a privilege problem survives a review.

### Everything else

| Control | Status |
|---|---|
| Passwords — argon2id | `VERIFIED_WORKING` |
| Sessions — httpOnly, sameSite, secure; revocation honoured on the next request | `VERIFIED_WORKING` |
| Input validation — Zod at every boundary | `VERIFIED_WORKING` |
| Webhook verification — HMAC over the raw body, constant-time | `VERIFIED_WORKING` |
| Rate limiting and OTP storage | `VERIFIED_WORKING` locally; needs Redis in the deployment |
| Open-redirect guard on sign-in | `VERIFIED_WORKING` — §9 |
| Secret scanning in CI | `VERIFIED_WORKING` — 15 rules |
| `IDENTITY_PEPPER` rotation | **NOT DONE.** Possible only while every account is a test account; permanently impossible afterwards |
| Rotation of credentials pasted into a chat during setup | **NOT DONE** — Neon, Upstash, Backblaze, Inngest, odds-api.io |
| Managed secret storage | `NOT_IMPLEMENTED` — `.env` is gitignored, and that is all |
| Penetration testing | `NOT_IMPLEMENTED` |
| Prompt-injection corpus for the AI surfaces | `NOT_IMPLEMENTED` — guardrail tests exist; a dedicated corpus does not |

---

## 21. Performance

Fixture-sync classification, measured before and after on the same dataset,
process and database (`npm run bench:sync`). Both runs completed; no terminated
measurement is quoted.

| Events | Before | After | Speedup | Statements | Transactions |
|---|---|---|---|---|---|
| 200 | 3,815–4,235 ms | 84–86 ms | **45–49×** | 4,000 → 24 (167×) | 400 → 2 |
| 775 | 12,832–15,505 ms | 1,457–2,193 ms | **7.1–8.8×** | 15,500 → 96 (162×) | 1,550 → 8 |

Ranges rather than single figures, because two runs of the same benchmark on the
same machine differ by that much under load — which is exactly why the tests
assert statement counts and not milliseconds. The statement reduction was
identical across runs. Target was 3×.

The benchmark boots its own throwaway cluster and refuses to run against a
non-ephemeral database, after an earlier version wrote through the shared client
(§22).

Not load-tested: the homepage, `/api/live` polling at scale, casino callbacks,
and Pluto AI concurrency. Only bet placement has a load test.

---

## 22. Known contamination and pending destructive operations

Both need owner approval. **Neither has been run.**

### 400 synthetic fixtures in the production database

Written by an earlier version of the benchmark when it still used the shared
pooled client. They carry a `bench-<timestamp>` provider tag, have no bets
against them (verified), and would appear on the customer-facing board as real
matches.

```bash
npm run db:clean-benchmark              # reports, changes nothing
npm run db:clean-benchmark -- --confirm # deletes
```

It refuses outright if any bet references them — that would be a data-integrity
problem, and deleting the evidence would be the wrong response.

**They must not appear in review screenshots.** The screenshots in this pass
were taken against a local disposable database seeded with `npm run db:seed-demo`
(five clearly-named demo fixtures), never against the database holding these.

### ₦630 of residual exposure across two markets

| Market | Fixture | Residual |
|---|---|---|
| `701daa4f-8b00-4d36-bf97-5ef236a3e52a` | Dinthar FC v Saikhamakawn FC `1x2` | ₦400.00 |
| `822cfe03-f701-4251-86e4-3a3e7842baed` | Fortaleza FC v CD Once Caldas `1x2` | ₦230.00 |

Left by the duplicate-submit defect described in §12, which is fixed. **No money
is involved** — exposure is a risk ceiling, not a balance. The ledger nets to
zero, every affected bet has exactly one payout, and both markets are already
`SETTLED`.

```bash
npm run db:repair-exposure                                   # dry run, prints a fingerprint
npm run db:repair-exposure -- --expect=<fingerprint> --confirm
```

The confirmed run refuses without the fingerprint from a dry run, and refuses
again if the data changed since — approving a repair you have read and applying
one you have not are different acts.

---

## 23. Blocked work, by what blocks it

### Blocked by owner configuration

| Item | Detail |
|---|---|
| `NEXTAUTH_URL` | Points at localhost, so sign-in callbacks send real users to their own machine. The documented example domain returns "Application not found"; the correct value is not knowable from here |
| Runtime database role | §20 |
| Railway database and Redis | Neither is attached |
| Restore drill | No Neon API key. Runbook and a tested verifier are in `docs/restore-runbook.md` |
| `SENTRY_DSN` | Unset — no production error visibility |
| First administrator | `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, then `npm run db:seed-admin` |

### Blocked by a key

Paystack deposits and payouts · Termii SMS · Resend email · an LLM key for
Pluto AI, which is a keyword router today and needs an adapter, prompt-injection
tests and concurrency tests once a key exists — not "swap a key".

### Blocked by a contract

Casino aggregator · Live Casino · virtuals provider · in-play feed ·
correlated-leg pricing for a bet builder · a KYC identity provider.

### Blocked by regulation

A gaming licence, and independent certification.

### Blocked by nothing — the developer backlog

| Item | Note |
|---|---|
| Cash-out exposure defect | §15. Fix it, then the route and the UI become legitimate |
| Account-status gate on cash-out | §15 |
| Edit bet | No code of any kind |
| Bank list for withdrawals | Needs a server route over the provider's own list — §11 |
| Date-of-birth backfill | Needs an owner policy decision first |
| Redis caching of `liveVersion` | A three-table aggregate runs on every `/api/live` request |
| Load tests for the homepage, `/api/live`, casino callbacks and the AI | §21 |
| Prompt-injection corpus | §20 |
| Retire the legacy bridge | §5 |
| Personalisation, Admin AI, Fantasy, Lucky Numbers | Greenfield |

---

## 24. What the owner should do next, in order

1. **Review the redesign screenshots and approve or reject the merge.** Nothing
   in this pass has been merged or deployed.
2. **Rotate `IDENTITY_PEPPER`** — possible only while every account is a test
   account, permanently impossible after the first real customer.
3. Rotate Neon, Upstash, Backblaze, Inngest, then odds-api.io.
4. Give Railway a database, Redis, and a real `NEXTAUTH_URL`.
5. Create the least-privilege runtime database credential (§20).
6. Run `npm run production:check -- --remote=<url>` until it exits 0.
7. Seed the first administrator.
8. Approve the synthetic-fixture cleanup and the exposure repair (§22).
9. Perform the restore drill and record the numbers.
10. Buy Termii credits and create a Resend account — until then nobody can
    complete a registration.
11. Obtain Paystack approval and live keys; prove one small real deposit and one
    small real payout.
12. Contract a KYC identity provider.
13. Resolve licensing before taking money from anybody.

---

## 25. Document map

| Document | Role |
|---|---|
| **`general.md`** | **This file. The single source of truth.** |
| `OWNER_LAUNCH_CHECKLIST.md` | Step-by-step owner actions, including the two approval blocks in §22 |
| `NEXT_WORK_REPORT.md` | The running log of what each pass did |
| `UI_REDESIGN_REPORT.md` | The detail of the interface redesign |
| `docs/deployment.md` | How to deploy and what each variable is for |
| `docs/restore-runbook.md` | How to restore, and what to check afterwards |
| `docs/settlement-operations.md` | Running the settlement pipeline |
| `docs/security-review.md` | The security review |
| `docs/who-does-what.md` | Division of responsibility |
| `docs/FSGRN-technical-topography.md` | Regulatory topography |

### Consolidated into this file

Five status documents each answered "what is the state of PlutoBet" as of a
different day, and disagreed with each other. They were read in full and their
still-true content is above. They are kept in `docs/history/` because the trail
from a defect to its fix is worth reading, and because deleting evidence to tidy
a directory is the wrong instinct on a money system.

| Was | Now | What it uniquely recorded |
|---|---|---|
| `docs/history/PROJECT_STATUS.md` | `docs/history/PROJECT_STATUS.md` | The money-path repair, in full |
| `docs/history/PLUTOBET_STATUS.md` | `docs/history/PLUTOBET_STATUS.md` | The 2026-08-27 phase table and the Railway 500 |
| `docs/history/PLUTOBET_CORE_FLOW_VALIDATION.md` | `docs/history/PLUTOBET_CORE_FLOW_VALIDATION.md` | The core-flow validation and its six bugs |
| `docs/history/DEVELOPER_COMPLETION_REPORT.md` | `docs/history/DEVELOPER_COMPLETION_REPORT.md` | The money-formatter and poll-fairness pass |
| `docs/history/GPT.md` | `docs/history/GPT.md` | The cold-read engineering audit, and its section on how documentation drifted optimistic |
