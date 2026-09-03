# PlutoBet — general status

**This file is the single source of truth for the state of this project.**
Every other document in the repository is either a runbook, an owner checklist,
or historical evidence of one pass. Where any of them disagrees with this file,
this file is right.

**Last updated:** 2026-09-02
**Branch described:** `ui/plutobet-sportsbook-redesign` (branched from `main`)
**Merged to `main`:** no. **Pushed:** no. **Deployed:** no.
Commit count and remote state are recorded in §0, read from git.

**No credential, connection string, one-time code, personal detail or other
secret value appears anywhere in this document, and none may be added to it.**
Environment variables are named and reported only as set / missing / blocked.

---

## §0 — Resume Here

**This section is the recovery point.** If a session ends for any reason, a
fresh one reads this, checks it against `git log` and `git status`, and
continues from "Exact next action" without repeating finished work.

It is rewritten and committed after every completed unit of work. If it
disagrees with the repository, the repository is right and this section is
stale — say so and correct it.

### The assignment

Final developer-completion, UI-integration, security and end-to-end
verification pass. In the owner's words, the goal is to:

- finish every genuinely developer-owned task that needs no purchased key,
  signed contract, owner dashboard, regulatory approval, or irreversible
  product-policy decision;
- accept and integrate the approved sportsbook redesign;
- make every enabled customer-facing control perform real behaviour;
- test the complete sportsbook flow end to end;
- fix every defect found;
- update this file truthfully;
- merge and push **only if** every required gate passes.

Target on completion: **`DEVELOPER_OWNED_SPORTSBOOK_MVP_COMPLETE`**. Not
"the platform is complete". External integrations and regulated products stay
honestly classified as blocked.

Standing constraints for this pass, in short form — the full list is in the
owner's instruction and none of it is negotiable:

- No assumption presented as fact. Evidence levels only (§0.1).
- No fake external success: QA credit is not a deposit, a fixture is not a
  provider, a sandbox is not a casino, a keyword router is not a model.
- No manual money manipulation. Balances, ledger rows, bet outcomes, event
  results, outbox status and exposure move only through application services,
  public routes, registered jobs, migrations, or QA-gated utilities against a
  disposable database.
- Real production money and customer data are not touched. All development,
  browser testing, screenshots, seeding and load testing run against a local
  disposable database.
- The 400 synthetic production fixtures are **not** deleted. The ₦630 historical
  exposure repair is **not** applied. Both need owner approval on a dry-run
  fingerprint.
- No secret printed, logged, committed, screenshotted or written into Markdown.
- No weakening of tests or security to obtain green results.
- No force push, destructive reset, history rewrite, or branch-protection
  bypass.
- No Railway deployment and no live provider activation.

### §0.1 Evidence levels used in this file

`VERIFIED_IN_REAL_BROWSER` · `VERIFIED_END_TO_END` ·
`VERIFIED_AGAINST_REAL_PROVIDER_DATA` · `VERIFIED_BY_INTEGRATION_TEST` ·
`VERIFIED_BY_UNIT_TEST_ONLY` · `IMPLEMENTED_NOT_LIVE_TESTED` ·
`BLOCKED_BY_KEY` · `BLOCKED_BY_CONTRACT` · `BLOCKED_BY_OWNER_CONFIGURATION` ·
`BLOCKED_BY_PRODUCT_DECISION` · `BLOCKED_BY_REGULATION` · `NOT_IMPLEMENTED` ·
`FAILED`

A status is never upgraded without the evidence its level names.
`VERIFIED_IN_REAL_BROWSER` means the control was clicked or submitted in a
browser during this pass — not that it looks right in the source.

### Repository state at this checkpoint


| | |
|---|---|
| Branch | `ui/plutobet-sportsbook-redesign` |
| HEAD | `23b595d` — "Measure the read paths under load, and the limiter that shields them" |
| Working tree | **NOT clean** — stage 7/8 work, committed next |
| Commits ahead of `main` | **21** (read from `git rev-list`, not from memory) |
| Behind `main` | 0 |
| `origin/main` | `83cb633` |
| `plutobet/main` | `83cb633` |
| Redesign branch pushed | **no** |
| Merged to `main` | no |
| Deployed | no |

> A previous version of this file said "seven commits". It was wrong. Commit
> counts are read from git, never repeated from a document.
### Stages


| # | Stage | Status |
|---|---|---|
| 1 | Read every instruction, report and runbook; inspect git state | **DONE** |
| 2 | Repository audit + task matrix | **DONE** |
| 3 | Redesign verification in a real browser | **DONE** — 118 passed, 6 skipped, desktop + Pixel 7 |
| 4 | Interaction audit of every enabled control | **DONE** — 32 rows, generated from the run |
| 5a | Cash-out: repair partial cash-out and exposure | **DONE** |
| 5b | Cash-out: eligibility gate, replay, concurrency | **DONE** |
| 5c | Cash-out: authenticated route, UI, audit, admin visibility | **DONE** |
| 5d | **Date-of-birth backfill** | **DONE** |
| 5e | **Live-version Redis cache** | **DONE** |
| 5f | **Withdrawal bank list** | **DONE** |
| 5g | **Edit bet** | **BLOCKED_BY_PRODUCT_DECISION** |
| 5h | **Legacy style bridge removal** | **DONE** — bridge deleted |
| 5i | **Prompt-injection corpus** | **DONE** — 53 attacks, 59 tests, 3 defects found |
| 5j | **Personalisation / Admin AI** | **BLOCKED_BY_PRODUCT_DECISION** (+ `BLOCKED_BY_KEY` for Admin AI) |
| 5k | **Fantasy / Lucky Numbers** | **DONE** — honest unavailable pages; a fabricated blocker fixed |
| 6 | **Load and reliability testing** | **DONE** for the read paths; casino callbacks have no route to load |
| 7 | **Full E2E journey** | **DONE** — 14 steps, one account, one run; 2 defects found |
| 8 | **Security re-verification** | **DONE** for what this pass changed |
| 9 | Complete gates, twice | NOT STARTED |
| 10 | Truthful `general.md` rewrite + changelog | NOT STARTED |
| 11 | Merge and push, only if every gate passes | NOT STARTED |

### Completed this pass, with evidence


### Stage 2 — automated repository audits

`TODO`/`FIXME`/`HACK`/`XXX`: **0** in source. `href="#"` and empty handlers:
**0**. Skipped or `.only` tests: **0** (the one `describe.skipIf` is the opt-in
live provider contract). Suppressed lint/TS rules: **3**, each documented.
Internal links to routes that do not exist: **0 of 25**, against 46 pages and 26
API routes. `wallets` queries missing a bucket: **0 real** — two pattern hits
read and cleared (a primary-key lookup that verifies ownership after, and a
reconciliation sweep that must scan every bucket to find drift).

### Stage 5a–5c — cash-out, from broken to exposed

Was `IMPLEMENTED_NOT_LIVE_TESTED`; now `VERIFIED_BY_INTEGRATION_TEST` end to end
through its HTTP route, 35 tests across three files. Not yet
`VERIFIED_IN_REAL_BROWSER` — stage 4 does that.

**Two defects, one worse than previously reported.**

1. `FAILED` → fixed. **Partial cash-out could never have succeeded.** 0007's
   `bets_cashout_matches_status` requires `cashout_value_minor IS NULL` unless
   the bet is `CASHED_OUT`; 0016 added partial cash-out, which leaves the bet
   `PENDING` while recording value, and never revisited the constraint. Every
   call raised Postgres `23514`. Unnoticed because **nothing called it** — no
   route, no UI, no test. §15 previously called it well constructed with only an
   exposure defect; that was wrong.
2. `FAILED` → fixed. **Exposure would have been released twice.** `GREATEST`
   floors a double release at zero rather than raising, so a market would report
   less liability than it holds — the direction that lets a ceiling admit risk it
   exists to refuse.

`cashout-exposure.acceptance.spec.ts` was written first and **failed 5 of 7**
against the unmodified code.

`0027_cashout_partial_repair.sql` replaces the constraint and adds
`released_liability_minor`, bounded at or below the claim so a double release is
a loud error. Every release returns `claim − released` and records what it gave
back; division truncates deliberately and the final instalment returns the
remainder.

**Boundary** (11 tests): only `ACTIVE` may cash out, with `SUSPENDED`,
`RESTRICTED`, `SELF_EXCLUDED` and `CLOSED` each asserted and the balance checked
unchanged after refusal; identity-level exclusion runs in the same transaction;
ownership is checked first and refused with the same reason an ineligible account
gets; a retry returns the **original** result; two full cash-outs racing pay once;
two partials racing cannot buy back more stake than the bet carries.

**Route** — `GET`/`POST /api/bets/[id]/cashout` (17 tests). `GET` prices without
taking; a refusal to quote answers 200 with `available: false` because a
suspended market is a market condition, not an error — except an ineligible
account, which stays 403. Each reason maps to its own status. The price the
customer saw is sent back and the server pays that or more, never less.

**UI** inside the ticket, priced on demand. **Audit rows on the same transaction
as the ledger entries.**

