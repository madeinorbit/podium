# POD-4819 — Harness receipt proof (Phase B of POD-4720)

Status: design for review, 2026-09-29, on `issue/4720-acknowledged-message-delivery-chain`.
Revised after an independent first-principles review the same day (§11).

## 0. How to read this spec

- **Decided** (§3–§6) does not depend on how any agent program behaves. Where a decided mechanism
  needs a property of the program to be safe, the property is named as a **precondition**, and
  the mechanism is switched on for a program only when §7 shows that precondition *run*.
- **Open** (§7) is everything that depends on a program's behaviour. Nothing there is built until
  every fact it depends on is *run*; the decision is then written into §7.

Every fact about an agent program is labelled *run* (observed on the real CLI by the method in
§8, evidence committed) or *read* (from code, a compiled binary, docs or an upstream issue: a
candidate only).

## 1. Goal

Know, for every message and every agent program, whether the message reached the agent's
conversation. Every message ends as delivered, not delivered, or `unknown`; `unknown` only when
neither can be known. Never a false yes, never a false no.

Not in this phase: typing into a terminal, and never leaving text in the input box (Phase D,
POD-4821); delivery modes and their time limits (Phase C, POD-4820); the daemon's durable
storage (POD-4766 / POD-4777, designed by the operator; §9 lists only what this phase needs).

## 2. Words

- **Agent program** — Claude Code, Codex, Grok, OpenCode, Cursor or Pi. **Transport** — its
  terminal (PTY), or a protocol (Claude SDK stream-json, Codex app-server, OpenCode HTTP v1/v2,
  Grok ACP).
- **Delivery mode** — `when-ready`, `queue`, `interrupt`, `steer`, `at-boundary`
  (`packages/harness/src/driver/turns.ts:21`); the stored message path uses `when-ready` and
  `interrupt` today.
- **Sender** — a person, an agent (mail) or the system; since POD-4846 all travel as messages
  with an id and a status.
- **Wrapped** — typed inside `[podium message <id> …] … [end podium message <id>]`
  (`apps/server/src/modules/messages/render.ts:135`), so our id is in the agent's own history.
  **Unwrapped** (no id in the text): a person's chat (`render.ts:187-211`), the owner's first
  prompt, automations, auto-continue's "continue" (POD-4846).
- **Delivered** — in the agent's conversation history: the model reads it at its next step, and
  it survives a restart of the agent program.
- **Foreign write** — any byte written into a terminal session that is not part of the message
  being typed (its paste, its Enter, its submit retries): a person's keystrokes, menu answers,
  interrupt keys, clears, redraws, Draft Sync, anything.

## 3. Decided: principles

1. **One id per message**, minted by the sender, carried to every hop (Phase A).
2. **Statuses move forward only**, one list for server, daemon and drivers (§4).
3. **A yes comes only from the agent program's own record** of the message (its reply, its hook,
   its history entry). **A no comes only from direct evidence** (§6). Agent states and screen
   readings decide only *when to look*.
4. **Never guess.** When more than one message could match a signal, none is credited.
5. **A timer moves a message only to `unknown`**, never to `failed` or `confirmed`. Proof that
   arrives later still moves it forward.
6. **Only history written after the send can prove it** (§5.2).
7. **Bind by the strongest means the program offers** (§5.1).
8. **Resend under the same id where the receiver deduplicates.** Where it is *run* that a program
   ignores a repeat of our id (at-least-once delivery plus an idempotent receiver), recovery is a
   resend under the same id, and no "no" has to be proven. Proving "no" (§6) is needed only for
   programs that do not deduplicate.
9. **Run, not read** (§0, §8). A fact holds for the program version it was run on. A newer version
   is not blocked (a version ceiling is only a "verified through" marker): it runs on the same
   rules, is marked not yet verified, is measured again, and the self-check alarm (§6.3) watches
   meanwhile.

## 4. Decided: statuses

