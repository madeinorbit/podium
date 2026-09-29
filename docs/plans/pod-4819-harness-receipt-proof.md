# POD-4819 — Harness receipt proof (Phase B of POD-4720)

Status: design for review, 2026-09-29, on `issue/4720-acknowledged-message-delivery-chain` at
`ce444f3f1`.

## 0. How to read this spec

It has two kinds of content.

- **Decided** (§3–§6) does not depend on how any agent program behaves. It can be built now.
- **Open** (§7) depends on how an agent program behaves. Nothing open is built until every fact
  it depends on is *run*, and the decision is then written into §7.

Every fact about an agent program is labelled:

- *run* — observed on the real CLI by the method in §8, with its evidence committed;
- *read* — taken from code, a compiled binary, docs or an upstream issue. A candidate only.

## 1. Goal

Know, for every message and every agent program, whether the message reached the agent's
conversation. End with a yes or a no in almost every case, and with `unknown` only when neither
can be known. Never a false yes, never a false no.

Not in this phase: how a message is typed into a terminal and never leaving text in the input
box (Phase D, POD-4821); which delivery modes exist and their time limits (Phase C, POD-4820);
the daemon's durable storage (POD-4766 / POD-4777, designed by the operator; §9 lists only what
this phase needs from it).

## 2. Words

- **Agent program** — Claude Code, Codex, Grok, OpenCode, Cursor or Pi. **Transport** — how we
  talk to it: its terminal (PTY), or a protocol (Claude SDK stream-json, Codex app-server,
  OpenCode HTTP v1/v2, Grok ACP).
- **Delivery mode** — when a message is typed: `when-ready`, `queue`, `interrupt`, `steer`,
  `at-boundary` (`packages/harness/src/driver/turns.ts:21`). The stored message path uses
  `when-ready` and `interrupt` today.
- **Sender** — a person, an agent (mail) or the system. Since POD-4846 every sender travels as a
  message with an id and a status.
- **Wrapped** — typed inside `[podium message <id> …] … [end podium message <id>]`
  (`apps/server/src/modules/messages/render.ts:135`), so our id is in the agent's own history.
  **Unwrapped** (no id in the text): a person's chat (`render.ts:187-211`), the owner's first
  prompt, automations, and auto-continue's "continue" (POD-4846).
- **Delivered** — the message is in the agent's conversation history: the model reads it at its
  next step, and it survives a restart of the agent program. What the model then does with it is
  not a delivery status.

## 3. Decided: principles

1. **One id per message**, minted by the sender and carried to every hop (Phase A).
2. **A status only moves forward**, and one status list is shared by server, daemon and drivers
   (§4).
3. **A yes comes only from the agent program's own record** of the message: its reply, its hook,
   its history entry. **A no comes only from direct evidence** (§6). Agent states (idle,
   working, an input-box reading) decide only *when to look*; a wrong state then costs time,
   never a wrong status.
4. **Never guess.** When more than one message could match a signal, none is credited.
5. **A time window decides only what the user is shown.** Proof that arrives later still moves
   the message forward.
6. **Only history written after the send can prove it** (§5.2).
7. **Bind by the strongest means the program offers:** our id carried by the program and given
   back, then the program's own id returned for our call, then order plus text (§5.1).
8. **Run, not read** (§0, §8). A fact is proven for one program version. A newer version is not
   blocked (a version ceiling is only a "verified through" marker): it runs on the same rules,
   is marked not yet verified, the grid is run again for it, and the self-check alarm (§6.3)
   catches drift in the field meanwhile.

## 4. Decided: statuses

One list. A status may be skipped when a program has no signal for it; the message then moves to
the strongest status that is known.

| Status | Meaning |
|---|---|
| `stored` | The server has it. |
| `dispatched` | The server sent it toward the agent's machine. |
| `reached-machine` | The daemon saved it on its disk (POD-4777). |
| `typing` | The daemon saved "about to hand it over", just before the first keystroke or request. A retract loses from here (POD-4777). |
| `typed` | Handed over: the text and Enter were written, or the request was sent. |
| **`accepted`** (new) | The agent program took it, but may still hold it (its own queue, a steer waiting for the next model step). |
| `confirmed` | In the agent's conversation history. **This is "delivered".** |
| `cancelled` | Retracted before `typing`. |
| `failed` + cause | Definitely not in the conversation (§6). Safe to resend. |
| `expired` | Never handed over within its time limit (only from `stored`). |
| `unknown` | Typed, and no yes or no can be expected any more. Late proof still moves it to `confirmed`. |

