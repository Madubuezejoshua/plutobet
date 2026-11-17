# Settlement operations

How a bet gets paid, what can go wrong, and what to do about it.

Written after a real winning bet stayed `PENDING` for fourteen hours behind a
green dashboard. Every section below exists because something in it failed.

---

## The chain

```
  odds provider
        |  settlement-poll-results        cron * * * * *, cadence-gated (5 min)
        v
  event_results  +  settlement_outbox     ONE transaction, both or neither
        |
        |  settlement-dispatch-outbox     cron * * * * *, NO provider call
        v
  settlement/event.finished
        |
        |  settle-event                   finds pending bets, closes markets
        v
  settlement/bet.requested
        |
        |  settle-bet                     locks the bet, pays, releases exposure
        v
  ledger PAYOUT / REFUND

  settlement-recovery-sweep               cron */2 * * * *, level-triggered
        \___ finds anything the chain above left behind, and re-enqueues it
```

Four scheduled functions, not one. The split is deliberate and each boundary
was bought with an incident.

### Why the poller does not settle

It used to. The poller ingested the result and dispatched settlement in the same
handler, and that was the bug:

`oddsCadence.claimIfDue` sat **outside** `step.run()`. Inngest invokes a handler
once per step, replaying from the top and serving completed steps from a
checkpoint, so code outside a step re-executes on every invocation. Invocation 1
claimed the cadence slot and ingested the result. Invocation 2 replayed, found
the claim **held by its own first invocation**, returned `{skipped: "not due"}`,
and never reached the dispatch.

Everything after the first step was unreachable by construction. The heartbeat
went green because the ingestion step succeeded. No settlement was ever
dispatched, for any event, ever.

The claim is now inside `step.run`, so the `true` replays from the checkpoint.

### Why there is an outbox

Even with that fixed, the result committed to PostgreSQL and the hand-off went
to the scheduler over the network. A crash between them stranded the bet
**permanently**, because `pollFinishedEvents` only ever considers events with no
stored result — once the result exists, the event is never looked at again.

The work item is now written in the same transaction as the result.

### Why dispatch is separate from polling

The poller needs the odds provider. The dispatcher needs nothing but the
database, because the result it acts on is already stored locally.

That is what makes settlement survive an exhausted API budget — the state the
system was actually in while a customer went unpaid. **Provider budget must
never be able to stop money reaching somebody whose result we already have.**

### Why there is a sweep

The normal path is edge-triggered on a result arriving. Miss the edge once and
the event is invisible forever. The sweep is level-triggered: it asks whether
anything is in a state that should not persist and does not care how it got
there.

It **enqueues only**. It never writes a bet, wallet, market or ledger row. A
recovery routine with its own settlement logic is a second implementation of the
most consequential code in the system, and the two will disagree eventually.

---

## Reading the heartbeats

`SELECT job, ... FROM job_heartbeats` — four rows now, not one.

| Job | Means |
|---|---|
| `results` | provider polled, results stored |
| `settlement-dispatch` | work items handed to the scheduler |
| `settlement-events` | events settled, markets closed |
| `settlement-recovery` | inconsistencies found and re-queued |

**The field that matters most is `pending_after_run_count`.** It is the number of
bets still `PENDING` on an event whose result we already hold. In a healthy
system it is zero. Anything else is customer money that has stopped moving.

`settlement_completed_count` is only ever written by code that performed a
settlement. `dispatch_accepted_count` means the scheduler accepted a message —
**it is not a payment**, and the two are separate fields precisely so they can
never be conflated again.

`error_stage` names where a run stopped: `claim`, `ingest`, `dispatch`,
`settle`, `recover`, `close-markets`.

### The old heartbeat, and why it lied

It had one row and two counters, and the caller passed `settled: 0` as a literal
at the point the ingestion step returned — before any settlement was attempted.
A run reported SUCCESS with "settled 0" while the dispatch never happened.
`settled_count` could not be anything but zero. **A result-ingestion success must
never silence a settlement failure.**

---

## Alerts

Raised to Sentry by the recovery sweep, on every run that still sees them:

| Condition | Meaning |
|---|---|
| `pendingOnFinalEvents > 0` | a bet is unpaid on a result we hold |
| `wonWithoutPayout > 0` | a bet says WON and no money moved. Page somebody |
| `finalEventsWithOpenMarkets > 0` | settlement did not finish closing an event |
| `stalledDispatches > 0` | handed over more than 10 minutes ago, never completed |
| `abandoned > 0` | a work item exhausted its attempts. Needs a human |
| `unreleasedExposureMarkets > 0` | a market holds liability with no pending bet |