| Status | Meaning |
|---|---|
| `stored` | The server has it. |
| `dispatched` | The server sent it toward the agent's machine. |
| `reached-machine` | The daemon saved it on its disk (POD-4777). |
| `typing` | The daemon saved "about to hand it over" just before the first keystroke or request; a retract loses from here (POD-4777). |
| `typed` | Handed over: the text and Enter written, or the request sent. |
| **`accepted`** (new) | The agent program took it but may still hold it (its own queue, a steer waiting for the next model step). A step, not an ending: it can still be lost (POD-4849, Claude's Escape). |
| `confirmed` | In the agent's conversation history. **Delivered.** |
| `cancelled` | Retracted before `typing`. |
| `failed` + cause | Not in the conversation, by direct evidence (§6). Safe to resend. |
| `expired` | Never handed over within its time limit (only from `stored`). |
| `unknown` | Handed on (from `dispatched` to `accepted`), and no yes or no can be expected any more. Late proof moves it to `confirmed`; it may also still go `failed` or `cancelled` (`packages/model/src/entities/message-delivery.ts`). |

- A status may be skipped when a program has no signal for it.
- New moves: `typed → accepted`; `accepted → confirmed | failed | unknown`; every move into
  `confirmed` from before `typed` may also go into `accepted`.
- **`failed → confirmed`, only on an exact id match** (our id, or the program's own id for our
  call), recorded as a contradiction and raising the self-check alarm (§6.3). A false "no" is then
  corrected instead of shown forever. This changes Phase A's final statuses: `failed` stays final
  for every other move.
- **Details, not statuses:** what proved it; how it was matched (our id, the program's id, order
  plus text); the transcript entry and the program's own ids (POD-4774, POD-4841); the failure
  cause; the mode actually used; "accepted by the program" when an `accepted` message went
  `unknown`.
- **The driver speaks the same words**, by message id, at any time after `send()` returns:
  `typed`, `accepted`, `confirmed`, `refused`, `unverified`. `refused` becomes `failed` only when
  final (§6.1 N1). `unverified` — including today's daemon outcome `failed` with cause
  `unconfirmed` (`packages/harness/src/driver/delivery-queue.ts:243-253`) — leaves the message
  where it is, for §5.4 to decide.
- **Readers of "delivered"** (chat bubble, retract, sender notices, `podium mail status`) mean
  `confirmed`; only producers that set it too early change. `accepted` needs a migration of the
  status column's allowed values.

## 5. Decided: matching a signal to our message

### 5.1 Three ways, strongest first

1. **Our id goes in and comes back.** For wrapped messages, only the id of the frame that opens the
   entry counts, with its matching end line; an id quoted inside a body never counts. (Today the
   server credits `podium message msg_…` anywhere in a user entry —
   `apps/server/src/modules/messages/service.ts:115, 2375-2396` — so a quoted id can confirm the
   wrong message: POD-4860.) For programs that store an id we give them, the program's echo of it.
2. **The program returns its own id for our call.** Exact while we keep that id (POD-4841).
3. **Order plus text** (§5.3). Only for unwrapped messages on programs that take no id from us.

Which way each program uses is open (§7), except where already *run* and built (Codex app-server
and Claude SDK take our id).

### 5.2 Only history written after the send

Before the first byte the daemon saves a **position** and the **time**. An entry counts only if it
lies after the position, or — where the history moved to another file or was re-read — carries a
timestamp at or after the saved time. The position is the history's extent at that instant as
the program's history reader defines it (for an append-only file: its length by `stat`, not how
far our reader has read); how each program defines it, and which timestamps it writes, is open
(§7). Today no floor exists, and a full re-read can let an older identical prompt confirm a new
send (`apps/daemon/src/runtime/terminal-driver.ts:1137-1146`; POD-4838).

### 5.3 Order plus text

**Idea.** The next prompt entry after our position is ours when nothing else can have produced
it; the text only has to agree.