- New moves: `typed → accepted`; `accepted → confirmed | failed | unknown`; every move that enters
  `confirmed` from before `typed` may also enter `accepted`. `unknown → confirmed` exists.
- A message that reached `accepted` rests there if no history entry is ever found: the program
  said it took the message, so it is not `unknown`.
- **Details kept with the message, not statuses:** what proved it (the program's reply, a hook, a
  history entry); how it was matched (our id, the program's id, order plus text) and *merged*
  when our text sat inside a larger entry; the transcript entry and the program's own ids
  (POD-4774, POD-4841); the failure cause; the mode actually used.
- **The driver speaks the same words.** It reports, by message id and at any time after `send()`
  returns: `typed`, `accepted`, `confirmed`, `refused` (becomes `failed`, §6), or `unverified`
  (the message stays where it is; §5.4 and §6.3 decide what follows).
- **Readers of "delivered"** (the chat bubble, retract, sender notices, `podium mail status`)
  already mean "the agent has it", which is `confirmed`; only producers that set it too early
  change. `accepted` needs a migration of the status column's allowed values.

What sets `accepted` and `confirmed` for each program is open (§7).

## 5. Decided: matching a signal to our message

### 5.1 Three ways, strongest first

1. **Our id goes in and comes back.** Exact, survives a restart, survives merged text. Every
   wrapped message on every program; and programs that store an id we give them.
2. **The program returns its own id for our call.** Exact while we keep that id (POD-4841).
3. **Order plus text** (§5.3). Only for unwrapped messages on programs that take no id from us.

Which way each program uses is open (§7), except where it is already *run* and built (Codex
app-server and Claude SDK take our id).

### 5.2 Only history written after the send

Before the first byte, the daemon saves the history position (file and byte offset) and the
time. An entry counts only if it lies after that position in the same file, or, in another file
(resume, rotation, full re-read), carries a timestamp at or after the saved time. Today no floor
exists, and a full re-read can let an older identical prompt confirm a new send
(`apps/daemon/src/runtime/terminal-driver.ts:1137-1146`; POD-4838). Which timestamps each program
writes, and what they mean, is open (§7): Claude's queued-prompt record carries its Enter time,
not its write time (*run*).

### 5.3 Order plus text

**Idea.** The first *prompt entry* after our position is ours if nobody else submitted anything in
between; the text then only has to agree.

**The input log (the core; it only observes, it never blocks).** Every write into a terminal
session passes through the daemon: on podium-host sessions only the daemon holds the writer
lease (`packages/pty/vendor/podium-host/host.c:405-408, 486-491`), and a person's keystrokes from
the web, mobile and desktop terminals are relayed by the daemon
(`apps/daemon/src/control/native-terminal-input.ts:33-36`). Today nothing records those writes in
one place: menu answers, interrupt keys, the Ctrl-U clear after an interrupt, the Ctrl-L redraw
and a person's keystrokes all go around the delivery queue. The daemon keeps one ordered log per
session, under the terminal write call, with every write, its origin and every Enter. Draft Sync,
the one other Podium writer, is switched off (POD-4851). Sessions on the abduco fallback can be
typed into unseen (`packages/pty/src/durable-process.ts:198-215`) and never use order.

**Rule**, for message M and the first prompt entry E after M's position (M's own Enter and
retries are not "another Enter"; the log is read up to the moment E is read):

| Another Enter in the log between M and E? | E's text | Result |
|---|---|---|
| No | equals M | `confirmed`, by order |
| No | contains M | `confirmed`, by order, *merged* |
| No | neither | Nothing credited; M goes `unknown`; the self-check alarm records a gap |
| Yes | — | Text only: the first prompt entry equal to M (or containing it, *merged*); if two open messages have the same text, none is credited |

What counts as a *prompt entry*, what "equals" tolerates, and whether a program merges several
queued prompts into one entry are open per program (§7). The history readers today report some
entries nobody typed as `user` (Claude compaction summaries and slash-command records,
`packages/harness/src/adapters/claude-code/transcript.ts:320-332`; interrupt markers in Claude,
Codex and OpenCode).

### 5.4 Late proof

A watch stays open after the proof window and moves the message forward when proof arrives
(POD-4840). It closes when a later prompt entry that is not ours appears after the position and
our text is not in the input box, after a maximum wait, or when the history is rewritten across
the window. On closing, a `typed` message goes `unknown`; an `accepted` one stays `accepted`
(§4). Wrapped messages already get this from the server's id match
(`apps/server/src/modules/messages/service.ts:2269-2299`).