`npm run production:check` reports the first three as **launch-blocking**.
Customer money stuck behind a known result is not a soft warning.

---

## Diagnosing a bet that has not settled

```bash
npm run settle:watch -- <betId>
```

Read-only by construction: it runs inside `BEGIN … READ ONLY`, so PostgreSQL
itself rejects any write it might attempt. A monitor that *could* write is not
evidence.

Then work down the chain:

| Symptom | Look at | Likely cause |
|---|---|---|
| no `provider result` | `results` heartbeat, `error_stage` | poller failing, or the event is not yet 3h past kickoff |
| result present, no outbox row | `settlement_outbox` for the event | pre-outbox legacy row; the sweep will pick it up within 2 minutes |
| outbox `PENDING`, never dispatched | `settlement-dispatch` heartbeat | dispatcher failing; check `last_error` |
| outbox `DISPATCHED`, stuck | `settlement-events` heartbeat | `settleEvent` failing; re-claimed automatically after 10 minutes |
| outbox `FAILED` | `last_error`, `attempts` | gave up after 10 attempts. Investigate before doing anything |
| bet `WON`, no payout | ledger | should be impossible; treat as an incident |

### What NOT to do

**Do not settle it by hand.** `scripts/qa-settle-run.ts` and `qa-settle-one.ts`
exist for tests and prove only that a human can settle a bet, which was never in
doubt. Manually paying a bet also destroys the evidence needed to find out why
the pipeline did not.

**Do not delete a `FAILED` outbox row** to clear a dashboard. It is the record
that somebody's money did not move. The runtime role has no `DELETE` grant on
that table for exactly this reason.

---

## Recovering a stranded bet

Normally: nothing. The sweep runs every two minutes, finds it, and re-enqueues
it through the ordinary path. That is how the real stranded bet was recovered —
audit trail, one payout, markets closed, no human in the loop:

```
13:56:48  SETTLEMENT_RECOVERY_ENQUEUED  recovery sweep found 1 pending bet(s)
                                        on an event with a final result
13:56:49  outbox DISPATCHED
13:56:56  ledger PAYOUT CREDIT 43000
13:56:58  outbox COMPLETED
```

If the sweep is not running, start the scheduler:

```bash
npm run dev:all        # locally: Next plus the Inngest dev server
```

An event already marked `SETTLED` is still recovered. The sweep deliberately
does **not** filter on `events.status` — the stranded event was marked `SETTLED`,
and filtering on the status would have excluded the exact row it exists to find.
What matters is a final **result**, not the label on the event.

---

## Idempotency, and why replays are safe

Four independent layers, each of which alone would be enough on a good day:

1. `settlement_outbox.idempotency_key` is unique per event.
2. `claimBatch` uses `FOR UPDATE SKIP LOCKED`, so two dispatchers take disjoint
   batches.
3. Dispatched messages carry an id of `settle-event:<eventId>:<attempt>`. The
   attempt is part of it deliberately: with a stable id the scheduler
   deduplicated every re-dispatch of a stale item, so `settleEvent` never ran
   again and the item could never complete — six finished events were observed
   climbing toward a false FAILED alert. A replay of the SAME attempt is still
   deduplicated, which is the property that was wanted.
4. `settleBet` reads the bet `FOR UPDATE`, returns early if terminal, and keys
   its payout credit off the bet id.

Tested: the whole chain replayed four times, two dispatchers concurrently, and
five recovery runs in a row — one payout in every case.

---

## Connection pooling

The runtime clients no longer use `max: 1`. That was justified as "one
connection per serverless instance", which is right for Vercel-style serverless
and wrong for Railway, where one persistent container serves every request and a
single connection makes the whole application serialise behind one slow query.

| Client | Default | Variable |
|---|---|---|
| pooled reads | 10 | `DATABASE_POOL_MAX` |
| money path (unpooled) | 5 | `DIRECT_DATABASE_POOL_MAX` |
| migrations / scripts | 1 | not configurable, deliberately |

The money pool is smaller on purpose: those transactions take row locks, so
extra concurrency buys contention rather than throughput. Invalid, zero,
negative or excessive values are **refused at boot**, not clamped — Neon's
compute has a bounded `max_connections` shared by every client, and exhausting
it fails requests outright instead of queueing them.