**Foreign-write counter.** Every write into a terminal session passes through the daemon: on
podium-host sessions only the daemon holds the writer lease
(`packages/pty/vendor/podium-host/host.c:405-408, 486-491`), and a person's keystrokes from the
web, mobile and desktop terminals are relayed by it
(`apps/daemon/src/control/native-terminal-input.ts:33-36`). The daemon keeps one counter per
session, under the terminal write call, incremented by every foreign write (§2) and by any loss
of the writer lease (`host.c:602-614`). No Enter parsing: any foreign byte counts. The counter
only observes; it never blocks anything. It is saved with each message (§9).

**Rule**, for message M, with L the last prompt entry that lay before M's position:

- **Order credit** needs the counter unchanged from the moment L was written to the moment the
  daemon reads the first prompt entry E after M's position (reader lag is covered by taking the
  counter a bounded interval before L was read). Then E is ours if its text equals M within the
  program's proven tolerance → `confirmed`, matched by order. If the text does not agree, nothing
  is credited: M goes `unknown` and the self-check alarm records a gap.
- **Anything else gets no order credit**: the counter changed, the window spans a daemon restart,
  or the session runs on the abduco fallback, which anyone can type into unseen
  (`packages/pty/src/durable-process.ts:198-215`). Text alone never credits an unwrapped message;
  M waits for §5.4.

**Preconditions, per program** (§7): history order equals submit order; every prompt entry comes
from a submit (after the history reader drops entries nobody typed); what counts as a prompt
entry; the text tolerance; whether several submits can merge into one entry. Order credit is
switched on for a program only when these are *run*. Merged entries are not credited at all
unless merging is *run* for that program and the entry equals the open texts joined in order.

### 5.4 Late proof

A watch stays open after the proof window and moves the message forward when proof arrives
(POD-4840). It closes only after a maximum wait or when the history is rewritten across the
window; on closing, a `typed` or `accepted` message goes `unknown`. Wrapped messages already get
late proof from the server's id match (`service.ts:2375-2396`), once that match is bound to its
frame (§5.1).

### 5.5 Typing lock (optional optimization, after the core works)

The daemon may hold foreign writes to a session while one message is pasted and submitted, so a
person's keystrokes cannot land inside it. The core never depends on it. The lease is released
at whichever comes first: the typing finished plus a short settle, or a hard expiry of about
1–2 s on its own timer, so a typing step that never finishes still releases it. Held writes are
buffered with a size cap and flushed in order; a switch turns the lock off. A test pins the
release when the typing step never settles.

## 6. Decided: a proven "no"

### 6.1 What counts

| # | Evidence | Precondition per program (§7) | Cause |
|---|---|---|---|
| N1 | A **final** refusal: the message is dropped from every queue and will not be typed (`unsupported`, `session_ended`, `staging_failed`, `invalid_value`, an explicit drop). A temporary refusal (`busy`, `needs_user`, `lease_held`) changes nothing: the daemon retries it (`delivery-queue.ts:221-233`). POD-4839 checks every refusal path writes nothing before refusing. | — | `refused` |
| N2 | The program rejected the request in an explicit reply (a JSON-RPC error, an HTTP 4xx). A timeout or a dropped connection is not a reply. | An error reply means nothing was recorded. | `rejected-by-agent` |
| N3 | The program keeps our id or gave us its own, says through its own protocol that no turn is open, and its history has no item with that id. Needed only where the program does not deduplicate (§3.8). | "No turn open" means it holds no copy. | `not-recorded` |
| N4 | The program's process exited, and its history, read to the end after the exit, has nothing for the message after the position. | Nothing it held survives a resume. | `agent-exited` |

A message left in a terminal's input box is Phase D's (POD-4821): Phase D clears it, proves the
clear with an input fence (a probe written after our text, seen drawn after it in the same box,
then removed), and reports `not-submitted`. A screen reading alone is never a "no".

These add to the existing causes for a message never handed over (POD-4778).

### 6.2 What is not a "no"

The window passed; the agent looks idle with nothing new; the input box looks empty or still
shows our text; a timeout or a dropped connection; any agent-state reading. These leave the
message open, and later `unknown`.

### 6.3 Self-check alarm