### 5.5 Typing lock (optional optimization, built after the core works)

The daemon may hold other writes to a session while one message is pasted and submitted, so a
person's keystrokes cannot land inside it. The core never depends on it. Constraints: a lease
with a hard expiry of about 1–2 s on its own timer, never released by the typing finishing;
held writes buffered with a size cap and flushed in order; covering only the paste, the Enter and
a short settle; a switch to turn it off. A test pins that a typing step that never settles still
releases the lease and lets the next message through.

## 6. Decided: a proven "no"

### 6.1 What counts

| # | Evidence | Cause |
|---|---|---|
| N1 | The driver refused before writing anything (a refusal is by contract a reply that nothing was written; POD-4839 audits every refusal path). | `refused` |
| N2 | The program rejected the request in an explicit reply (a JSON-RPC error, an HTTP 4xx). A timeout or a dropped connection is not a reply. | `rejected-by-agent` |
| N3 | The program keeps our id or gave us its own, says through its own protocol that no turn is open, and its history has no item with that id. | `not-recorded` |
| N4 | The program's process exited, and its history, read to the end after the exit, has nothing for the message after the position. | `agent-exited` |
| N5 | Terminal: after Enter and the submit retries, the input box shows exactly our text, the history has nothing after the position, the input log shows nobody else typed, and the daemon cleared the box and a second screen read shows it empty (the clear is Phase D's). | `not-submitted` |

These add to the existing causes for a message never handed over (POD-4778). Which of N2–N5 each
program can produce is open (§7).

### 6.2 What is not a "no"

The window passed; the agent looks idle with nothing new in its history; the input box is empty
with nothing in the history; a timeout or a dropped connection; anything read only from an agent
state. These leave the message open, and later `unknown`.

### 6.3 Self-check alarm

The daemon logs, and the server records, an alarm when a `failed` message later appears in the
agent's history, or when order matching finds a prompt entry the input log did not see. It
measures whether §5.3 and §6.1 hold in the field, including after a program update.

## 7. Open: per-program facts and the decisions waiting on them

"Decisions waiting" are built only when all their facts are *run*.

| Program · transport | *Run* | *Read* (to prove) | Decisions waiting |
|---|---|---|---|
| Claude Code · terminal | 2.1.284, idle / busy in a tool / busy in text (`docs/measurements/pod-4834-receipt-proof/README.md`): idle submit has one new `prompt_id` on the `user` record (+71 ms) and `UserPromptSubmit` (+167 ms); a prompt entered while busy gets a `queue-operation enqueue` at Enter and a `UserPromptSubmit` carrying the **running turn's** `prompt_id` (it is a turn id; the hook payload has no id for the prompt itself); taken in at a tool boundary it becomes a `queued_command` attachment (own `uuid`, `source_uuid`, no `promptId`) written at that moment, and reaches the model inside the next tool result; run after the turn it gets a `user` record with a new `promptId` and `promptSource: 'queued'`, and no `UserPromptSubmit`. | No hook fires at the model call (27 of 33 hook events not observed). The enqueue record is written before a blocking hook runs ([#96891](https://github.com/anthropics/claude-code/issues/96891)). `UserPromptSubmit` also fires for messages nobody typed, without a marker ([#94675](https://github.com/anthropics/claude-code/issues/94675)). Queued prompts may be merged into one message ([#53670](https://github.com/anthropics/claude-code/issues/53670), Desktop). "Send now", Escape with queued prompts, interrupt, restart, text changes. | What sets `accepted` and `confirmed` for idle and for queued prompts; how a queued prompt is matched (`source_uuid`, order plus text); prompt entries and text tolerance; which N-causes apply; how our turn tracking handles queued prompts (it opens a turn on every `UserPromptSubmit`, `state-provider.ts`). |
| Claude Code · SDK | 2.1.282 / 2.1.284 (POD-4836, `claude-sdk/__fixtures__/user-message-ack.json`): `command_lifecycle` with our uuid ~60 ms after the write; the replay echo waits for the model's first output; a repeated uuid is skipped (also after resume); derived v5/v7 uuids recorded exactly. | Busy and steer behaviour; restart. | Built: our uuid, `accepted` on the lifecycle ack. Waiting: what sets `confirmed`. |
| Codex · app-server | 0.155.0 (POD-4835, `codex/__fixtures__/client-message-id.json`): `clientUserMessageId` on `turn/start` and `turn/steer`, echoed as `clientId`; a repeated id makes a second turn; `thread/read` on a fresh app-server lists items with `clientId`; a steer is recorded at the next model call and, interrupted before it, dropped while we report it accepted (POD-4849). | Busy text, interrupt, restart, text changes. | Built: our id. Waiting: `accepted` on the reply and `confirmed` on the item; N3 via `thread/read`; POD-4849. |
| Codex · terminal | — | Its `UserPromptSubmit` hook (installed, carries `turn_id`); rollout record up to 5.7 s after Enter (POD-692, older version). | Everything. |
| Grok · ACP | — | Before its echo, `_x.ai/session/update` `hook_execution` (`user_prompt_submit`, `prompt_id`) and `x.ai/queue/changed`; a client-supplied `_meta.promptId` (Grok docs); ACP `messageId` unused; our fixture is from 0.2.118, 1.0.44 installed. | POD-4837 (in progress): our id, `accepted`, `confirmed`. |
| Grok · terminal | — | Its hook (installed, unused); transcript echo. | Everything. |
| OpenCode · HTTP v2 | — | Admission under our id, a repeat returns the original (POD-4813 code comments say measured on beta-18866; no evidence committed); a busy session queues the input (`delivery: 'queue'`). | Whether admission means stored; what sets `confirmed` for a busy session. |
| OpenCode · HTTP v1 | — | `prompt_async` 204; the stored part carries our id. | Everything. |
| OpenCode · terminal, Cursor, Pi | — | Transcript echo only; Cursor cannot use a fake model server. | Everything; what cannot be measured is written down as such. |

## 8. Proof standard

- The ground truth for "the model got the prompt" is a fake model server's request log.
- Every hook event the program has is logged, every protocol frame both ways with its time, every
  keystroke's time; the history file is read in file order.
- Scratch config, dummy key, the fake server on localhost; never real credentials.
- Scenarios for each program and transport: idle; busy in a tool; busy streaming text; interrupt;
  the same id twice; restart or resume; text changes; timestamps; the input box (terminals);
  Claude's "send now" and Escape.
- Evidence is committed under `docs/measurements/pod-4834-receipt-proof/<program>-<version>/`,
  with the program version. POD-4834 owns the grid; POD-4836 and POD-4837 feed it.

## 9. Restart: what this phase needs from daemon storage

Per message, on disk before the first byte and kept until it is settled: our id, the exact typed
text, the position and time (§5.2), the program's ids once known, and the last status reached.
With them, recovery needs no new driver call: after a restart the daemon watches again for every
stored message still `typing`, `typed` or `accepted`, and the normal history re-read matches
them (§5). Without them, a message typed before a crash stays `unknown`.

## 10. Work

| Issue | What | State |
|---|---|---|
| POD-4834 | The measurement grid (§7, §8) | backlog, P1 |
| POD-4835 | Codex carries our id | done |
| POD-4836 | Claude SDK carries our id; accept on the lifecycle ack | done |
| POD-4837 | Grok ACP carries our id | in progress |
| POD-4838 | Only history after the send (§5.2) | backlog |
| POD-4839 | A refusal ends as not delivered (N1) | backlog |
| POD-4840 | Late proof (§5.4) | backlog |
| POD-4841 | The program's ids stored with the message | backlog |
| POD-4844 | Bug: a failed system send lands in the person's input box | backlog |
| POD-4845 | Bug: low-priority mail stays `typed` | backlog |
| POD-4846 | Every sender travels as a message | done |
| POD-4849 | Bug: an interrupted Codex steer is reported delivered | backlog |
| POD-4851 | Draft Sync unsupported (Phase D) | backlog |
| POD-4853 | Hide auto-continue in chat | backlog |

To file once this spec is approved (decided parts only): the status list with `accepted` (§4);
the input log and the order-plus-text rule (§5.3); the proven "no" N2–N5 as a mechanism (§6.1);
the self-check alarm (§6.3). Each open row of §7 becomes its own issue once its facts are *run*.
The typing lock (§5.5) is filed after the input log works.

Noted for other phases: Claude's own queue and "send now" as Claude's steer (Phase C); only type
into an empty input box, and clear what was left behind (Phase D). Upstream: the queued-prompt
`prompt_id` behaviour (§7, Claude terminal) may be worth reporting to Claude Code.
