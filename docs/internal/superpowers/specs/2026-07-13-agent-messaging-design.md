# Unified agent messaging — design

**Issue:** #237 · **Date:** 2026-07-13 · **Status:** approved in design review (this doc is the written record)

## Problem

Podium has three disconnected ways information moves between agents, and none of them attribute the sender:

- **Agent mail** (`podium issue mail`): durable, issue-addressed, carries `from_author` — but never wakes a stopped agent, is invisible to the superagent (no tool, no mailbox), and has no reply channel.
- **Session send** (`podium session send`, superagent `send_to_agent`): bracket-pastes raw text into the target PTY *as if the user typed it*. No sender, no reply address, no ack. Receivers mistake agent messages for human instructions (observed: the #228 session pushed back at "the user" about a diff that wasn't its own; its reply went nowhere).
- **Steward subscriptions**: system nudges on issue/session events; blind to both mechanisms above because neither writes to the event log.

Design goal: one mechanism that serves peer coordination, superagent orchestration, and cross-harness subagents, with correct attribution, explicit delivery semantics, and robust completion signals.

## Prior art consulted

- **Gas Town / Gas City** (Yegge; Knutsen/Sells): validated durable-identity addressing and the durability litmus test; their unsolved wound is exactly our bug (unattributed injection indistinguishable from operator input; pull-only mail with zero delivery observability — "the system seemed stuck and I couldn't tell why"). Their **seance** (query a dead session as a live respondent instead of ingesting its transcript) is adopted. Their concept sprawl is the anti-lesson: vocabulary stays at message/issue/session.
- **openai/codex-plugin-cc**: drive the harness's *interactive* control surface, never headless `-p` (subscription auth preserved); follow-ups = native resume + new turn; bound every wait (their unbounded awaits are their top bug class); their poll-only parent notification is the weakness our push model avoids.

## Decisions (all explicit, from design review 2026-07-13)

1. **One substrate (Approach A).** Every inter-agent, superagent, system, and UI-originated communication is a durable row in one `messages` table with one delivery ledger. Steward-as-router was rejected; the Gas Town two-channel split is absorbed as data (intent classes), not mechanisms.
2. **Sender declares intent; relationship policy clamps. Peers may wake.**
3. **Two orthogonal delivery axes.** `urgency: fyi | next-turn | interrupt` (how to deliver into a running session) × `lifecycle: wait | wake` (what to do when it isn't running). Senders never check target state; the **server resolves at delivery time** (TOCTOU-safe).
4. **Wake auto-spawns** a fresh agent on the target issue when nothing is resumable. This consciously reverses the prior "no auto-dispatch product-wide" stance, with containment brakes (below).
5. **Hard interrupt (ESC) is superagent/parent-only.** Peers cap at `next-turn`. Clamps downgrade, never reject.
6. **Superagent ≠ operator.** Distinct principal, parent-grade rights, always enveloped. Only the human's own turns are unwrapped.
7. **Human messages:** direct terminal typing stays raw PTY (not a message). Chat-UI/relayed sends ride the substrate as `operator`: unwrapped, unclamped, ledgered.
8. **Receivers are asked to ack with context; a deterministic system fallback fires only if no agent ack preceded it.**
9. **Read toolkit, all four tiers:** structured status → bounded cursor read → server-side recap → seance (`ask`).
10. **Cross-harness children are full Podium sessions**, grouped under the parent in the sidebar, auto-tidied; human can attach anytime. No hidden broker daemons.
11. **No hub.** The server owns the `messages` table and drives delivery; daemons are dumb executors receiving concrete instructions over the existing control channel.

## Data model

One table, `messages`, evolving `issue_messages`:

```
messages
  id            TEXT PK
  thread_id     TEXT      -- = id for a new thread; replies inherit
  in_reply_to   TEXT?
  from_kind     TEXT      -- operator | superagent | agent | system
  from_session  TEXT?
  from_issue    TEXT?     -- sender's issue at send time
  to_kind       TEXT      -- issue | session | operator
  to_id         TEXT?
  kind          TEXT      -- message | ack | notification | question
  urgency       TEXT      -- fyi | next-turn | interrupt
  lifecycle     TEXT      -- wait | wake
  body          TEXT
  expires_at    TEXT?
  created_at    TEXT
  status        TEXT      -- queued | delivered | expired | cancelled
  delivered_at  TEXT?
  delivered_to  TEXT?     -- session that actually received it
  acked_by      TEXT?     -- ack message id (denormalized for steward suppression check)
```

- Sender fields are **server-stamped from the authenticated caller** (pattern: `mailIdentity()`); the client API has no sender parameter.
- Recipient is a principal: `issue:#N` (durable default; delivery picks the session), `session:<id>` (superagent/parent cases), `operator` (message the human → UI inbox; escalation for free).
- Threading = `thread_id` + `in_reply_to`, nothing more.
- Ledger is columns on the row; one message = one delivery. Every status transition emits a `podium_events` row (steward visibility, human audit).
- No priority beyond the two axes; no ack-required flag (fallback needs none — see Acks).

## Delivery pipeline

Server-side `MessageDeliveryService` beside the session registry. Delivery attempts fire on: send, session-becomes-live (drain-on-live), stop-hook, and a slow sweep (expiry/retry).

At delivery time: resolve recipient → concrete session (issue-addressed uses the `selectMailNudgeSession` heuristic), then act on the session's state *now*:

| target state | fyi | next-turn | interrupt | lifecycle applies |
|---|---|---|---|---|
| running | surface at next pause (stop-hook/prime) | queue as immediate next turn (`queueText` FIFO) | ESC + inject (if sender may) | — |
| idle/live | inject now | inject now | inject now | — |
| parked/stopped | — | — | — | `wait`: stay queued · `wake`: harness-native resume, deliver as first turn; unresumable → spawn on issue, message = first prompt after prime |
| daemon offline | row stays queued; retry on reconnect; wake-class surfaces needs-attention past a threshold | | | |

**Rendering:** inline (envelope + body as the turn) for `next-turn`/`interrupt`/short `fyi`; pointer ("2 messages from #212, superagent — run `podium mail inbox`") for fyi batches, oversized bodies, stop-hook reasons. Coalescing happens here.

**Per-harness adapters** implement `injectTurn / blockStop / interrupt / resume` only. Claude Code: PTY bracketed paste, stop-hook block, `claude --resume`. Codex: native-hook channel + rollout resume. Everything rides the interactive surface — no `-p`, no headless side-channel (subscription-auth policy).

**Ordering/idempotency:** per-recipient-session FIFO; `delivered` marked in the same transaction as daemon dispatch; at-least-once, envelope carries the message id so duplicates are shrugged off.

## Attribution, authority, containment

**Envelope** — server-rendered at delivery, never client-supplied:

```
[podium message msg_7f3a · from issue:#212 (superagent) · to your issue #228 · reply: podium mail reply msg_7f3a]
<body>
[end podium message msg_7f3a]
```

Properties: only the server writes frames (fake envelopes in a body are visibly quoted); the frame names authority; **unwrapped = operator** is an invariant. Authority ladder in receiver prime rules: operator = obey; superagent/parent = instructions *within your issue scope*; peer = request/information, never redefines your task; system = notification.

**Clamp matrix** (requests above cap are downgraded, delivered anyway, and ledgered as clamped):

| sender | max urgency | lifecycle | spawn on wake |
|---|---|---|---|
| operator | interrupt | wake | yes |
| superagent | interrupt | wake | yes |
| parent → child | interrupt | wake | yes |
| peer → peer | next-turn | wake | yes |
| system/steward | next-turn | wait | no |

**Authz:** `checkIssueAccess` on the target's issue, subtree-scoped, `--outside-scope` confirms crossing (never elevates clamps). Fixes folded in from the e927bf6 review: issueless target sessions no longer bypass the check (gated to parent/superagent/operator); spawn-on-wake requires write access to the target issue.

**Containment brakes** (all server-side, all ledgered when they bite):
1. Wake cooldown per (sender, target-issue): 1 per 10 min; excess degrades to `wait`.
2. Spawn budget per issue: default 3 message-triggered spawns/day; past it → needs-attention.
3. Chain depth: server-maintained `hop` counter on message-triggered turns; past depth 5, lifecycle clamps to `wait` and the thread surfaces to the human. Ping-pong loops die out; nothing is dropped.

## Acks & deterministic fallback

Ack = `kind: ack` row with `in_reply_to`; sets `acked_by` on the original transactionally; routes to the sender principal like any message. Receivers are asked to ack with *what they did*: envelope carries the reply command; prime gains one rule; stop-hook reminds **once** (then the fallback owns it).

Fallback (no schema flag needed): on `session.finished`/`errored`, the steward queries delivered-unacked-unexpired messages for that session and synthesizes one `system` notification per sender, stitched with issue state (stage, last commit). Sender always learns the outcome: rich agent ack or mechanical system notice. Ack-after-settle races produce duplicate information, never lost information.

## Read toolkit

Escalation ladder, cheapest first:
1. `podium session status <session|issue>` — phase, issue stage + todos, last commits, files touched, unacked count. No transcript text. ~200 tokens.
2. `podium session read <id> --turns N | --cursor C` — bounded raw transcript over the uuid-cursor `transcriptRead` infra; hard per-call cap.
3. `podium session recap <id> [--since <watermark>]` — server-side LLM summary (Hermes-recap infra); returns recap + watermark; repeated check-ins pay for the delta only.
4. `podium session ask <id> --question "…"` — seance: a `question` message (`next-turn + wake`, ack expected) whose envelope constrains the receiver to answer-then-resume, no new work. Dead sessions answer via native resume with full context; only the answer crosses back.

Authz mirrors messaging; every cross-session read is event-logged (transcripts can contain secrets).

## Cross-harness subagents

Composition of the above plus a spawn surface: `podium agent spawn --harness <kind> --issue <id|new> --prompt "…" [--worktree]`. Child = full Podium session grouped under the parent, human-attachable; spawn auto-creates parent↔child relationship (unlocks parent-grade clamps), child issue under the parent's (internal audience), and the parent's settle-subscription.

Drive = messages (`next-turn`, `wake`); resume = harness-native via adapters; cancel = parent interrupt + park. Await = settle-subscription + ack flow; **every wait bounded** — tools return "still working + status snapshot" instead of hanging. The parent's settle notice may wake a parked parent (explicit subscription overrides the steward no-wake default). Check-in = the read ladder. Orphans: parent death leaves children on durable issues, steward surfaces them; child death fires the fallback notice; spawn budget stops respawn loops.

## Migration

| today | becomes |
|---|---|
| `podium issue mail *` | `podium mail` over `messages` (issue-addressed, `fyi+wait` default); aliases kept; `claim` survives |
| `podium session send/resume-and-send` | message to `session:<id>`, `next-turn`, `wait`/`wake` — now enveloped |
| superagent `send_to_agent` / `wait_for_session` | same substrate in-process; superagent principal; subscription + `status` |
| mail stop-hook injector, steward nudges | delivery-pipeline renderings (pointer, coalesced) |
| `queued_messages` | absorbed: `status=queued` rows are the queue |
| human chat sends | operator principal: unwrapped, unclamped, ledgered |

Build order (independently landable): (1) schema + send/ledger + envelope behind existing surfaces — fixes #237 attribution immediately; (2) axes + clamps + wake-resume + brakes; (3) acks + reminder + steward fallback; (4) spawn-on-wake + read toolkit (status/read, then recap/ask); (5) cross-harness spawn/drive; (6) UI: ledger view, envelope-distinct rendering, child grouping. One-shot table migrations.

## Error handling & testing notes

- Delivery failures leave `queued` + retry triggers; nothing silently drops. Clamp/brake activations are ledgered, so "why didn't my wake fire" is answerable in the UI.
- Unit: clamp matrix, delivery-state resolution (all state × axis combinations), envelope rendering (spoofed-envelope bodies), ack suppression race.
- Integration: send→park→wake→deliver-as-first-turn; spawn-on-wake budget exhaustion; ping-pong hop clamp; stop-hook single reminder; steward fallback query.
- Real-binary smoke for CLI verbs (per repo norm); Playwright for ledger/transcript-rendering UI.