The daemon logs, and the server records, an alarm when a `failed` message is later found by an
exact id match (the contradiction of §4), or when order matching meets a prompt entry the counter
did not explain (§5.3). It measures in the field whether §5.3 and §6.1 hold, also after a program
update.

## 7. Open: per-program facts and the decisions waiting on them

| Program · transport | *Run* | *Read* (to prove) | Decisions waiting |
|---|---|---|---|
| Claude Code · terminal | 2.1.284, idle / busy in a tool / busy in text (`docs/measurements/pod-4834-receipt-proof/README.md`): an idle submit has one new `prompt_id` on the `user` record (+71 ms) and `UserPromptSubmit` (+167 ms). A prompt entered while busy gets `queue-operation enqueue` at Enter and a `UserPromptSubmit` carrying the **running turn's** `prompt_id` (a turn id; the hook has no id for the prompt itself). Taken in at a tool boundary it becomes a `queued_command` attachment (own `uuid`, `source_uuid`, no `promptId`, `timestamp` = its Enter time) written at that moment, and reaches the model inside the next request's tool result (`claude-tui-2.1.284/rerun-eta-requests.json`). Run after the turn it gets a `user` record (timestamp = write time) with a new `promptId` and `promptSource: 'queued'`, and no `UserPromptSubmit`. | No hook fires at the model call (27 of 33 hook events not observed). The enqueue record is written before a blocking hook runs ([#96891](https://github.com/anthropics/claude-code/issues/96891)). `UserPromptSubmit` fires for messages nobody typed ([#94675](https://github.com/anthropics/claude-code/issues/94675)). Queued prompts may merge ([#53670](https://github.com/anthropics/claude-code/issues/53670), Desktop). Compaction summaries may reach the chat as user entries (no `isCompactSummary` filter in `packages/harness/src/adapters/claude-code/transcript.ts`). "Send now", Escape, interrupt, restart, text changes. | What sets `accepted` and `confirmed` for idle and queued prompts; §5.3 preconditions; how a queued prompt is matched (`source_uuid`, order); which of N2–N4 apply; our turn tracking for queued prompts (it opens a turn on every `UserPromptSubmit`). |
| Claude Code · SDK | 2.1.282 / 2.1.284 (POD-4836, `packages/harness/src/driver/families/claude-sdk/__fixtures__/user-message-ack.json`): `command_lifecycle` with our uuid ~60 ms after the write; the replay echo waits for the model's first output; a repeated uuid is skipped (also after resume); derived v5/v7 uuids recorded exactly. | Busy and steer; restart. | Built: our uuid, `accepted` on the lifecycle ack. Waiting: what sets `confirmed`; recovery by resend under the same id (§3.8). |
| Codex · app-server | 0.155.0 (POD-4835, `packages/harness/src/driver/families/codex/__fixtures__/client-message-id.json`): `clientUserMessageId` on `turn/start` / `turn/steer`, echoed as `clientId`; a repeated id makes a second turn; `thread/read` on a fresh app-server lists items with `clientId`; a steer is recorded at the next model call and, interrupted before it, dropped while we report it accepted (POD-4849). | Busy text, interrupt, restart, text changes. | Built: our id. Waiting: `accepted` on the reply, `confirmed` on the item; N3 via `thread/read` (no dedupe); POD-4849. |
| Codex · terminal | — | `UserPromptSubmit` hook (installed, carries `turn_id`); rollout record up to 5.7 s after Enter (POD-692, older version). | Everything. |
| Grok · ACP | — | `_x.ai/session/update` `hook_execution` (`user_prompt_submit`, `prompt_id`) and `x.ai/queue/changed` before its echo; a client-supplied `_meta.promptId` (Grok docs); fixture from 0.2.118, 1.0.44 installed. | POD-4837 (in progress). |
| Grok · terminal | — | Its hook (installed, unused); transcript echo. | Everything. |
| OpenCode · HTTP v2 | — | Admission under our id; a repeat returns the original (POD-4813 code comments, no evidence committed); a busy session queues the input. | Dedupe (§3.8); whether admission means stored; `confirmed` for a busy session. |
| OpenCode · HTTP v1 | — | `prompt_async` 204; the stored part carries our id; a repeat runs an empty turn (POD-4813). | Everything. |
| OpenCode · terminal, Cursor, Pi | — | Transcript echo only; Cursor cannot use a fake model server. | Everything; what cannot be measured is written down as such. |

## 8. Proof standard

- Ground truth for "the model got the prompt": a fake model server's request log, with full
  request bodies committed for every claim that rests on them.
- Every hook event the program has is logged; every protocol frame both ways with its time; every
  keystroke's time; the history file is read in file order (a record's timestamp is not its
  write time).
- Scratch config, dummy key, the fake server on localhost; never real credentials.
- Scenarios per program and transport: idle; busy in a tool; busy streaming text; interrupt; the
  same id twice; restart or resume; text changes; timestamps; foreign input during a send
  (terminals); Claude's "send now" and Escape.
- Evidence under `docs/measurements/pod-4834-receipt-proof/<program>-<version>/`. POD-4834 owns
  the grid; POD-4836 and POD-4837 feed it.

## 9. Restart: what this phase needs from daemon storage

Per message, on disk before the first byte and kept until it is settled: our id, the exact typed
text, the position and time (§5.2), the foreign-write counter (§5.3), the program's ids once
known, and the last status reached. After a restart the daemon watches again for every stored
message that is `typing`, `typed` or `accepted`, or `unknown` within the maximum wait, and the
normal history re-read matches them by id (§5.1); order credit is not given across a restart
(§5.3). Where the program deduplicates, recovery is a resend under the same id (§3.8).

## 10. Work

| Issue | What | State |
|---|---|---|
| POD-4834 | The measurement grid (§7, §8) | backlog, P1 |
| POD-4835 | Codex carries our id | done |
| POD-4836 | Claude SDK carries our id; accept on the lifecycle ack | done |
| POD-4837 | Grok ACP carries our id | in progress |
| POD-4838 | Only history after the send (§5.2) | backlog |
| POD-4839 | A final refusal ends as not delivered (N1) | backlog |
| POD-4840 | Late proof (§5.4) | backlog |
| POD-4841 | The program's ids stored with the message | backlog |
| POD-4844 | Bug: a failed system send lands in the person's input box | backlog |
| POD-4845 | Bug: low-priority mail stays `typed` | backlog |
| POD-4846 | Every sender travels as a message | done |
| POD-4849 | Bug: an interrupted Codex steer is reported delivered | backlog |
| POD-4851 | Draft Sync unsupported (Phase D) | backlog |
| POD-4853 | Hide auto-continue in chat | backlog |
| POD-4860 | Bug: a quoted id confirms another message (§5.1) | backlog |

To file once this spec is approved: the status list with `accepted` and `failed → confirmed` on an exact id (§4); the foreign-write
counter and the order rule (§5.3); N2–N4 as mechanisms (§6.1); the self-check alarm (§6.3).
Each open row of §7 becomes its own issue once its facts are *run*. The typing lock (§5.5) comes
after the counter works. Phase D gets the proven clear with an input fence (§6.1).

Noted: Claude's own queue and "send now" as Claude's steer (Phase C). Upstream: the queued-prompt
`prompt_id` behaviour may be worth reporting to Claude Code.

## 11. Review record

An independent first-principles review (Opus 5.5, 2026-09-29) of the previous version found, and
this version fixes: a temporary refusal counted as a "no" (N1); order credit blind to prompts
submitted before our position; a quoted id able to confirm the wrong message; an input log lost on
restart; `accepted` as a resting end state; a screen reading used as a "no"; `failed` never
correctable; decided rules resting on unproven program behaviour; a *run* claim without committed
evidence; wrong citations. It also simplified: a counter instead of an ordered input log, no
text-only credit, resend under the same id where the receiver deduplicates, the input-box "no"
moved to Phase D, and the watch closed only by time or a history rewrite.