### Stage 5d — date of birth

`VERIFIED_BY_INTEGRATION_TEST`, `date-of-birth.acceptance.spec.ts`, 12 tests.

Accounts created before the column was collected have `date_of_birth IS NULL`,
and the `users_minimum_age` trigger only fires when it is NOT NULL — so those
accounts sat outside the age control entirely. Not underage; unverified, which
is the same thing to a regulator asking how you know.

| Piece | What it does |
|---|---|
| `date-of-birth.service.ts` | `isMissing`, and a write-once `complete` that validates through `assertOldEnough`, locks the row so two submissions cannot both write, and appends an audit row **recording that a date was supplied, not what it was** |
| `POST /api/account/date-of-birth` | Write-once; no PUT. Underage is **403, not 422** — the request was understood and the holder is not permitted, and calling it a validation error would have the UI say "check the date" to someone who typed it correctly. The date is not echoed back |
| `/account/date-of-birth` | A real page, not a modal, so it can be linked, bookmarked by support, and read without a focus trap |
| Banner in the shell | Every authenticated page, not dismissible, and it names what is blocked rather than only what is needed |
| Placement + withdrawal | Refuse inside their own transactions, so enforcement does not depend on the customer having seen the banner |
| Admin compliance page | Corrected — it said these accounts were "**not blocked**", which is no longer true |

**No date is ever invented.** A fabricated date of birth is worse than a missing
one: it turns "we do not know" into a false record that looks like diligence.

**The column stays nullable.** `SET NOT NULL` fails while any row is empty, and
the only way to force it through is to write a date nobody gave us. The
procedure for tightening it — including that accounts which never return are a
compliance decision, not a code change — is at the bottom of the service file.

### Two further defects found while testing stage 5d

1. `FAILED` → fixed. **The age gate meant different things in two places.**
   `enforce_minimum_age` compared against `CURRENT_DATE` — today in the *database
   server's* timezone — while `assertOldEnough` computes in UTC. Wherever the
   database is not UTC they disagree for part of every day, and a person exactly
   eighteen falls in the gap: the service accepts, the trigger raises, the
   customer gets a 500. Found by a test on a PDT machine. Production Neon runs
   UTC so it has almost certainly never fired for a real customer, but an age
   control whose answer depends on where the database is deployed is not one
   anybody can attest to. `0028_age_gate_utc.sql` makes the trigger use
   `(now() AT TIME ZONE 'UTC')::date`.
2. `FAILED` → fixed. **Every betting test fixture was a legacy account.**
   `createFundedUser` never set a date of birth, so all of them sat in the
   pre-collection state. It went unnoticed until the new gate started refusing
   them. A test whose subject is accidentally in an edge state proves something
   other than what it claims; the fixture now sets one, and the date-of-birth
   tests clear it explicitly when that is the state under test.

### One existing test was objectively wrong and was replaced

`cashout.acceptance.spec.ts` asserted a second cash-out **throws**. That returned
an error to a customer who had already been paid. The property it protected —
paid exactly once — is kept and strengthened by also requiring the original
figure back. The reason is recorded inline.

### Lint reached zero warnings

Sixteen of seventeen were dead imports. The seventeenth was not:
`ASSUMED_FINISHED_AFTER_MS` documented the assumed-finish policy while the query
restated it as a literal `interval '3 hours'`, so the two could drift apart. The
query uses the constant now.

### Stage 5e — the live-version cache

`VERIFIED_BY_INTEGRATION_TEST`, `live-version-cache.acceptance.spec.ts`, 8 tests
against real Postgres and real Redis.

`/api/live` computed the version digest on **every** poll so an unchanged board
could answer 304 without building a snapshot. Right shape, wrong cost: the digest
is a three-table aggregate and the board polls every five seconds per viewer, so
a hundred people watching one match meant twenty aggregates a second to answer
"nothing has changed" a hundred times.

**Why this is safe to cache.** The digest is a change detector, not a price and
not an authorisation. Nothing prices a bet from it — placement re-reads every
selection under a row lock and compares against the odds the customer was shown.
That separation is what makes caching defensible, and the module says so: if
anything ever prices from this value, delete the cache rather than reason about
it.

**Two layers, in this order:**

1. A **2-second TTL**, shorter than the 5-second poll. This is the correctness
   bound and it holds whether or not any invalidation fires — including for a
   write path nobody remembered to hook up.
2. **Explicit invalidation** after repricing and after suspending an event's
   markets. This is a latency improvement on top, not the guarantee.

Putting the TTL first is the point: an invalidation-only cache is correct exactly
until someone adds a write path and forgets, and the symptom is stale odds.

**Redis down is not an outage.** Every path falls back to the direct query and
answers correctly, just more expensively. A suspension — the safety control —
is never rolled back because a cache key could not be deleted, and that is
asserted. Failures are logged once per process rather than once per poll, so an
outage does not bury its own cause.

Tested: cached value equals the uncached query; a warm key never touches the
database; **staleness is bounded by the TTL with no invalidation at all**; a
suspension drops the key immediately; twenty concurrent readers agree on one
digest; Redis failure degrades to the query; a malformed cached value is ignored
rather than handed to a client as an ETag it could never match.

### Stage 5f — the withdrawal bank list

`VERIFIED_BY_INTEGRATION_TEST` for the caching, validation and failure
behaviour (12 tests). Real provider communication is **`BLOCKED_BY_KEY`** and
nothing here claims otherwise.

The withdrawal form asked the customer to type a NIP bank code from memory. A
wrong code does not bounce — it sends real money to a real account at a different
institution, and the first anyone hears of it is a support ticket about a
missing withdrawal.

| Piece | What it does |
|---|---|
| `PaymentProvider.listBanks()` | New on the interface, so no part of the codebase holds a bank list of its own |
| Paystack adapter | Follows `next_page` rather than taking the first 100 and calling it the list — a truncated list is a customer whose bank is missing, with nothing in the logs to say why. Bounded at 30 pages so a provider bug cannot loop |
| Sandbox adapter | Two banks named **"NOT REAL"** with codes that collide with nothing. A development adapter returning plausible NIP codes is the exact failure the interface exists to prevent |
| `BankListService` | 12-hour freshness, 7-day stale window, serves the cached list when the provider is down and **says it is stale** |
| `GET /api/payments/banks` | Authenticated on the `wallet` budget. The list is not secret, but it costs a provider call and does not belong on an open path |
| `POST /api/withdrawals` | Validates the submitted code against the list **before taking a hold** — a form is a suggestion; the request is what arrives |
| The form | A real picker, with loading, stale and failed states. When the list cannot be fetched it falls back to a typed code and explains why, rather than showing an empty select |

**Two deliberate directions, both recorded because they look like bugs.** An
empty provider response is treated as a failure rather than as "no banks", so a
provider having a bad minute cannot empty a good list and leave every customer
unable to withdraw. And `isPayableBankCode` **passes** when no list can be
established: refusing every withdrawal because a bank list could not be fetched
would turn a provider outage into an inability to take money out. The transfer
re-validates, and the provider refuses an unknown code.

### Stage 5g — edit bet is BLOCKED_BY_PRODUCT_DECISION

Searched the whole repository. **Every reference is a backlog entry saying it is
not implemented** — `docs/who-does-what.md` D6, `NEXT_WORK_REPORT.md`, three
files under `docs/history/`, and §12 here. There is no specification anywhere.

The repository does not define **eligibility** (which bets, how long after
placement, before or after kick-off), **fees**, **odds-change consent** (a
rebooked bet is priced again — does the customer agree, and to what), or the
**treatment of promotional stakes** (a bonus-funded bet edited into a different
one is a wagering-requirement question, not a betting one).

Building a cancel/rebook without those means inventing the financial rules of a
money feature, which the owner's instruction explicitly forbids. It is recorded
as blocked, with the exact decisions needed, rather than shipped to look
complete.

### Stage 5h — the legacy style bridge is gone

`src/styles/legacy-bridge.css` is **deleted**. It re-pointed the old dark
system's variables at the new tokens so pages still carrying legacy classes
rendered in the new palette during the migration. Seven files still depended on
it — `kyc-form`, `responsible/controls`, `account/preferences`,
`account/security`, `account/verify-email`, `pluto-chat` and one stray class in
`results` — and all seven are converted.

The structural part was `.field`, whose label text was a bare child and now
carries the `sb-field__label` span the new form language expects. Two
components were also reusing the **odds tile** for cool-off and self-exclusion
choosers; they use the board's chip now, because an odds tile carries betting
meaning and a self-exclusion button is not a bet.

The legacy rules further down `globals.css` stay: they serve the **admin
console**, which renders outside the `.sb` shell and keeps the dark system on
purpose. Re-skinning the screens that approve withdrawals is not a side effect
to accept from a customer-facing pass.

`stylesheet-imports.acceptance.spec.ts` was updated so it no longer requires the
deleted file.

### Stage 3 — Playwright, and two defects it found immediately

