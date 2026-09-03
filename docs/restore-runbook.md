# Database restore runbook

**Status: `BLOCKED_BY_OWNER_CONFIGURATION` — the restore described here has NOT
been performed.**

No Neon API key or project id is available to this project (`NEON_API_KEY`,
`NEON_PROJECT_ID` are both unset), so a restore branch cannot be created from
here. Nothing below claims a restore happened. It is the procedure, written so
that whoever has console access can follow it once and get an answer.

The verification half **is** implemented and tested: `npm run db:verify-restore`
runs the eight checks in step 5 and was exercised against the live database. So
the only untested part of this document is the Neon console steps themselves.

---

## Why this matters more than it looks

"An untested backup is not a backup" has been an open item in `docs/history/PLUTOBET_STATUS.md`
(A4) and `docs/history/GPT.md` (row 6) since the beginning. The failure mode is specific and
nasty: a restore that lands mid-transaction produces a database that *starts*,
*serves traffic*, and has a ledger that no longer balances. It looks like a
recovery. Wallet balances are a trigger-maintained denormalisation, so the most
likely damage is silent: cached balances that disagree with the entries behind
them, which is money appearing or vanishing without a trace.

That is what step 5 checks for, and it is why the drill is not "did it come
back up".

---

## Before you start

- Do this on a **scratch branch**. Never restore over the branch serving traffic.
- Pick a quiet hour. A restore drill on a live system is still a live system.
- Have the current recovery point to hand: run `npm run db:verify-restore`
  against production first and note the "effective recovery point" line, so you
  have a before and an after.

---

## 1. Confirm the plan actually retains what you think

In the Neon console, open **Settings → Storage / History retention**.

Note the retention window. On the free tier this is typically 24 hours and may be
shorter than the acceptable data-loss window for a money system. **Write the
number down** — if retention is 24 hours and the business needs 7 days, the drill
will succeed and the plan will still be wrong, and that is the finding.

---

## 2. Create a restore branch

Console: **Branches → New branch → Include data up to a point in time**, choose a
timestamp a few minutes in the past, and name it something unmistakable, e.g.
`restore-drill-YYYYMMDD`.

CLI equivalent, if a Neon API key exists:

```bash
npx neonctl branches create \
  --project-id "$NEON_PROJECT_ID" \
  --name "restore-drill-$(date +%Y%m%d)" \
  --parent-timestamp "2026-09-01T20:00:00Z"
```

**Do not** pass `--parent` pointing at production without a timestamp: that
creates a copy of *now*, which tests nothing about point-in-time recovery.

---

## 3. Get the branch connection string

Console: the new branch → **Connection details**. Copy the pooled URL.

Do not paste it into a chat, a ticket, or a shell that records history. Put it in
an environment variable in the shell you are about to use, and nowhere else.

---

## 4. Confirm you are pointed at the branch, not production

```bash
psql "$RESTORE_URL" -c "SELECT current_database(), inet_server_addr();"
```

The host must differ from production. This step exists because the next command
reads a database and it must not be the one you are trying to protect.

---

## 5. Verify the restored data

```bash
npm run db:verify-restore -- --url="$RESTORE_URL"
```

Runs inside a `READ ONLY` transaction, so it cannot damage the branch. It checks:

| # | Check | Why it is here |
|---|---|---|
| 1 | Schema complete | Migrations applied vs files on disk. A restore to before a migration leaves the app unable to start |
| 2 | Ledger balances globally | Debits equal credits |
| 3 | **Every transaction balances individually** | A global total can hide two errors that cancel out. This one cannot be fooled that way |
| 4 | Wallets agree with the ledger | The cached balance is trigger-maintained and is the most likely thing to survive a restore incorrectly |
| 5 | No negative wallet | A wallet that owes money is corruption, not a balance |
| 6 | Business records present | Users, bets, audit rows, recorded results |
| 7 | **Every won bet has a payout** | The check a customer would care about: were the people who won still paid? |
| 8 | Effective recovery point | The newest surviving row. This IS your real RPO — everything after it was lost |

Exit code 0 means coherent. Non-zero means **do not promote this branch**.

---

## 6. Record the numbers

A drill that produces no numbers has to be repeated. Write down:

| Field | Where it comes from |
|---|---|
| Requested recovery point | what you asked Neon for in step 2 |
| **Effective** recovery point | check 8 above — they are not always the same |
| Restore time (RTO) | branch creation start → step 5 passing |
| Data loss (RPO) | now minus the effective recovery point |
| Retention window | step 1 |
| Result | every check passed / which failed |

Then compare RPO against what the business can actually tolerate losing. For a
betting platform the honest question is: *how many settled bets and deposits can
we afford to forget?* If the answer is "none", the free tier is not the right
plan and that is a purchasing decision, not an engineering one.

---

## 7. Clean up

Delete the drill branch **only** when you are certain nothing is pointed at it,
and only if it holds no data that production lost. A restore branch that turns
out to contain the only copy of something is the one you must not delete.

```bash
npx neonctl branches delete <branch-id> --project-id "$NEON_PROJECT_ID"
```

---

## What "verified" would require

This document may be marked `VERIFIED_WORKING` only after steps 2–6 have actually
been executed and the numbers recorded. Running `npm run db:verify-restore`
against production — which has been done, and passes — proves the *checks* work.
It does not prove a *restore* works, and the two must not be confused in any
status document.
