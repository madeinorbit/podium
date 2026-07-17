# Reliable delivery confirmation + blocking sync send — design

Issue: POD-853 (Mid-turn delivery misses transcript echo). Parent epic POD-833
(Cross-agent communication rebuild). Builds on POD-834 (sync send + honest
delivery lifecycle, `[spec:SP-34d7]`).

## Problem

Transcript-echo is the current proof that a pushed message reached an agent:
`onTranscriptDelta` matches `[podium message <id>]` in a `role:'user'` turn and
flips the ledger `queued -> delivered`. It is a **fragile proxy**.

When a message is injected into a **busy** session mid-turn, Claude Code does not
record it as a clean `role:'user'` turn:

- an injected/synthetic turn is tagged `isMeta:true` and the transcript parser
  drops it (`packages/transcript/src/claude.ts:35`);
- a harness-injected string turn is tagged `promptSource:'system'` and is dropped
  (`packages/transcript/src/claude.ts:128`);
- or the text is folded into the same record as the `tool_result` blocks, so no
  clean user-text item carrying the id is emitted.

Result: `ECHO_ID_RE` never sees the id, the row stays `queued` with `injectedAt`
set, and after the 90s echo window the sweep clears `injectedAt` and **re-injects
= duplicate delivery**. For `kind:'ack'` this is unbounded (an ack cannot be
acked, and ack-confirms-original-delivered does not apply), looping until TTL or
the recipient reads its inbox.

Live evidence: coordinator session bc7f327d, 2026-07-17 (msg_660725d2,
msg_50c74356 re-delivered repeatedly).

Note: the "matches only the first id per delta" lead is a **red herring** —
`onTranscriptDelta` already loops every delta item and uses `matchAll` over the
global `ECHO_ID_RE`, so all ids per delta are matched. A regression test locks
this in.

## Decision (Michael, via POD-237 / coordinator relay 2026-07-17)

1. The harness queue is **not** a reliable delivered signal.
   - `delivered` = **observed in the target's transcript** (echo OR turn boundary).
   - `queued` = handed to the harness queue (typed into the PTY), not yet observed.
2. Blocking semantics for sync send, keyed on delivery confirmation:
   - `interrupt` blocks until **delivered**;
   - `next-turn` blocks until delivered within a **time budget**, else returns
     `accepted` ("query mail status");
   - `fyi` returns at `queued` only (never blocks).

## Design

### Part 1 — Turn-boundary backstop (the reliable delivered signal)

`onSessionIdle` fires only on `phase -> idle` (relay.ts:1136) — a cleanly
completed turn. An errored turn is a distinct `errored` phase (steward.ts:52) and
never triggers `onSessionIdle`, so it cannot false-confirm.

At the top of `onSessionIdle`, **before** `deliverBatch` (which stamps
`injectedAt = now` on newly-pushed rows), mark delivered every row that:

- has `injectedAt` set (already pushed into a PTY), AND
- `deliveredTo === session.sessionId` (pushed to THIS session), AND
- `deliveryMode !== 'pointer'` (pointer/pull-path rows are confirmed by an inbox
  READ, not a turn boundary).

The turn that just reached idle consumed those bytes, so the ledger flips to
`delivered` regardless of how the transcript recorded them. Transcript-echo stays
the ~1s fast path; the turn boundary is the backstop that needs no text matching
and **cannot duplicate**.

Ordering guarantees (from the POD-834 author's fix note):

- **Confirm before deliver**: any `injectedAt` present at the top of the handler
  is from a PRIOR turn; `deliverBatch` in this same idle stamps `injectedAt` after
  we confirm, so we never confirm a row we push in this cycle.
- **Exclude pointer rows** (`deliveryMode === 'pointer'`).
- Re-fetch pending after the confirm loop so a just-confirmed past-window row is
  not re-injected by `deliverBatch`.

Errored / crash-resume: since `onSessionIdle` only fires on `phase -> idle`, an
errored turn re-queues via the sweep for free (no idle-confirm runs). An
already-injected row confirmed at a *later* clean idle is honest: the injected
bytes persist in context across an error/resume. (Open Q2 to 834 author.)

### Part 2 — Blocking sync send

Confirmation primitive: `awaitDelivered(messageId, {timeoutMs})`, analogous to the
existing `awaitAck` — poll `getMessage(id).status` until it leaves `queued`
(delivered/read/dead_letter/expired) or the deadline passes. Every wait bounded
(the awaitAck rule: never hangs).

Blocking lives at the **agent/CLI send surface** (the gate, which already returns
a Promise — gate.ts:174), NOT inside internal sends (steward auto-ack,
self-suppress, systemAckFallback stay non-blocking). Chat-UI/operator sends are
`unwrapped` and confirmed on injection — no blocking needed.

Flow (agent/CLI send):

1. Run the existing synchronous `send()` -> `{message, disposition}`.
2. If the sync disposition is terminal-for-this-target (`dead_letter`, `held`,
   `spawning`) -> return as-is: there is no imminent live turn to wait on.
3. Otherwise by urgency:
   - `fyi` -> return `queued` immediately.
   - `next-turn` -> `awaitDelivered(id, NEXT_TURN_DELIVERY_BUDGET_MS)`;
     confirmed -> `delivered`; else -> `accepted`.
   - `interrupt` -> `awaitDelivered(id, INTERRUPT_DELIVERY_CEILING_MS)`;
     confirmed -> `delivered`; else -> `accepted` (ceiling is only a hang-guard).

Honest disposition at push time: an echo-mode live push reports `queued` (in the
harness queue, not yet observed), upgraded to `delivered` only on confirmation.
Unwrapped operator bodies remain `delivered` synchronously (injection IS delivery;
no echo possible). This makes the sync `delivered` mean CONFIRMED and directly
overlaps POD-852's "CLI prints delivered while row still queued" wording item —
see Open Q3.

New disposition value: `accepted` — durably queued to a live target, not yet
confirmed within the budget; CLI wording: "accepted — not yet confirmed; run
`podium mail status <id>`".

## Open decisions (routed to POD-834 author + coordinator)

- **Q1 budgets**: `NEXT_TURN_DELIVERY_BUDGET_MS` = 25s (the queue-drain deadline);
  `INTERRUPT_DELIVERY_CEILING_MS` = 90s (`ECHO_CONFIRM_WINDOW_MS`). Confirm.
- **Q2 invariants**: does turn-boundary `markDelivered` break any invariant the
  834 author relies on (ack-confirms-original-delivered c125318b, issue_messages
  mirror mark-read, hop stamp)? Is confirming an already-injected row at ANY
  subsequent idle safe given bytes persist across error/resume?
- **Q3 POD-852 overlap**: making the sync `delivered` honest (`queued` at push)
  is POD-852's wording item. Fold it here (blocking needs it) or keep POD-852
  separate and have blocking only UPGRADE observed deliveries?
- **Q4 spec ownership**: has POD-833/834 already recorded the updated §04d in
  SP-34d7, or should POD-853 write it (avoid a double edit)?

## Implementation order

1. Turn-boundary backstop + regression tests (uncontested foundation). TDD.
2. `awaitDelivered` + blocking gate surface + `accepted` disposition + CLI
   wording (after Q1-Q3 alignment). TDD.
3. Record decision in SP-34d7 (after Q4). Review by 834 author. Rebase under merge
   lock, ff-only land when authorized.