`playwright.config.ts` plus `e2e/`. The config deliberately does **not** start
the server: doing so would make it easy to run the suite against whatever
`.env` holds, and `.env` holds production credentials. A base URL that has to be
supplied is one somebody thought about. Two projects — desktop 1440×900 and a
real **Pixel 7** device profile, because desktop Chrome narrowed to 390px is not
a phone and the difference is where mobile-only defects hide.

Every page test asserts: status under 400, **no console error, no uncaught
exception, no failed request**, no horizontal overflow (measured, and the
failure names the widest element), and that the sportsbook stylesheet actually
reached the browser — the check that would have caught the `@import` ordering
defect where every other gate passed.

First run: **28 passed, 12 failed**, and both causes were real.

1. `FAILED` → fixed. **The password field's accessible name was wrong.** The
   "Forgot password?" link sat *inside* the `<label>`, so the field was
   announced as "Password Forgot password?, edit text" — and a link nested in a
   label has ambiguous click behaviour, since the browser may focus the input
   instead of following it. Found because a browser could not locate a field
   labelled exactly "Password". The link is now a sibling.
2. `FAILED` → fixed. **There was no 404 page.** Next.js served its built-in
   one: black text on white, no branding, and no way out. A customer who
   mistypes a URL or follows a stale link got something that does not look like
   this product and offers them nothing. `src/app/not-found.tsx` is branded and
   carries three routes back. It sits at the app root deliberately, so it renders
   without a session — a 404 that reads the database turns an unreachable
   database into a 500 on every wrong URL.

### Stage 3 finished — and the page container had been deleted with the bridge

The desktop and Pixel 7 projects both pass: **118 passed, 6 skipped** (the six
skips are the column check below, which is meaningless on a phone). Two defects
beyond the ones already recorded:

3. `FAILED` → fixed. **The mobile header overflowed.** The signed-in header
   measured 446px inside a 412px viewport, so every authenticated page scrolled
   sideways on a phone. Below 900px the deposit label is hidden (the icon keeps
   its `aria-label`) and the account icon is dropped, because the bottom bar
   already carries it.
4. `FAILED` → fixed. **Competition favouriting was unreachable.** With eight or
   fewer leagues the "Popular" group is hidden, and the country groups had no
   star — so on a normal seeded database there was no way to favourite anything.
   Country rows use `leagueRow` now.

And one the browser suite did **not** catch, which matters more than the two it
did:

5. `FAILED` → fixed. **Deleting `legacy-bridge.css` deleted `.sb-page`.** The
   page container — the measured 1040px column every non-board page sits in —
   was defined in the bridge file, and stage 5h removed the file. Headings went
   hard against the left edge and tables spanned the full 1440px.

   **Every gate passed.** Typecheck, lint, `next build`, 913 unit tests, and the
   40-per-project browser suite. The browser suite measures horizontal
   *overflow*, and a full-bleed page does not overflow. It was found by looking
   at a screenshot, which is not a control.

   The rules now live in `surfaces.css`, and `e2e/pages.spec.ts` asserts the
   container directly: `.sb-page` must have a real `max-width` and must measure
   narrower than the viewport at 1440px. **That test was proved to fail**: the
   rules were removed, the app rebuilt, and all six checks failed before the
   rules were restored and they passed again. A regression test that has never
   failed is not evidence.

### Stage 4 — the interaction audit, generated rather than written

`artifacts/ui-review/INTERACTION_AUDIT.md`: **32 rows**, 16 controls in each of
two projects, every one clicked or submitted in a real browser against a
disposable local database. `artifacts/ui-review/00-contact-sheet.png`: **28
labelled thumbnails**, desktop and 390px mobile, visually inspected.

Both are produced by `scripts/build-ui-review.mjs` from what the run actually
did. Nothing in that table is written from reading the source — if a control is
missing from it, it was not tested.

Three defects in the reporting machinery itself, all of which made the evidence
quietly wrong rather than absent:

- `beforeAll` truncated a single shared audit file **once per project**, so only
  the last browser's rows survived. Per-project files, merged afterwards.
- `capture-ui-screenshots.mjs` deleted the whole output directory, taking the
  audit rows written moments earlier. It removes only PNGs now.
- The merge glued the project into the page cell, leaving every row one column
  short of its header — which Markdown renders as a quietly shifted table, not
  an error.

### The review server no longer inherits production secrets

`scripts/review-server.mjs`. `next start` loads `.env`, and in this repository
`.env` holds **production** credentials. The review server was started by
exporting a local `DATABASE_URL` in front of the command, which works and is one
forgotten export away from pointing a browser — and the destructive interaction
tests — at the real database. The app comes up perfectly either way.

The script sets every connection string explicitly, **refuses to start** if any
of them names a host that is not loopback, and generates review-only
`AUTH_SECRET` and `IDENTITY_PEPPER` values into a gitignored file. Previously
the review process inherited the production pair from `.env`: local browser
sessions were signed with the production secret and local identity numbers
hashed into the production keyspace. Neither is needed to photograph a screen.

`playwright.config.ts` still does not spawn it. Pointing the suite at a base URL
stays a deliberate act.

### Stage 5i — the adversarial corpus, and what it found

`src/modules/ai/__tests__/injection-corpus.ts` holds **53 attacks** across the
sixteen categories the owner named, entering by four vectors: a user message, a
tool argument, a tool **name**, and retrieved text. It is data, separate from
the tests that run it, so that adding an attack does not mean writing a test and
so the same corpus can be replayed against a live model when a key exists.

`prompt-injection.acceptance.spec.ts` runs it against the real layer —
`authoriseToolCall`, `findTool`, `runTool`, `vetAnswer`, `RulesBasedProvider`,
nothing mocked. **59 tests, all passing.**

**What this does and does not establish.** The threat model is the pessimistic
one: assume the model is fully compromised and the attacker wrote its output.
Every assertion is about what happens when a hostile tool call *arrives*. That
covers the layer, which is the part that has to hold. It says nothing about how
a live model would answer these prompts — no key is configured, so that remains
`BLOCKED_BY_KEY` and the corpus header says so at the top, because this is
exactly the result somebody would otherwise quote as "Pluto resists prompt
injection".

Three defects, all found by the corpus rather than by reading the code:

23. `FAILED` → fixed. **`setDepositLimit` required no confirmation.** It sits at
    `ACCOUNT` level, and the four levels are about money — so a tool that
    changes a *protection* was, by level alone, callable on the strength of a
    sentence in a chat. Under the stated threat model that is precisely the
    failure rule 16 exists to prevent. A new `alwaysConfirm` flag carries it,
    rather than promoting the tool to `FINANCIAL`, which would put a misleading
    word in front of the customer. The existing test that checks money tools
    need confirmation matched on `/^(place|prepare|cashout|deposit|withdraw)/`
    and `setDepositLimit` begins with "set", so it was never covered.

24. `FAILED` → fixed. **Two registered tools had no handler.**
    `setOddsFormat` and `setDepositLimit` were both advertised to the model by
    `toolsFor`, and both fell through to a `default` branch whose comment
    claimed it was unreachable. A customer asking for either was told it "is not
    implemented" by an assistant that had just offered it. Both are wired now,
    to services that already existed — and the deposit-limit handler calls
    `responsibleService.setLimit` rather than restating its policy, so the rule
    that a *decrease* applies at once and an *increase* waits 24 hours has one
    home and cannot drift. A new test calls every registered tool and fails if
    any reports itself unimplemented, so a tool added tomorrow is covered.

25. `FAILED` → fixed. **`getHeadToHead` crashed on a malformed id.** The
    argument went straight into a `::uuid` cast, so an empty or malformed value
    returned a raw `PostgresError` — a 500 from the chat route, and a disclosure
    of the column type. Tool arguments are chosen by the model, which makes them
    untrusted input in exactly the way a query string is. Guarded, with the
    malformed cases tested explicitly.

One of my own assertions was wrong and is recorded rather than quietly changed:
the fabricated-odds test required `ok: false` for an unknown fixture. `ok`
reports whether the tool *ran*, not whether it found something, and conflating
those would make a normal answer look like a fault. The assertion now checks
what the attack is actually about — that no price is returned and the answer
says it cannot find the fixture.

### Stage 5j — personalisation and Admin AI are blocked, and by what

Searched the repository. **There is no specification for either.** The only
reference is one backlog line, `docs/who-does-what.md` D9, saying both are
greenfield. Every historical report agrees and puts the source-match count at
zero: `PROJECT_STATUS.md`, `PLUTOBET_STATUS.md` C6/C7, `GPT.md`. "Phase 19" and
"Phase 23" are named; the phase document itself is not in the repository.

**Personalisation is `BLOCKED_BY_PRODUCT_DECISION`** — and specifically *not*
`BLOCKED_BY_KEY`. It needs no model. The data exists and the arithmetic is
ordinary. What does not exist is the part that matters on a gambling product:
**what is recommended, to whom, and when it is withheld.** Undecided, and not a
developer's to decide:

- What is surfaced — a fixture, a market, a stake size? A recommended *stake* is
  a different product, and a different regulatory object, from a recommended
  fixture.
