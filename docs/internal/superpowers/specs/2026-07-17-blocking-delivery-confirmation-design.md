# Reliable delivery confirmation — design

Issue: POD-853 (Mid-turn delivery misses transcript echo). Parent epic POD-833
(Cross-agent communication rebuild). Builds on POD-834 (sync send + honest
delivery lifecycle, `[spec:SP-34d7]`).

> **Scope correction (coordinator, 2026-07-17):** the urgency-gated *blocking*
> sync-send semantics moved to a sibling issue, **POD-854 (Urgency-gated blocking
> send)**, which depends on POD-853 landing first (blocking-until-delivered is
> only safe once `delivered` is reliable). POD-853's scope is the reliable
> delivered signal itself: the turn-boundary backstop, best-effort acks, the
> errored-turn guard, and (deferred) a re-inject cap — plus keeping the
> delivered/injected surface clean enough that POD-854 can build a bounded
> `awaitDelivered(budget)` poll on it (template: POD-834's `awaitAck`). The
> blocking-send design below is retained for POD-854's reference.

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

`onSessionIdle` fires on `phase -> idle` (relay.ts:1136). A cleanly completed
turn (working/needs_user -> idle) consumed what it was given; an **errored** turn
(`errored` phase, steward.ts:52) did not, and `errored -> idle` fires
`onSessionIdle` too — so the backstop is gated on the prior phase (see Part 3).

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
- The just-confirmed ids are collected in a `confirmed` set and excluded from the
  deliver pass, so a past-window row is not re-injected by `deliverBatch`.
- **Clear the hop context AFTER the confirm loop**: `markDelivered` re-stamps
  `turnHop` (right for the echo path, which fires DURING the processing turn), but
  at a boundary the turn is over — clearing after the loop stops a stale hop from
  leaking into the session's next send.

### Part 2 — Best-effort acks / notifications

An `ack` is never itself acked and its ack-confirms-original side effect fires at
send time regardless; a steward/subscription notification never expects an ack
(SP-34d7). Chasing their transcript echo only feeds the re-inject loop — the live
regression was dominated by `kind=ack` rows. So an **echo-mode** ack/notification
is marked `delivered` on first injection (`confirmedOnInjection`) and the sweep
never re-injects it. Pointer/pull-path rows are unaffected (a read confirms
those). ack-confirms-original (send write path, c125318b) is untouched.

### Part 3 — Errored-turn guard

`errored -> idle` fires `onSessionIdle`, but that turn did not complete (API 529
mid-turn is frequent right now) and may not have consumed its injected rows. The
relay threads the phase the turn left from (`priorPhase`); the backstop skips
confirmation when `priorPhase === 'errored'`, leaving the rows queued so the sweep
re-queues them for a retry. A later clean idle confirms them. (The delivery drain
still runs after an errored turn — delivering NEW queued mail to a now-idle
session is fine.) Honors the coordinator's POD-833 caution (1).

### Deferred — re-inject cap

A general cap on sweep re-injection (N attempts then dead-letter) is a safety net
for the residual case: a non-ack message injected to a recipient that repeatedly
errors on it (never reaching a clean idle). After Parts 1-3 this is rare (a
busy/parked target is never re-injected — the sweep holds; acks never loop;
errored turns re-queue but a retry confirms). Deferred pending the coordinator's
call on ownership (POD-853 vs POD-852) and durability (in-memory counter vs a
messages-table column, which would need coordinating with POD-835). Recommendation:
an in-memory cap now as a cheap stopgap, upgradeable to durable if desired.

## For POD-854 reference — blocking sync send (NOT in POD-853 scope)

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

## Open decisions

- **Re-inject cap** (deferred, see above): POD-853 vs POD-852; in-memory vs
  durable column (coordinate schema with POD-835). Routed to the coordinator.
- **Spec record**: has POD-833/834 already recorded the updated §04d in SP-34d7,
  or should POD-853 write it? Routed to the coordinator (avoid a double edit).
- **For POD-854**: budgets (`NEXT_TURN_DELIVERY_BUDGET_MS` = 25s / queue-drain
  deadline; `INTERRUPT_DELIVERY_CEILING_MS` = 90s / `ECHO_CONFIRM_WINDOW_MS`); and
  the sync-`delivered`-honest wording, which overlaps POD-852.

## Implementation status (POD-853)

1. ✅ Turn-boundary backstop + regression tests (65ffb6f4). TDD.
2. ✅ Best-effort acks/notifications (935aca0a). TDD.
3. ✅ Errored-turn guard + relay `priorPhase` thread (06365c6d). TDD.
4. ⏳ Re-inject cap — deferred to coordinator (ownership + durability).
5. ⏳ Review by POD-834 author (offered); DONE to coordinator, who merges+deploys.
   Spec record in SP-34d7 pending the ownership answer.

## Implementation status (POD-854 — urgency-gated blocking send)

Landed the open decisions from this doc, rebased onto `afffbb43` (which carries
POD-853 + the requeue cap + POD-835 + POD-865's composer-draft hold). TDD, in
`apps/server/src/modules/messages/{service,gate}.ts` + `apps/cli/src/mail-cli.ts`:

1. ✅ **Honest sync disposition** — an unconfirmed echo/pointer LIVE-PTY push
   reports `queued`, not `delivered`; only confirmed-on-injection (unwrapped
   operator / best-effort ack) is `delivered` synchronously. A durable boot-queue
   push (`resumeAndSend` to an unbound session) stays `queued` — it types when the
   session binds. This resolves the POD-852 "CLI prints delivered while row still
   queued" overlap (nothing left there for that item).
2. ✅ **`awaitDelivered(messageId, {timeoutMs})`** — bounded poll on the ledger
   (leaves `queued` → delivered/read/dead_letter, or the deadline). Never hangs;
   `now`/`sleep` injectable for deterministic clock tests.
3. ✅ **`sendAndConfirm` at the gate send surface** — `interrupt` blocks to
   `INTERRUPT_DELIVERY_CEILING_MS` (90s hang-guard), `next-turn` to
   `NEXT_TURN_DELIVERY_BUDGET_MS` (25s) then `accepted`; `fyi` at queued;
   held/spawning/dead_letter/operator-addressed pass straight through. Blocks on
   BOTH `messages.send` surfaces (relay + tRPC); internal sends keep calling
   `send()`. Budgets: 25s = queue-drain deadline, 90s = `ECHO_CONFIRM_WINDOW_MS`.
4. ✅ **Composer-draft hold (POD-865) respected** — a draft-held row is `queued`
   with no injection, so it outlasts the budget and returns the honest `accepted`
   (never spins). Explicit test.
5. ✅ **CLI** renders `accepted` and points the sender at `podium mail status <id>`.
6. ⏳ Adversarial review + DONE to the POD-833 coordinator (merges+deploys); the
   coordinator owns the live/deploy validation.

Deferred (filed for another agent, not in POD-854 scope): `podium session send`
(relay direct, always next-turn) stays non-blocking for now — a consistency
follow-up, tracked as a discovered sub-issue.

### Review round 1 (coordinator REQUEST-CHANGES) — fixed

7. ✅ **Transport-timeout blocker.** The daemon loopback agent-relay hub timed out
   EVERY relayed proc at 30s (`createAgentRelayHub` default), but the gate holds
   `messages.send` open up to the 90s interrupt ceiling — so on the primary agent
   surface the CLI threw `agent relay timed out` before the gate could return, and
   the sender resent (the duplicate this milestone kills). Fix: a per-proc hub
   timeout — `messages.send` gets `AGENT_RELAY_BLOCKING_TIMEOUT_MS` (new shared
   `@podium/protocol` constant, 120s), normal RPCs keep 30s. Still bounded. A
   server-side drift-guard test enforces `INTERRUPT_DELIVERY_CEILING_MS` (and the
   next-turn budget) stay ≥20s under the transport timeout — dissolving the
   secondary "25s sits only 5s under 30s" concern too. Daemon-seam tests cover the
   discrimination + the longer bound. (ask/awaitAgent share the >30s latent issue —
   POD-872.)
8. ✅ **Terminal-undelivered honesty (NIT).** `blockForDelivery` now returns
   `accepted` ONLY while the row is still queued at budget expiry; a row that went
   terminal-undelivered mid-block (dead_letter / expired / cancelled) reports
   `dead_letter`, never the pending-implying `accepted`.
