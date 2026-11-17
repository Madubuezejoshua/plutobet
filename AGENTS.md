<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!--
  Everything below is OUTSIDE the generated block on purpose. `next dev`
  rewrites only what sits between the BEGIN and END markers above, so anything
  placed here survives regeneration. Do not move it inside them.
-->

# Reporting

**`/general.md` is the single source of truth for the state of this project.**

After every implementation, test, repair, deployment or audit task, update it
with evidence-backed current status **before** reporting completion. If a change
makes anything in it untrue — a gate result, a status label, a blocker, a
control in the interaction inventory, a commit count — the change is not
finished until that section is corrected.

`general.md` §0 is a resume checkpoint. Keep it current as work proceeds so an
interrupted session can be continued from the repository alone, without
guessing and without repeating finished work.

No other document is a current-status report. `NEXT_WORK_REPORT.md` is a running
log of what each pass did. `OWNER_LAUNCH_CHECKLIST.md` lists what needs an
account holder. `docs/history/` is historical evidence. Runbooks and security
documents serve operations. All of them point at `general.md` for current state.

## Rules that file follows, and so does anything written into it

- **A claim carries its evidence, or it is not made.** "Tested" means a named
  test; "works" means an observed run. "Looks correct", "should work",
  "implemented" and "tests pass" are four different statements and are never
  used interchangeably.
- **Passing tests are never presented as proof that an external service works.**
  A fixture is not a provider. QA ledger credit is not a deposit. A local OTP is
  not a delivered message. A sandbox adapter is not a casino. A keyword router
  is not a language model.
- **Nothing is described as automatic if it was invoked by hand.**
- **No credential, connection string, one-time code or personal detail** is ever
  written into it. Environment variables are named and reported only as set,
  missing, invalid or blocked.
- **A single completion percentage is not used.** It averages incomparable work
  and hides whether a customer can complete a journey.

## Evidence levels

`VERIFIED_IN_REAL_BROWSER` · `VERIFIED_END_TO_END` ·
`VERIFIED_AGAINST_REAL_PROVIDER_DATA` · `VERIFIED_BY_INTEGRATION_TEST` ·
`VERIFIED_BY_UNIT_TEST_ONLY` · `IMPLEMENTED_NOT_LIVE_TESTED` ·
`BLOCKED_BY_KEY` · `BLOCKED_BY_CONTRACT` · `BLOCKED_BY_OWNER_CONFIGURATION` ·
`BLOCKED_BY_PRODUCT_DECISION` · `BLOCKED_BY_REGULATION` · `NOT_IMPLEMENTED` ·
`FAILED`

Never upgrade a status without the evidence its level names.

# Money and data safety

These are not style preferences. They are the rules that keep a betting ledger
trustworthy, and they hold for every task.

- **Never manually edit** wallet balances, ledger entries, ledger transactions,
  bet outcomes, bet statuses, payout records, event results, settlement-outbox
  status or exposure values. Money moves only through application services,
  public HTTP routes, registered background jobs, migrations, or explicitly
  QA-gated utilities pointed at a disposable database.
- **Development, testing, screenshots, seeding and load testing use a local
  disposable database.** Never production, never real customer data.
- **Any query against `wallets` must name a bucket.** A predicate of
  `(user_id, kind, currency)` matches three rows and takes whichever the
  planner returns first — the ledger stays balanced and the money lands where
  the customer cannot spend it.
- **Do not weaken a test or a control to get a green result.** Not by deleting
  or skipping a failing test, lowering an assertion, disabling a trigger,
  bypassing RBAC, account status, age, KYC, responsible-gambling limits or
  idempotency, swallowing an exception, turning an error into a success, or
  using `any` and disabled lint rules to hide a defect. If an existing test is
  objectively wrong, record the evidence, then replace it with a stronger one.
- **No destructive git.** No force push, no destructive reset, no rewriting
  published history, no bypassing branch protection, no committing secrets or
  generated environment files.