- On what signal. Betting history is the obvious one and it is also the signal
  that most reliably identifies somebody losing.
- **When it is suppressed.** For a customer under a deposit limit, in cool-off,
  showing loss-chasing behaviour, or flagged by the risk console. A recommender
  with no suppression rule is a system that pushes hardest at the customer it
  should be pushing at least.
- Whether it is **marketing**. `user_preferences.marketing_emails` already
  records a consent this product would have to respect, and Nigerian rules on
  gambling advertising bear on the answer.

Building it without those means writing the responsible-gambling policy of a
money feature into a recommender, which the owner's instruction forbids. Recorded
as blocked with the decisions named, rather than shipped to look complete.

The parts of personalisation that are *not* promotional already work: the "Your
competitions" rail (favourites, whose reachability was fixed in stage 3) and the
stored display preferences.

**Admin AI is `BLOCKED_BY_KEY` and `BLOCKED_BY_PRODUCT_DECISION`, both.** No
model is connected. Separately, nobody has decided which admin actions an
assistant may take — the admin console approves withdrawals, adjusts exposure
and settles bets, and an assistant over those needs its own tool registry and
permission model before a line of it is worth writing.

### Stage 5k — the unavailable pages were honest, and one reason was not

Fantasy, Lucky Numbers and Live Casino all render `ComingSoon`: the product
name, what it is, a plain "Not available yet", and two routes to something that
works. No fake tiles, no dummy fixtures, no dead buttons. That is the outcome
the owner asked for and it was already in place.

One defect. `FAILED` → fixed. **The placeholder told every visitor the same
reason** — "It needs a provider we have not connected." That is true of a
streamed casino and true of a licensed draw. It is **false of Fantasy**, which
needs building; it is our own work, not a provider's. A page that reads as
honest while giving a reason that is not the real one is a fabricated blocker,
and that is the same defect as a fabricated feature — it just flatters us
instead of the product.

Each planned product now carries its own reason in the navigation registry, and
`navigation.acceptance.spec.ts` asserts that every `PLANNED` item has one and
that no `LIVE` item does — so adding a planned product forces somebody to say
why it is unavailable. Verified in the browser: all three pages served their own
sentence.

### Stage 6 — load and reliability, measured

`scripts/bench-http.mjs`, against the review server on a disposable local
database. Report at `artifacts/load/HTTP_LOAD.md`. It covers the paths D8 lists
as untested — the board, the live-feed poll at scale, and Pluto concurrency.

**Zero failures and zero 5xx across every scenario.** 300 requests each at
concurrency 25, plus a 30-request single-customer baseline.

| Scenario | alone p50 | loaded p50 | p95 | p99 | txn/req |
|---|---|---|---|---|---|
| Board `GET /` | 23ms | 528ms | 886ms | 1350ms | 2.0 |
| Market list `GET /sports` | 16ms | 453ms | 603ms | 719ms | 2.1 |
| Live poll `GET /api/live` | 6ms | 97ms | 121ms | 132ms | **0.8** |
| Odds `GET /api/odds` | 6ms | 125ms | 172ms | 183ms | 1.9 |
| Pluto `POST /api/ai` | 6ms | 53ms | 82ms | 102ms | 1.6 |

**Read the last column, not the first.** Latency here is one laptop running
Postgres, Next and the harness at once; it describes the weather. Transactions
per request is machine-independent, and it is what moves when somebody adds a
query inside a loop.

The board at 23ms alone and 528ms at concurrency 25 is **queueing on a single
Node process**, not an expensive page — which is why the baseline column exists.
Without it the obvious next move would have been to optimise a page that renders
in 23 milliseconds.

`GET /api/live` at **0.8 transactions per request** is the stage 5e cache
working: fewer than one database transaction per poll means most polls are
served from Redis inside the 2-second TTL. That is the first measurement of it;
5e was `VERIFIED_BY_INTEGRATION_TEST` and this is the load evidence.

**The rate limiter is measured, not assumed.** Each simulated customer sends its
own `x-forwarded-for` — the key the limiter uses, and what a crowd behind a proxy
looks like — so the control runs on every request rather than being disabled to
get a number. Then one client fires 200 requests at a 120-per-minute budget:
**120 answered, 80 refused with 429, 0 failures.** A limiter that sheds load by
refusing is working; one that sheds it by falling over is not.

**Not measured, and why.** Casino callbacks: there is no callback route in the
repository to load. The casino is a sandbox adapter with no aggregator
connected, so there is nothing to measure and a figure would be an invention.
Bet placement under contention already has correctness tests under concurrency.
And the Pluto figure is the route, guardrails and dispatch — **not** model
latency, which does not exist yet and will dominate the moment it does.

### Stage 7 — one customer, all the way through

`customer-journey.acceptance.spec.ts`. Registration, funding, a bet, a win, a
replayed result, a loss, a void, a corrected result, a cash-out and two refusals — **14 steps, one
account, one run**, on a clean disposable database. All pass.

Seventy-five test files already covered these modules in isolation and covered
them well. What none of them could see is the **seam**: an account that
registers and then cannot bet, a deposit that credits a bucket placement will
not spend from, exposure claimed by one module and released by another. Each of
those is a passing-test, broken-product failure living between two files that
each pass. So the assertions are about **continuity** — the balance after step
six is the balance step five left behind — and nothing is re-seeded between
steps.

Money moves only by the ordinary routes: the real registration handler with a
real one-time code, `applyDepositWebhook` (what the payment webhook calls), the
placement HTTP route, `ingestResult` and `settleBet`, and the cash-out route.
**No balance, ledger row, bet status or exposure value is written by the test.**
The session is the only substitution, because a test cannot hold a cookie.

Two defects, and one of them was mine:

29. `FAILED` → fixed. **A refused bet did not say why.** The slip service works
    out the exact reason a combination failed — no funds, price moved, market
    full — collects them, and the route **dropped them**. A customer with an
    empty wallet was told "none of the combinations on this slip could be
    placed": true, useless, and indistinguishable from a suspended market. On a
    single bet, which is most of them, there is exactly one reason and it was
    already known.

    The reasons now travel with the response, through a new `details` field on
    `ApiError`. They are a **hand-written mapping**, never `error.message` —
    the domain messages are written for a log and three of them leak:
    `InsufficientFundsError` carries a wallet UUID, `AccountNotEligibleError` a
    user UUID, and `ExposureLimitError` states how much more liability a market
    will absorb, which tells a bettor exactly how much the book will take
    before it stops. Anything unrecognised collapses to one generic line,
    because an unexpected error is precisely the one whose message was never
    written with a customer in mind. The journey asserts the reason arrives
    **and** that no UUID comes with it.

30. **My own helper made the mistake `AGENTS.md` exists to prevent.** The first
    version of `cashMinor` was `WHERE user_id = ? AND kind = 'CASH' AND
    currency = 'NGN'` — wrong twice: `kind` is USER or SYSTEM, and CASH is a
    **bucket**. It is exactly the bucket-blind predicate that matches three rows
    and takes whichever the planner returns first. It failed loudly only because
    I also guessed the column name wrong; had `cached_balance_minor` been right,
    the query would have run, returned a plausible number, and the journey would
    have asserted against the wrong wallet all the way through. It now calls
    `balancesForUser`, so the test and the product read a balance the same way.

One assertion was also tightened after it passed. Step 10 began as `if
(!quote.available) return`, which would have gone on passing if cash-out stopped
pricing anything at all. A PENDING bet placed moments ago on an OPEN market for
an ACTIVE account **must** be priceable; it is asserted, not tolerated.

### Stage 8 — security re-verified against what this pass changed

`docs/security-review.md` 24.1 is re-checked rather than assumed still true.
Four things this pass introduced needed review, and all four are recorded there
as deliberate decisions with a re-review trigger:

- **`ApiError.details`**, new, so a refused bet can say why. It is a curated
  field, not a passthrough — one call site, hand-written pairs, and the check
  that no domain message reaches it. **Verified**: 17 `new ApiError(...)` call
  sites in the repository, exactly **one** passes `details`, and it passes
  `SlipError.failures`, which is built by `customerReason` and contains no
  identifier. The journey test asserts no UUID appears in that response.
- **`alwaysConfirm`** on responsible-gambling tools, and why it is not a
  promotion to `FINANCIAL`.
- **The review server's generated secrets**, replacing the production
  `AUTH_SECRET` and `IDENTITY_PEPPER` it used to inherit from `.env`.
  **Verified**: `.env.review.local` is untracked and `secret-scan` is clean
  across 447 files.
- **The AI tool registry**, now with a 53-attack corpus behind it.

Also re-checked and unchanged: every new route added this pass —
`/api/payments/banks`, `/api/account/date-of-birth`, `/api/bets/[id]/cashout` —
uses `authedRoute`, and no `dangerouslySetInnerHTML` exists anywhere in the
application.

**What was not re-done.** The areas this pass did not touch — argon2id, session
revocation, RBAC separation of duties, webhook HMAC, the money-path locks — are
unchanged and their existing evidence stands. Re-running a review of code that
did not change would produce a fresher date and no new information, and a date
is not evidence.

### Exact next action


**Stage 9 — the complete gate set from a clean state, run twice.**

Every gate, in order, from a clean checkout: typecheck, lint, build, the full
vitest suite, the browser suite, migrations against a fresh database, the secret
scan, and the readiness scripts. Twice, because a suite that passes once may be
passing on state the first run left behind.

Then 10 (the truthful rewrite and dated changelog) and 11 (merge and push —
only if every gate passes).

Still outstanding from stage 3, and not to be lost: the remaining viewports —
430×932, 768×1024, 1024×768, 1366×768, 1920×1080 — plus the accessibility pass
(0 critical/serious violations) and keyboard navigation.

Then, still outstanding for stage 3: the remaining viewports the owner named —
430×932, 768×1024, 1024×768, 1366×768, 1920×1080 — as a responsive sweep, plus
the accessibility pass (0 critical/serious violations) and keyboard navigation.
Recorded here because stage 3 is marked DONE for the two profiles actually run,
and that distinction must not be lost.

### Files being modified right now


Eleven entries, all stage 3/4 work, committed together with this checkpoint:

| File | Why |
|---|---|
| `src/styles/surfaces.css` | the restored `.sb-page` container |
| `e2e/pages.spec.ts` | the measured-column regression test |
| `e2e/interactions.spec.ts` | per-project audit files (new) |
| `scripts/build-ui-review.mjs` | merges the audit, builds the contact sheet (new) |
| `scripts/review-server.mjs` | the guarded review server (new) |
| `scripts/capture-ui-screenshots.mjs` | stop deleting the audit |
| `src/components/sportsbook/header.tsx` | mobile overflow |
| `src/styles/sportsbook.css` | mobile overflow |
| `src/components/sportsbook/league-rail.tsx` | reachable favouriting |
| `.gitignore` | admit the two review deliverables, exclude `.env.review.local` |
| `artifacts/ui-review/` | the two deliverables themselves |

### Decisions and assumptions made


- Commit counts, branch state and remote heads are read from git on every
  checkpoint rather than carried forward in prose.
- The standing reporting instruction lives in `AGENTS.md` **outside** the
  BEGIN/END markers `next dev` regenerates.
- Exposure is made exact with a recorded `released_liability_minor` rather than
  by releasing a proportion of the remaining stake at settlement. The
  proportional approach truncates at every step and leaves a residue permanently
  claimed; recording what was released is exact and auditable.
- A full cash-out sets `cashed_out_stake_minor = stake_minor`, so one
  database-checked invariant covers both routes into `CASHED_OUT`. Verified not
  to affect `product-reconciliation.service.ts`.
- Cash-out is refused for every non-`ACTIVE` status including `SELF_EXCLUDED`,
  per the owner's explicit instruction. It **differs from withdrawal**, which
  permits a self-excluded customer so as not to trap their money. Deliberate:
  cash-out is a wagering decision and nothing is trapped, because the bet still
  settles and still pays.
- The cash-out money key is derived from the bet, not supplied by the client. A
  client key protects only against that client's retries.
- A quote is ownership-checked: what a bet is worth also reveals that it exists.
- Date of birth is **write-once** through the customer-facing path. The age gate
  rests on it, and an editable value would turn a refused registration into an
  accepted one on the second attempt. Correcting a genuine mistake is an admin
  action with a reason attached — not built here, and not needed until someone
  asks for it.
- Deposits are **not** blocked for a missing date of birth, and this is
  deliberate. The deposit rail is a dedicated NUBAN: money arrives by bank
  transfer with no application action to refuse. Blocking the webhook would
  strand a customer's money, which is worse than the gap it closes. Betting and
  withdrawal — both of which the application does control — are blocked.
- Playwright is a dev dependency: the browser, interaction and accessibility
  audits need a real driver, and the previous pass proved a one-shot headless
  capture reports a viewport it did not use.
- Two review artefacts are **committed** — the contact sheet and the interaction
  audit — and the 27 full-page screenshots behind them are not. The two are the
  evidence that the interface was checked in a browser; the rest is ~4MB that
  `scripts/capture-ui-screenshots.mjs` regenerates. `artifacts/` is excluded as
  `artifacts/*` rather than `artifacts/`, because a trailing slash makes git skip
  the directory and no negation can re-include what git never descended into.
- The review server refuses to start against a non-loopback host rather than
  documenting that it should only be pointed at one. The failure being prevented
  is silent — the application comes up perfectly against production — so a
  convention would not have caught it.

### Latest gate results


| Gate | Result | When |
|---|---|---|
All of these were run at this checkpoint, in this order, against the restored
build. Every one is a full run, not a subset.

| Gate | Result | When |
|---|---|---|
| `npx tsc --noEmit` | **exit 0**, 0 errors | this checkpoint |
| `npx eslint .` | **exit 0**, 0 errors, 0 warnings | this checkpoint |
| `npx next build` | **Compiled successfully** | this checkpoint |
| `npx vitest run` | **75 files, 975 passed, 1 skipped, 0 failed**, exit 0 | this checkpoint |
| `npx playwright test` | **118 passed, 6 skipped, 0 failed** (desktop + Pixel 7) | this checkpoint |
| `node scripts/check-migrations.mjs` | **29 of 29** apply to a clean database, exit 0 | this checkpoint |
| `node scripts/secret-scan.mjs` | **clean**, 447 files, 15 rules | this checkpoint |

The six Playwright skips are the measured-column check, which `test.skip`s on
the mobile project because a phone viewport is narrower than the column. They
are skips by design, not failures being hidden.

The full suite is re-run from a clean state in stage 9, twice, as instructed.

The full suite is re-run from a clean state in stage 9; totals will rise because
this pass adds tests, and any figure that changes is corrected here.

### Known failures and blockers


| # | Finding | Status |
|---|---|---|
| 1 | Partial cash-out refused by a constraint on every call, untested | **FIXED**, 5a |
| 2 | Partial cash-out's exposure slice released twice | **FIXED**, 5a |
| 3 | `CashOutService` did not check account status | **FIXED**, 5b |
| 4 | A retried cash-out returned an error for money already paid | **FIXED**, 5b |
| 5 | `ASSUMED_FINISHED_AFTER_MS` duplicated a policy the SQL restated as a literal | **FIXED** |
| 6 | Cash-out had no API route and no UI | **FIXED**, 5c |
| 7 | Accounts with no date of birth were outside the age control entirely | **FIXED**, 5d |
| 8 | The age gate used the database's local date, the service used UTC | **FIXED**, `0028` |
| 9 | Every betting fixture was accidentally a legacy account | **FIXED** |
| 10 | The admin compliance page said missing-DOB accounts were "not blocked" | **FIXED** — they are |

| 11 | `/api/live` recomputed a three-table aggregate on every poll | **FIXED**, 5e |

| 12 | The withdrawal form asked for a hand-typed NIP bank code | **FIXED**, 5f |

| 13 | The sign-in password field's accessible name included the "Forgot password?" link | **FIXED**, stage 3 |
| 14 | No `not-found.tsx` — Next served an unbranded 404 with no way out | **FIXED**, stage 3 |
| 15 | Edit bet has no product rules anywhere in the repository | **BLOCKED_BY_PRODUCT_DECISION** — not built, by instruction |
| 16 | The signed-in mobile header measured 446px in a 412px viewport | **FIXED**, stage 3 |
| 17 | Competition favouriting was unreachable with ≤8 leagues | **FIXED**, stage 3 |
| 18 | `.sb-page` was deleted with the style bridge; every non-board page went full-bleed | **FIXED**, stage 3 — and now has a regression test proved to fail without it |
| 19 | The audit file was truncated once per project, keeping only the last browser's rows | **FIXED**, stage 4 |
| 20 | The screenshot capture deleted the audit it was meant to sit beside | **FIXED**, stage 4 |
| 21 | The merged audit table was one column short of its header | **FIXED**, stage 4 |
| 22 | The review server inherited production `AUTH_SECRET` and `IDENTITY_PEPPER` from `.env` | **FIXED** — review-only values, and a loopback check that refuses to start otherwise |
| 23 | `setDepositLimit` changed a protection with no confirmation required | **FIXED**, 5i |
| 24 | `setOddsFormat` and `setDepositLimit` were advertised to the model with no handler | **FIXED**, 5i |
| 25 | `getHeadToHead` returned a raw `PostgresError` for a malformed id | **FIXED**, 5i |
| 26 | The unavailable-product page gave a blocking reason that was false for Fantasy | **FIXED**, 5k |
| 27 | Personalisation has no rules for what to recommend, or when to withhold it | **BLOCKED_BY_PRODUCT_DECISION** — not built, by instruction |
| 28 | Admin AI has no model and no decision on which admin actions it may take | **BLOCKED_BY_KEY** and **BLOCKED_BY_PRODUCT_DECISION** |
| 29 | A refused bet dropped the reason; the customer could not tell no-funds from a closed market | **FIXED**, 7 |
| 30 | My own journey helper used a bucket-blind `wallets` predicate | **FIXED** before it could mislead — recorded because it is the mistake the rules name |

Cash-out and the date-of-birth flow still are **not** `VERIFIED_IN_REAL_BROWSER`
as complete money journeys. The date-of-birth *control* is audited (row:
`/register`, date of birth); the cash-out journey needs a placed bet with a
priced offer and is covered by stage 7, not stage 4. Blockers inherited from the
previous pass are in §23.

### Deliberately not performed

| Not done | Why |
|---|---|
| Deleting the 400 synthetic production fixtures | Needs owner approval on a dry-run fingerprint |
| Applying the ₦630 exposure repair | Same |
| Any Railway deployment | Not authorised by this task |
| Any live provider activation | Not authorised, and no credentials exist |

---

## Contents

| § | Section |
|---|---|
| **0** | [**Resume Here**](#0--resume-here) — the recovery point |
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
| 15 | [Cash-out: repaired, reachable, and tested](#15-cash-out-repaired-reachable-and-tested) |
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

**This is the whole vocabulary.** Nothing outside this table appears as a status
anywhere in this document, and a label is never raised without the evidence its
name states.

| Label | Means |
|---|---|
| `VERIFIED_IN_REAL_BROWSER` | Clicked or submitted in a browser, and the result observed. The record is `artifacts/ui-review/INTERACTION_AUDIT.md`, generated by the run |
| `VERIFIED_END_TO_END` | A whole journey completed in one run, across module boundaries, with the money and the ledger agreeing at the end |
| `VERIFIED_AGAINST_REAL_PROVIDER_DATA` | Exercised against a real provider response, not a fixture |
| `VERIFIED_BY_INTEGRATION_TEST` | Driven by tests against a real database. **Not** the same as having watched it happen |
| `VERIFIED_BY_UNIT_TEST_ONLY` | Tested in isolation, with its collaborators substituted |
| `IMPLEMENTED_NOT_LIVE_TESTED` | Written and typechecked; never exercised against production-like conditions. Also covers logic that is finished but that nothing in the product calls, and code waiting on a real-world event nobody can hurry — both are stated in prose where they apply |
| `BLOCKED_BY_KEY` | Needs a paid or approved third-party credential |
| `BLOCKED_BY_CONTRACT` | Needs a commercial agreement with a provider |
| `BLOCKED_BY_OWNER_CONFIGURATION` | Needs an account or a console the developer does not have |
| `BLOCKED_BY_PRODUCT_DECISION` | The rules that would define it have not been decided, and are not a developer's to decide |
| `BLOCKED_BY_REGULATION` | Needs a licence or certification |
| `NOT_IMPLEMENTED` | Not built |
| `FAILED` | Found broken. Kept visible until fixed, with what it was |

### What changed here, and why it is a downgrade

Five labels used here are not in the vocabulary above and are gone. Written
without backticks so that a future search-and-replace over this file does not
rewrite the sentence explaining them, which is exactly what happened while this
paragraph was being written:

| Retired | Replaced by | Count |
|---|---|---|
| VERIFIED_FUNCTIONAL | `VERIFIED_IN_REAL_BROWSER` where the audit covers it, `IMPLEMENTED_NOT_LIVE_TESTED` otherwise | 57 |
| VERIFIED_WORKING | `VERIFIED_BY_INTEGRATION_TEST` | 44 |
| VERIFIED_AUTOMATED_BY_ACCEPTANCE_TEST | `VERIFIED_BY_INTEGRATION_TEST` | 4 |
| IMPLEMENTED_NOT_REACHABLE | `IMPLEMENTED_NOT_LIVE_TESTED`, with the unreachability said in prose | 4 |
| WAITING_ON_REAL_EVENT | `IMPLEMENTED_NOT_LIVE_TESTED`, with the awaited event said in prose | 1 |

**The important one was VERIFIED_FUNCTIONAL**, which §6 defined as "the control
reaches real behaviour — a route that exists, a request that is answered, or
state that persists." That is a claim from **reading the code**, and it was
applied to fifty-five customer-facing controls, where it reads exactly like a
claim that somebody used them. Seven of those controls now say
`VERIFIED_IN_REAL_BROWSER` because they appear in the generated interaction
audit. The other fifty say `IMPLEMENTED_NOT_LIVE_TESTED`.

VERIFIED_WORKING was defined as "exercised against a real database or real
provider data, with a test or a recorded observation behind it."
`VERIFIED_BY_INTEGRATION_TEST` is the conservative reading of that; a few rows
have stronger evidence and say so individually.

**Every one of these is a downgrade or a like-for-like rename.** Nothing was
raised.

**The platform as a whole is not finished.** The core sportsbook flow —
register, browse, price, place, settle, pay — works. That is one flow out of a
product that also promises casino, virtuals, in-play, fantasy and more.

---

## 3. Where the project stands, in one page

| Question | Answer |
|---|---|
| Can a test account complete a bet end to end? | **Yes.** `VERIFIED_END_TO_END` — one account, one run, 14 steps: register, fund, bet, win, loss, void, correction, cash-out, refusals, and the ledger still agreeing at the end (§0, stage 7) |
| Can a stranger's real money enter or leave? | **No.** No payment credentials exist |
| Does a winning bet get paid without a human? | **Yes** — proven once on a real fixture, §14 |
| Is the customer interface finished? | **Redesigned, and verified in a real browser** at two viewports — 118 Playwright tests, 32 audited interactions, 28 screenshots (§5, §6). Not merged, not deployed. Five viewports the owner named are still unmeasured, and there is no accessibility pass yet |
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
| Lint | `npm run lint` | **exit 0** — 0 errors, **0 warnings** |
| Tests | `npx vitest run` | **75 files, 975 passed, 1 skipped, 0 failed** |
| The 1 skip | — | the opt-in live provider contract (`ODDS_LIVE_CONTRACT`) — **not counted as passing** |
| Browser | `npx playwright test` | **118 passed, 6 skipped, 0 failed** — desktop 1440×900 and a Pixel 7 profile |
| The 6 skips | — | the measured-column check, which is meaningless on a viewport narrower than the column |
| Build | `npx next build` | **exit 0** |
| Secret scan | `node scripts/secret-scan.mjs` | clean — 447 files, 15 rules |
| Whitespace | `git diff --check` | clean |
| Migrations | `node scripts/check-migrations.mjs` | **29 of 29** applied to a clean database |
| Restore verifier | `npm run db:verify-restore` | 8 of 8 pass; ledger balanced, 0 negative wallets |
| Admin queries | `npm run admin:smoke` | clean |
| Sync benchmark | `npm run bench:sync` | completed at 200 and 775 events — §21 |
| Demo readiness | `npm run readiness:demo` | **exit 1**, correctly — §3 |
| Real-money readiness | `npm run readiness:real-money` | **exit 1**, correctly — §3 |
| Database roles | `npm run db:audit-roles` | **exit 1**, correctly — §20 |
| CI | GitHub Actions | green on both remotes for `main`. **This branch has not been pushed**, so no CI run exists for it |

Test count is **975**, from 844 at the start of this pass: +131 covering cash-out
exposure, eligibility and its HTTP surface, the date-of-birth gate, the
live-version cache, the withdrawal bank list, the browser suite's own fixtures,
and the adversarial corpus for Pluto. The 15 lint warnings the previous run recorded are gone — 14 were dead
imports and one duplicated a policy the SQL restated as a literal.

The browser row is new and is the only gate here that opens one. It is listed
because five defects in this pass were invisible to every other gate: an
accessible name, a missing 404, a mobile overflow, an unreachable control, and a
page container deleted along with the file that happened to define it.

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
| Tokens and surfaces | `src/styles/tokens.css`, `src/styles/sportsbook.css`, `src/styles/surfaces.css` |
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

### The legacy bridge is gone

`src/styles/legacy-bridge.css` is **deleted**. It re-pointed the old design
system's variables at the new tokens so pages still carrying legacy classes
rendered in the new palette during the migration, and it had a stated end date:
delete it when no page inside `.sb` uses a legacy class. Seven files still did —
`kyc-form`, `responsible/controls`, `account/preferences`, `account/security`,
`account/verify-email`, `pluto-chat`, and one stray class in `results` — and all
seven were converted before it went.

The legacy rules further down `globals.css` **stay**. They serve the admin
console, which renders outside the `.sb` shell and keeps the dark system on
purpose. Re-skinning the screens that approve withdrawals is not a side effect
to accept from a customer-facing pass.

One thing came out with it that should not have. `.sb-page`, the measured column
every non-board page sits in, was defined in the bridge file rather than
alongside the rest of the layout, and deleting the file made every one of those
pages full-bleed. No gate caught it. The rules live in `surfaces.css` now, and
`e2e/pages.spec.ts` asserts the container directly — see §0. Layout the whole
site depends on does not belong in a file whose stated purpose is to be
deleted.

---

## 6. Complete interaction inventory

Every visible control on a customer-facing page, what it does, and its status.

**Read the status column carefully.** `VERIFIED_IN_REAL_BROWSER` means the
control appears in `artifacts/ui-review/INTERACTION_AUDIT.md` — it was clicked
or submitted in a real browser during the run that generated that file.
`IMPLEMENTED_NOT_LIVE_TESTED` means it is wired to real behaviour in the code
and was **not** exercised in a browser.

The distinction is not pedantry. Every one of these rows previously said
`IMPLEMENTED_NOT_LIVE_TESTED`, which the document defined as "a route that exists" — a
claim from reading the source that reads like a claim from using the product.
For most of the rows below, the destination page *is* browser-verified by the
118-test Playwright suite even where the control itself was never clicked; that
is worth something, and it is not the same thing.

### Header and global chrome

| Control | Does | Status |
|---|---|---|
| Brand mark | Navigates to `/` | `VERIFIED_IN_REAL_BROWSER` |
| Sports / Live / Jackpot / Promotions | Navigate to those pages | `IMPLEMENTED_NOT_LIVE_TESTED` |
| More ▾ | Opens a menu built from the navigation registry; entries not yet built are labelled "Not yet". Closes on outside click and on Escape | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Pluto AI | Navigates to `/pluto` | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Search | Expands in place; submitting navigates to `/sports?q=…`, which filters the board by team or competition. An empty query is a no-op rather than a pointless navigation | `VERIFIED_IN_REAL_BROWSER` |
| Balance | Navigates to `/wallet`; shows the server-resolved balance, or `—` if it could not be read | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Deposit | Navigates to `/deposit` | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Account icon | Navigates to `/account` | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Sign in / Register | Navigate to `/signin`, `/register` | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Sports tabs (second row) | Navigate to `/sports?sport=…` | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Footer links | 13 links to real pages | `VERIFIED_IN_REAL_BROWSER` |

### League rail (desktop)

| Control | Does | Status |
|---|---|---|
| Competition search | Filters the rail as you type | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Today / Upcoming / Live now | Navigate with the matching query | `IMPLEMENTED_NOT_LIVE_TESTED` |
| League link | Filters the board to that competition | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Favourite star | Persists to `localStorage` and pins that competition to a "Your competitions" group at the top. Survives reload; syncs across tabs | `VERIFIED_IN_REAL_BROWSER` |
| Country group | Expands and collapses | `IMPLEMENTED_NOT_LIVE_TESTED` |

### Match board

| Control | Does | Status |
|---|---|---|
| League header | Collapses and expands that league | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Fixture star | Persists to `localStorage` and pins the match to a "Your matches" group at the top of the board | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Odds tile (1 / X / 2 / O2.5 / U2.5) | Adds or removes the selection from the betslip. Disabled when suspended, closed or unavailable, and renders `—` rather than inventing a price | `VERIFIED_IN_REAL_BROWSER` |
| Statistics icon | Opens `/sports/event/<providerEventId>` | `VERIFIED_IN_REAL_BROWSER` — the route was created in this pass |
| "+N" more markets | Same destination | `VERIFIED_IN_REAL_BROWSER` — same |
| Filter chips (All upcoming / Today / Live / Jackpot / Clear) | Real links with real query parameters, so a filter can be bookmarked and shared | `IMPLEMENTED_NOT_LIVE_TESTED` |

### Event page

| Control | Does | Status |
|---|---|---|
| Market header | Collapses and expands that market | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Every selection tile | Adds to the betslip at the stored price | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Back to competition | Returns to the filtered board | `IMPLEMENTED_NOT_LIVE_TESTED` |

### Betslip

| Control | Does | Status |
|---|---|---|
| Betslip / My Bets tabs | Switch panes | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Remove selection | Removes it | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Stake field | Parsed to integer kobo; rejects anything that is not a plain naira amount | `IMPLEMENTED_NOT_LIVE_TESTED` — 11 tests |
| Quick stakes (₦100/500/1,000/5,000) | Set the stake | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Place bet → Confirm | `POST /api/bets` with a fresh idempotency key; disabled while in flight; a success is only claimed for a response carrying a real bet id | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Clear all | Empties the slip | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Sign in to place bet | Shown instead of the submit when signed out | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Odds-moved warning | Compares the price now against the price when added | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Open My Bets / View in My Bets | Navigate to `/bets` | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Set a limit | Navigates to `/responsible` | `IMPLEMENTED_NOT_LIVE_TESTED` |

The slip persists in `sessionStorage` and is the single source of truth for
picks and stake — there is no second copy in component state to drift from it.

### Mobile bar and sheet (under 900px)

| Control | Does | Status |
|---|---|---|
| Home / Sports / Live / Account | Navigate | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Betslip | Opens the bottom sheet; badge shows the selection count; Escape and the scrim close it; the page behind does not scroll | `IMPLEMENTED_NOT_LIVE_TESTED` |

### Authentication

| Control | Does | Status |
|---|---|---|
| Sign-in form | `signIn("credentials", { redirect: false })`, then routes to a validated same-site callback | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Show / hide password | Toggles the field type | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Forgot password | Navigates to `/forgot-password` | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Register step 1 → Send code | `POST /api/auth/otp` | `BLOCKED_BY_KEY` — the request is real; **delivery** needs Termii |
| Register step 2 → Create account | `POST /api/auth/register`, then signs in through the ordinary credentials flow | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Change details | Returns to step 1 and clears the code | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Reset: send code | `POST /api/auth/password-reset` — always advances, so the page cannot be used to discover which addresses have accounts | `BLOCKED_BY_KEY` — delivery needs Resend |
| Reset: set new password | `PUT /api/auth/password-reset` | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Sign in with your new password | A link to `/signin`. **Fixed in this pass**: it used to call `signIn` with no password, which can only fail | `IMPLEMENTED_NOT_LIVE_TESTED` |

### Account, wallet and money

| Control | Does | Status |
|---|---|---|
| Wallet: Deposit / Withdraw / My bets | Navigate | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Deposit: account number panel | Displays the dedicated NUBAN. There is deliberately no amount field — the customer transfers what they like and the webhook attributes it | `BLOCKED_BY_KEY` — needs Paystack to issue the account |
| Withdraw form | `POST /api/withdrawals` with an idempotency key; refuses under the minimum, over the balance, over the daily cap | `BLOCKED_BY_KEY` for the payout leg |
| Verify identity | Navigates to `/kyc` | `IMPLEMENTED_NOT_LIVE_TESTED` (upload and review; no identity provider — §16) |
| Account: 9 manage tiles | Navigate to real pages | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Account: verify email | `POST /api/account/email-verify` | `BLOCKED_BY_KEY` — needs Resend |
| Security: change password | `POST /api/account/password` | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Security: sign out a device / all devices | `DELETE /api/account/sessions` — a revoked session is downgraded on its next request | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Preferences: odds format, notifications | `PUT /api/account/preferences` | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Safer gambling: set a limit | `POST /api/responsible` — lowering applies immediately, raising waits 24 hours | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Safer gambling: cool-off, self-exclude | Same route | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Referrals: copy link / share | Clipboard, and the Web Share sheet where the browser has one. **Added in this pass** — the link was previously printed as text for the customer to select by hand | `IMPLEMENTED_NOT_LIVE_TESTED` |
| Rewards: see promotions | Navigates | `IMPLEMENTED_NOT_LIVE_TESTED` |

### Controls that are deliberately inert, and say so

| Control | Why | Status |
|---|---|---|
| Live board prices | Shown for information. In-play placement needs a real in-play feed; a tappable price the server would refuse is worse than none | `BLOCKED_BY_CONTRACT` |
| Casino game cards | **No longer links.** They pointed at `/casino/play/<id>`, which does not exist; the only configured provider is the development sandbox, whose own launch URL returns an explainer rather than a game. The page now says the games cannot be opened | `BLOCKED_BY_CONTRACT` |
| Cash out | In-ticket control on `/bets`: prices on demand, sends the figure it showed, refuses a stale offer — §15 | `VERIFIED_BY_INTEGRATION_TEST` |
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
| Registration over HTTP, age gate, duplicate refusal | `VERIFIED_BY_INTEGRATION_TEST` |
| Password hashing (argon2id) | `VERIFIED_BY_INTEGRATION_TEST` |
| Sign-in through the credentials provider | `VERIFIED_BY_INTEGRATION_TEST` |
| Branded sign-in page | `VERIFIED_BY_INTEGRATION_TEST` — presentation only; `authOptions.pages.signIn` points at it, and `authorize()` is unchanged |
| Same-site redirect guard | `VERIFIED_BY_INTEGRATION_TEST` — 7 tests; rejects another origin, protocol-relative, backslash, non-rooted and control-character callbacks |
| Session revocation ("sign out my other device") | `VERIFIED_BY_INTEGRATION_TEST` |
| Re-read of role and status on every request | `VERIFIED_BY_INTEGRATION_TEST` — suspension takes effect on the next request, not at token expiry |
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
| Integer kobo (`BIGINT`) end to end, no float in any money path | `VERIFIED_BY_INTEGRATION_TEST` |
| Double-entry, append-only ledger; deferred triggers reject unbalanced, empty, malformed or cache-divergent commits | `VERIFIED_BY_INTEGRATION_TEST` |
| Three wallet rows per account (CASH / BONUS / LOCKED) as rows, not columns, so every trigger covers them unchanged | `VERIFIED_BY_INTEGRATION_TEST` |
| Row locks (`SELECT … FOR UPDATE`); transfers lock both wallets in UUID order | `VERIFIED_BY_INTEGRATION_TEST` — 100-way hammer |
| Idempotency with SHA-256 request fingerprints — a replayed key with different parameters raises a typed conflict | `VERIFIED_BY_INTEGRATION_TEST` |
| Bonus credit cannot be withdrawn — refused by a database trigger, not a service check | `VERIFIED_BY_INTEGRATION_TEST` |
| Corrections are compensating entries, never edits | `VERIFIED_BY_INTEGRATION_TEST` |
| Money formatting, including negatives | `VERIFIED_BY_INTEGRATION_TEST` — 24 tests |

**Any new query against `wallets` must name a bucket.** Six queries once
resolved "the user's wallet" by `(user_id, kind, currency)`, matched all three
rows and took whichever the planner returned first — the ledger stayed
balanced and the money landed where the customer could not spend it.

---

## 11. Deposits and withdrawals

| Item | Status |
|---|---|
| Paystack adapter, webhook signature validation (HMAC-SHA512 over the raw body, constant-time) | `VERIFIED_BY_INTEGRATION_TEST` on fixtures |
| Deposit idempotency | `VERIFIED_BY_INTEGRATION_TEST` |
| Withdrawal balance reservation, KYC caps, manual approval | `VERIFIED_BY_INTEGRATION_TEST` in tests |
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
| Odds ingestion and `1x2` | `VERIFIED_BY_INTEGRATION_TEST` — 333 open selections on upcoming fixtures |
| Provider response parsing | `VERIFIED_BY_INTEGRATION_TEST` — pinned against real captured payloads, plus an opt-in live check |
| Bet placement over HTTP | `VERIFIED_BY_INTEGRATION_TEST` — 15 tests including concurrent placement repeated 5× |
| Stake debited at placement, not at settlement | `VERIFIED_BY_INTEGRATION_TEST` |
| Odds locked at placement | `VERIFIED_BY_INTEGRATION_TEST` — settlement reads `bet_legs.locked_odds_decimal`, never the current price |
| Exposure claimed per market at placement | `VERIFIED_BY_INTEGRATION_TEST` |
| Idempotent replay releases exactly what that attempt claimed | `VERIFIED_BY_INTEGRATION_TEST` — see §22 for the rows the pre-fix behaviour left behind |
| Singles, accumulators, system bets, bankers, booking codes | `VERIFIED_BY_INTEGRATION_TEST` |
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
| Win / loss / void / partial settlement, idempotency | `VERIFIED_BY_INTEGRATION_TEST` |
| Automatic settlement scheduling | `VERIFIED_BY_INTEGRATION_TEST` — 9 tests through the registered function |
| Unattended result ingestion | `VERIFIED_BY_INTEGRATION_TEST` — observed, §14 |
| Unattended bet settlement | `VERIFIED_BY_INTEGRATION_TEST` — observed, §14 |
| Transactional outbox, dispatcher, recovery sweep | `VERIFIED_BY_INTEGRATION_TEST` — 19 acceptance tests |
| Per-stage heartbeats and stall alerts | `VERIFIED_BY_INTEGRATION_TEST` — recorded a real failure with its cause on the first live run |
| Result-poll fairness and backoff | `VERIFIED_BY_INTEGRATION_TEST` — money waiting sorts first; an unscorable event is deferred, never resolved |

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

## 15. Cash-out: repaired, reachable, and tested

Status: **`VERIFIED_BY_INTEGRATION_TEST`**, and one step of the end-to-end
journey (§0, stage 7) takes a cash-out through the real HTTP route.

### What this section used to say, and why it was wrong

It said cash-out was "well constructed" and deliberately unreachable pending one
known exposure defect. The first half was wrong. **Partial cash-out had never
worked at all.**

Migration `0007` added a CHECK constraint requiring `cashout_value_minor IS
NULL` unless the bet was `CASHED_OUT`. Migration `0016` then added partial
cash-out, which by definition leaves a bet `PENDING` *with* a value. Every
partial call therefore died on Postgres error 23514 — and nothing noticed,
because there was no route, no UI and no test that took a partial. A feature can
be described as well constructed for as long as nobody calls it.

That is recorded here rather than quietly corrected, because "it looks correct"
was written into a status document about money and stood.

### What is true now

| Invariant | State |
|---|---|
| Partial cash-out completes at all | **Holds.** Migration `0027` replaces the constraint |
| Full cash-out releases exposure exactly once | **Holds.** The bet becomes `CASHED_OUT` and never reaches settlement |
| Partial cash-out releases exposure exactly once | **Holds.** `released_liability_minor` records what was released; settlement releases only the remainder. Previously the partial released a slice and settlement released the whole claim again, over-releasing the market's liability — floored at zero by `GREATEST`, so it read as no exposure while other bets carried real risk |
| Settlement pays only the stake still at risk after a partial | **Holds** |
| The service refuses a suspended, self-excluded or closed account | **Holds.** `assertMayCashOut` gates on status before pricing |
| A retried take pays once | **Holds.** The money key is derived from the bet, not supplied by the client, and a replay returns the original figure |
| A quote discloses nothing to a stranger | **Holds.** Ownership is checked before pricing, because what a bet is worth also reveals that it exists |

**It is reachable.** `GET`/`POST /api/bets/[id]/cashout`, an in-ticket control
on `/bets` that prices on demand and sends the figure it showed, and admin
visibility. 35 tests across three files, plus the journey.

**A deliberate difference, recorded so it is not "fixed":** cash-out refuses a
`SELF_EXCLUDED` customer; withdrawal permits one. Cash-out is a wagering
decision and nothing is trapped — the bet still settles and still pays.
Withdrawal is how a self-excluded customer gets their money out, and refusing it
would trap them.

---

## 16. Responsible gambling, KYC and compliance

| Control | Status |
|---|---|
| Age gate — refused at registration and again by a database trigger | `VERIFIED_BY_INTEGRATION_TEST` |
| Date-of-birth backfill for accounts predating the gate | `VERIFIED_BY_INTEGRATION_TEST` — a write-once flow at `/account/date-of-birth`, a non-dismissible banner naming what is blocked, and gates inside placement and withdrawal. The column is still nullable, so enforcement is not yet structural; §0 stage 5d records the `NOT NULL` migration procedure that closes it |
| Deposit, loss and stake limits — lowering immediate, raising delayed 24 hours | `VERIFIED_BY_INTEGRATION_TEST` |
| Self-exclusion, surviving re-registration via an identity digest under a server-held pepper | `VERIFIED_BY_INTEGRATION_TEST` |
| Unverified accounts cannot withdraw (tier 0 → ₦0 daily cap) | `VERIFIED_BY_INTEGRATION_TEST` |
| KYC document upload and review | `VERIFIED_BY_INTEGRATION_TEST` |
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
| Passwords — argon2id | `VERIFIED_BY_INTEGRATION_TEST` |
| Sessions — httpOnly, sameSite, secure; revocation honoured on the next request | `VERIFIED_BY_INTEGRATION_TEST` |
| Input validation — Zod at every boundary | `VERIFIED_BY_INTEGRATION_TEST` |
| Webhook verification — HMAC over the raw body, constant-time | `VERIFIED_BY_INTEGRATION_TEST` |
| Rate limiting and OTP storage | `VERIFIED_BY_INTEGRATION_TEST` locally; needs Redis in the deployment |
| Open-redirect guard on sign-in | `VERIFIED_BY_INTEGRATION_TEST` — §9 |
| Secret scanning in CI | `VERIFIED_BY_INTEGRATION_TEST` — 15 rules |
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

**Now load-tested**, in stage 6 above: the board, `/api/live` polling at scale,
the market list, odds, and Pluto concurrency —
`scripts/bench-http.mjs`, report at `artifacts/load/HTTP_LOAD.md`. Zero failures
and zero 5xx, and the rate limiter measured shedding load correctly rather than
falling over.

Still not load-tested: **casino callbacks**, because there is no callback route
in the repository to load — the casino is a sandbox adapter with no aggregator
connected. And the Pluto figure covers the route, guardrails and dispatch, not
model latency, which does not exist yet.

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
Pluto AI, which is a keyword router today and needs an adapter — not "swap a
key".

The prompt-injection and concurrency work is **no longer waiting on the key**.
The adversarial corpus exists and runs (stage 5i: 53 attacks, 59 tests), and
Pluto concurrency is measured (stage 6). What still needs a key is replaying
that corpus **through a live model**, which is the only thing that can establish
how a model answers these prompts. Until then that specific claim, and nothing
else about this layer, stays `BLOCKED_BY_KEY`.

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
