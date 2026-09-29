# POD-4819 — Harness receipt proof (Phase B of POD-4720)

Status: design for approval, 2026-09-29, on `issue/4720-acknowledged-message-delivery-chain`.
Measured on the real CLIs the same day (POD-4834: `docs/measurements/pod-4834-receipt-proof/grid.md`
and each lane's `results.md`); reviewed independently (§12); split from Phases C and D (§11).

## 0. How to read this spec

- **Decided** (§3–§6) does not depend on how any single agent program behaves. Where a mechanism
  needs a property of the program to be safe, the property is a **precondition**, and the
  mechanism is switched on for a program only where §7 shows the precondition *run*.
- **Per program** (§7) holds the measured facts and the **proposed decisions** built on them,
  for approval. What is still not measured stays open there.

A fact about an agent program is *run* (observed on the real CLI against a fake model server,
evidence committed under `docs/measurements/pod-4834-receipt-proof/`) or *read* (code, binary,
docs, upstream issues: a candidate only). Nothing is built on a *read* fact.

## 1. Goal

Know, for every message and every agent program, whether the message reached the agent's
conversation. Every message ends as delivered, not delivered, or `unknown`; `unknown` only when
neither can be known. Never a false yes, never a false no.

**The line with the other phases.** Phase B reads and interprets what the agent program reports,
and decides the status; it changes no byte we type. Phase D (POD-4821) controls what we write into
a terminal and what sits in its input box. Phase C (POD-4820) decides how a message is sent
(interrupt, steer, when idle) and whether a stored message gets a turn. The test: *does it change
what reaches the terminal, or when?* If yes, it is not Phase B. Phase B must give the right answer
however well or badly a message is typed. Handovers: §11. The daemon's durable storage is
POD-4766 / POD-4777, designed by the operator; §9 lists only what this phase needs from it.

## 2. Words

- **Agent program** — Claude Code, Codex, Grok, OpenCode, Cursor or Pi. **Transport** — its
  terminal (PTY), or a protocol (Claude SDK stream-json, Codex app-server, OpenCode HTTP v1/v2,
  Grok ACP).
- **Sender** — a person, an agent (mail) or the system; since POD-4846 all travel as messages with
  an id and a status.
- **Wrapped** — typed inside `[podium message <id> …] … [end podium message <id>]`
  (`apps/server/src/modules/messages/render.ts:135`), so our id is in the agent's own history.
  **Unwrapped** (no id in the text): a person's own words — their chat (`render.ts:187-211`) and
  their first prompt. Automations and auto-continue's "continue" get the frame in POD-4868.
- **Delivered** — in the agent's conversation history: the model reads it at its next step, and it
  survives a restart of the agent program. It does not promise a next step will happen: OpenCode
  stores a message sent while busy at once, and after an interrupt or a crash leaves it unanswered
  until another prompt starts a turn (*run*). Starting that turn is Phase C's.
- **Prompt entry** — a history entry that holds a message somebody sent. Each program's history
  reader defines it (§7); entries nobody typed (compaction summaries, slash-command records,
  interrupt markers, hook feedback, task notifications, text-less rows) are not prompt entries.
- **Foreign write** — any byte written into a terminal session that is not part of the message
  being typed (its paste, its Enter, its submit retries).

## 3. Decided: principles

1. **One id per message**, minted by the sender, carried to every hop (Phase A).
2. **Statuses move forward only**, one list for server, daemon and drivers (§4).
3. **A yes comes only from the agent program's own record** of the message. **A no comes only
   from direct evidence** (§6). Hooks, protocol replies and agent states are at most `accepted`;
   screen readings and agent states decide only *when to look*.
4. **Never guess.** When more than one message could match a signal, none is credited.
5. **A timer moves a message only to `unknown`**, never to `failed` or `confirmed`, and never a
   message the program holds durably (§4). Proof that arrives later still moves it forward.
6. **Only history written after the send can prove it** (§5.2).
7. **Bind by the strongest means the program offers** (§5.1).
8. **Resend under the same id only where the program ignores a repeat** (*run* per program, §7).
   There, recovery is a resend and no "no" has to be proven. Where a repeat runs twice (Codex,
   Grok), never resend automatically.
9. **Run, not read.** A fact holds for the program version it was run on. A newer version is not
   blocked (a version ceiling is only a "verified through" marker): it runs on the same rules, is
   marked not yet verified, is measured again, and the self-check alarm (§6.3) watches meanwhile.

## 4. Decided: statuses

| Status | Meaning |
|---|---|
| `stored` | The server has it. |
| `dispatched` | The server sent it toward the agent's machine. |
| `reached-machine` | The daemon saved it on its disk (POD-4777). |
| `typing` | The daemon saved "about to hand it over" just before the first keystroke or request; a retract loses from here (POD-4777). |
| `typed` | Handed over: the text and Enter written, or the request sent. |
| **`accepted`** (new) | The agent program took it but it is not yet in its history. |
| `confirmed` | In the agent's conversation history. **Delivered.** |
| `cancelled` | Retracted before `typing`. |
| `failed` + cause | Not in the conversation, by direct evidence (§6). Safe to resend. |
| `expired` | Never handed over within its time limit (only from `stored`). |
| `unknown` | Handed on (from `dispatched` to `accepted`), and no yes or no can be expected any more. Late proof moves it to `confirmed`; it may also still go `failed` or `cancelled` (`packages/model/src/entities/message-delivery.ts`). |

- **`accepted` comes in two kinds** (*run*). *Held in memory* — lost when the program exits:
  Claude's and Grok's terminal queues, a Codex steer, a line Claude SDK has queued. *Held durably*
  — survives a restart and may run later on its own: a Codex `thread/queue` item, an OpenCode v2
  admission. A message held in memory goes `unknown` when its watch closes (or `failed` by N4). A
  message held durably keeps its watch open and is re-checked in the program's pending queue; it
  never goes `unknown` by a timer.
- A status may be skipped when a program has no signal for it (several have no `accepted`, §7).
- New moves: `typed → accepted`; `accepted → confirmed | failed | unknown`; every move into
  `confirmed` from before `typed` may also go into `accepted`.
- **`failed → confirmed`, only on an exact id match** (our id, or the program's own id for our
  call), recorded as a contradiction that raises the self-check alarm (§6.3). This changes Phase
  A's final statuses: `failed` stays final for every other move.
- **Details, not statuses:** what proved it; how it was matched (our id, the program's id, order
  plus text); the transcript entry and the program's ids (POD-4774, POD-4841); the failure cause;
  the mode actually used; "accepted by the program" when an `accepted` message went `unknown`.
- **The driver speaks the same words**, by message id, at any time after `send()` returns:
  `typed`, `accepted`, `confirmed`, `refused`, `unverified`. `refused` becomes `failed` only when
  final (§6.1 N1). `unverified` — including today's daemon outcome `failed` with cause
  `unconfirmed` (`packages/harness/src/driver/delivery-queue.ts:243-253`) — leaves the message
  where it is.
- **Readers of "delivered"** (chat bubble, retract, sender notices, `podium mail status`) mean
  `confirmed`; only producers that set it too early change. `accepted` needs a migration of the
  status column's allowed values.

## 5. Decided: matching a signal to our message

### 5.1 Three ways, strongest first

1. **Our id goes in and comes back.** Exact, survives a restart. For wrapped messages only the id
   of the frame that opens the entry counts, with its matching end line (today any quoted
   `podium message msg_…` counts: POD-4860). Programs that store an id we give them: Claude SDK,
   Codex app-server, Grok ACP, OpenCode HTTP v1 and v2 (*run*, §7).
2. **The program returns its own id for our call.** Exact while we keep that id (POD-4841).
3. **Order plus text** (§5.3). Only for a person's own words on terminal programs, which take no
   id from us (*run*: Claude, Codex, Grok, OpenCode, Cursor terminals).

### 5.2 Only history written after the send

Before the first byte the daemon saves a **position** in the program's append-only history and the
**time**. Within one append-only history the position decides: an entry after it may be ours, an
entry before it never is. The time is used only when the history moved to another file or was
re-read. Timestamps inside one file do not decide: Claude writes records up to ~800 ms after their
`timestamp`, gives a queued prompt its enqueue time, and gives records written after a resume the
resume time (*run*); such an entry can lie after the position with an older time, and the order
rule (§5.3) decides whether it is ours. The position is the history's extent at that instant (an
append-only file's length by `stat`; OpenCode's row order or v2 sequence), not how far our reader
has read. Which history is append-only is per program (§7): Grok's is `updates.jsonl`, not
`chat_history.jsonl`, which Grok rewrites (*run*). Today no floor exists, and a full re-read can let
an older identical prompt confirm a new send (`apps/daemon/src/runtime/terminal-driver.ts:1137-1146`;
POD-4838).

### 5.3 Order plus text

Needed only for a person's own words typed into a terminal agent. **Operator decision
(2026-09-29): best effort.** No id is added to a person's words and no transport is forced for
chat; these messages end `confirmed` when the rule below can credit them, and `unknown` otherwise.
The rule must still never credit the wrong message.

**Idea.** The next prompt entry after our position is ours when nothing else can have produced
it; the text only has to agree.

**Foreign-write counter.** On podium-host sessions every write into the terminal passes through the
daemon: only the daemon holds the writer lease (`packages/pty/vendor/podium-host/host.c:405-408,
486-491`), and a person's keystrokes from the web, mobile and desktop terminals are relayed by it
(`apps/daemon/src/control/native-terminal-input.ts:33-36`). The daemon keeps one counter per
session, under the terminal write call, incremented by every foreign write and by any loss of the
writer lease (`host.c:602-616`). No Enter parsing. It only observes; it never blocks anything. It is
saved with each message (§9).

**Rule**, for message M, with L the last prompt entry before M's position:

- **Order credit** needs the counter unchanged from the moment L was written to the moment the
  daemon reads the first prompt entry E after M's position (reader lag covered by taking the
  counter a bounded interval before L was read). Then E is ours if its text equals M within the
  program's tolerance → `confirmed`, matched by order. If the text does not agree, nothing is
  credited: M goes `unknown` and the self-check alarm records a gap.
- **Anything else gets no order credit**: the counter changed, the window spans a daemon restart,
  or the session runs on the abduco fallback, which anyone can type into unseen
  (`packages/pty/src/durable-process.ts:198-215`). Text alone never credits. M waits for §5.4.
- **The window stays open** until the program's running tool call or text stream has ended: a
  message typed while busy is recorded only then (+6–10 s measured).

**Preconditions, per program** (§7): history order equals submit order; the prompt-entry
definition; the text tolerance; whether submits can merge. *Run* for the Claude, Codex, Grok and
OpenCode terminals: order holds for Enter submits (Codex breaks it only when its Tab queue is used,
a foreign write anyway); none of them merges submits into one entry.

### 5.4 Late proof

A watch stays open after the proof window and moves the message forward when proof arrives
(POD-4840). For a message not held durably it closes after a maximum wait or when the history is
rewritten across the window; on closing, a `typed` or in-memory `accepted` message goes `unknown`.
Wrapped messages get late proof from the server's id match (`apps/server/src/modules/messages/service.ts:2375-2396`),
once that match is bound to its frame (POD-4860).

### 5.5 Not in this phase

Preventing foreign writes while a message is typed (the typing lock) and never typing into a
non-empty input box are Phase D's (`docs/plans/pod-4821-phase-d-handoff.md`). Phase B only observes.

## 6. Decided: a proven "no"

### 6.1 What counts

| # | Evidence | Where *run* (§7) | Cause |
|---|---|---|---|
| N1 | A **final** refusal: the message is dropped from every queue and will not be typed (`unsupported`, `session_ended`, `staging_failed`, `invalid_value`, an explicit drop). A temporary refusal (`busy`, `needs_user`, `lease_held`) changes nothing: the daemon retries it (`delivery-queue.ts:221-233`). POD-4839 checks every refusal path writes nothing first. | every driver | `refused` |
| N2 | The program refused **our request** in an explicit reply that records nothing. **Not** a "no": a model error (the message stays recorded), OpenCode v2's 409 (means *already recorded*), a timeout or a dropped connection. | Codex app-server JSON-RPC errors; OpenCode v1/v2 400/404 | `rejected-by-agent` |
| N2b | The program recorded that it **dropped** the message. | Claude terminal: `queue-operation remove` with `reason: dropped_by_hook`, or a `blocked by hook` system record with no `user` record. Grok ACP: `turn_completed` cancelled, `HookDenied` | `dropped-by-agent` |
| N3 | The program keeps our id or gave us its own, says through its own protocol that no turn is open, and our id is neither in its history nor in any of its pending queues. Needed only where it does not ignore a repeat (§3.8). | Codex app-server: no turn open **and** our id not in `thread/queue/list` | `not-recorded` |
| N4 | The program's process exited, and its history, including durable pending queues, read to the end after the exit, has nothing for the message after the position. Records that only name a dead prompt (Grok's resume writes `turn_completed interrupted` for it) and text-less rows (OpenCode) count as nothing. N4 is about the conversation: the model may have seen the prompt once before the crash (Claude, *run*). | Claude, Codex terminal, Grok terminal (on `updates.jsonl`), OpenCode v1 and terminal. **Not** Codex app-server queue items or OpenCode v2 admissions: they survive | `agent-exited` |

A further "no", `not-submitted`, comes from Phase D when our text was left in a terminal's input box
and Phase D proved the clear (`docs/plans/pod-4821-phase-d-handoff.md`). These add to the existing
causes for a message never handed over (POD-4778).

### 6.2 What is not a "no"

The window passed; the agent looks idle with nothing new; the input box looks empty or still shows
our text; a timeout or a dropped connection; a model error; a 409 from OpenCode v2; any hook,
protocol reply or agent-state reading. These leave the message open, and later `unknown` (unless
held durably, §4).

### 6.3 Self-check alarm

The daemon logs, and the server records, an alarm when a `failed` message is later found by an
exact id match (§4), or when order matching meets a prompt entry the counter did not explain
(§5.3). It measures in the field whether §5.3 and §6.1 hold, also after a program update.

## 7. Per program: measured facts and proposed decisions

All *run* on 2026-09-29 unless marked; details, delays and evidence in
`docs/measurements/pod-4834-receipt-proof/grid.md` and the lane `results.md` files. "Not proof"
lists signals that look like proof and are not.

| Program · transport | Our id | `accepted` (proposed) | `confirmed` (proposed) | Proven "no" | Resend same id | Not proof |
|---|---|---|---|---|---|---|
| **Claude · terminal** 2.1.284 | No (text only) | `UserPromptSubmit` matching our message (idle: before the record; busy: at Enter with the *running* turn's `prompt_id`, sometimes deferred to take-in with its own); busy also `queue-operation enqueue` with our text | `user` record with `promptSource` `typed`/`queued`, or `queued_command` with `commandMode: prompt`, `origin.kind: human` (idle +157–824 ms) | N2b (`dropped_by_hook`, `blocked by hook`); N4 | — | the hook, `history.jsonl`, `enqueue`, the model answering |
| **Claude · SDK** 2.1.284 | Yes: line `uuid` | `command_lifecycle queued` with our uuid (+2–32 ms) | transcript record with `uuid` = ours, or `queued_command.source_uuid` = ours (+103–322 ms) | N4 | **Safe**: a repeat is skipped, a lost line resent runs once | `queued`/`started`, the replay echo, `cancelled`/`is_error` (an HTTP 400 left it recorded) |
| **Codex · app-server** 0.155.0 | Yes: `clientUserMessageId` on `turn/start`, `turn/steer`, `thread/queue/add` | `turn/start` reply when idle (a `turn/start` while busy is silently a steer returning the running turn's id); `turn/steer` reply (in memory, lost on interrupt, stop or kill: POD-4849); `thread/queue/add` reply (durable) | `item/completed userMessage` with `clientId` = ours (+213–239 ms) | N2 (JSON-RPC errors record nothing); N3 with the queue check | **Never**: every repeat runs again | the steer reply, `UserPromptSubmit` |
| **Codex · terminal** 0.155.0 | No (Codex mints a `client_id` only in the rollout) | none | rollout `item_completed` `UserMessage` (+189–384 ms) | N4 | — | `task_started`, `history.jsonl`, `UserPromptSubmit` (fires at the record, with the turn id) |
| **Grok · ACP** 1.0.44 | Yes: `session/prompt` `_meta.promptId`, kept as the turn id on every update | `_x.ai/queue/changed` naming ours (+3–22 ms warm) | `updates.jsonl` `user_message_chunk` (written before the model call; no `promptId`), bound by the driver at the turn's first output (POD-4837) | N2b (`HookDenied`) | **Never**: a repeat runs again; the driver checks the history first (POD-4837) | `hook_execution` (only with a hook configured), the reply (end of turn), a 402 error (recorded) |
| **Grok · terminal** 1.0.44 | No (session id only) | idle: `UserPromptSubmit` (+42–270 ms, Grok's `promptId`); busy: none — Grok's queue is invisible and lost on exit | `updates.jsonl` `user_message_chunk` (+115–464 ms), bound to `promptId` by the `hook_execution` record before it; not `hideFromScrollback` auto-wakes | N4 on `updates.jsonl` | — | the hook, `prompt_history.jsonl`, resume's `turn_completed interrupted`, anything in `chat_history.jsonl` |
| **OpenCode · HTTP v1** 1.18.33 | Yes: `messageID` and text part `id` | none (the 204 comes before storage: a kill after it lost the message) | the text part row with our part id (+39–395 ms warm), never the message row alone | N2 (400/404); N4 | **Only with both ids fixed and the same text** (another text overwrites the stored one) | the 204, a text-less message row |
| **OpenCode · HTTP v2** 1.18.33 | Yes: `id` | 200 admission (+24–105 ms; durable) | `session.next.prompted` and the user row (idle +66–105 ms; `queue`: at turn end; `steer`: at step end) | N2 (400/404) | **Safe with the same text** (another text → 409); a resend starts a stranded admission | the 409, the message list before `prompted` |
| **OpenCode · terminal** 1.18.33 | No (OpenCode mints every id) | none (stored at once, even when the screen says queued) | user message row with a text part (+27–227 ms) | N4 (a text-less row counts as nothing) | — | `prompt-history.jsonl`, a text-less row |
| **Cursor · terminal** 2026.07.23 | No | `beforeSubmitPrompt` (+282 ms) — also fires for a follow-up that never runs | **not measurable**: no fake model server; only with real credentials or `agent-cli-local` | — | — | the hook |
| **Pi** | not installed; nothing measured | | | | | |

**Order plus text, per terminal program** (§5.3, *run*):

| Program | Prompt entry | Text tolerance | Order = submit order |
|---|---|---|---|
| Claude | `user` with `promptSource` `typed`/`queued` (older CLIs write none), and the plain `/compact`-style record a built-in command writes with the words as typed; `queued_command` with `commandMode: prompt`, `origin.kind: human`. Never a prompt entry: the compaction summary (`isCompactSummary`), `<command-name>` and `<local-command-stdout>` records (the reader makes all three system notes, POD-4877), `isMeta` records (Stop-hook feedback, the command caveat, expansions), `promptSource: system` (task notifications), interrupt markers, tool results | tab → 4 spaces; CR/CRLF → LF; U+200B removed | yes (file order differs from event order around an Escape) |
| Codex | rollout `item_completed` `UserMessage` (never `response_item` role user; never expand `compacted.replacement_history`) | outer whitespace trimmed | yes for Enter submits |
| Grok | `updates.jsonl` `user_message_chunk`, not `hideFromScrollback`; `/loop` is recorded as its expansion | exact | yes |
| OpenCode | user message with a text part, not a command expansion, not a message sent over HTTP into the session | a paste gains a trailing space | yes |
| Cursor | not measurable | | |

**Still open** (`grid.md` §6): Cursor past the submit; Pi; Claude auto-compact and any version but
2.1.284; OpenCode attachments, auto-compaction, subagent notifications, permission prompts; Grok
terminal blocking hooks and `/loop` fires. Until run, those cases get no order credit and no
program-specific "no".

## 8. Proof standard

- Ground truth for "the model got the prompt": a fake model server's request log, with full request
  bodies committed for every claim that rests on them.
- Every hook event the program has is logged; every protocol frame both ways with its time; every
  keystroke's time; the history read in file order.
- Scratch config, dummy key, the fake server on localhost; never real credentials.
- Scenarios: idle; busy in a tool; busy streaming text; interrupt; the same id twice; restart or
  resume; model errors and explicit errors; text changes; timestamps; foreign input during a send.
- Evidence under `docs/measurements/pod-4834-receipt-proof/<program>-<version>/`, summarised in
  `grid.md`. A new program version is measured again with the same lanes.

## 9. Restart: what this phase needs from daemon storage

Per message, on disk before the first byte and kept until it is settled: our id, the exact typed
text, the position and time (§5.2), the foreign-write counter (§5.3), the program's ids once known,
and the last status reached. After a restart the daemon watches again for every stored message that
is `typing`, `typed` or `accepted`, or `unknown` within the maximum wait, and re-checks the program's
durable pending queues (Codex `thread/queue`, OpenCode v2 admissions). The normal history re-read
matches them by id (§5.1); order credit is not given across a restart. Where the program ignores a
repeat (§7), recovery is a resend under the same id.

## 10. Work

Done: POD-4834 (measurement grid, lanes POD-4862–4865), POD-4835, POD-4836, POD-4837, POD-4838,
POD-4839, POD-4840, POD-4844, POD-4845, POD-4846, POD-4849 (held receipts), POD-4853, POD-4860,
POD-4868, POD-4877. Running: POD-4841 (program ids on the message), POD-4875 (Grok history from
`updates.jsonl`).

To do (filed 2026-09-29; hard on Claude Code Opus 5.5 high, easy on Codex gpt-6.1-sol max):

| Issue | What | Size | Waits on |
|---|---|---|---|
| POD-4885 | The `accepted` status (model, storage, wire to clients, chat and CLI) | hard | — |
| POD-4886 | The daemon reports `accepted` to the server; `held: durable` | hard | POD-4885 |
| POD-4887 | Definite "not delivered" causes: N2b, N3, N4 | hard | — |
| POD-4888 | Foreign-write counter (§5.3) | hard | — |
| POD-4878 | Claude turn tracking for queued prompts | hard | — |
| POD-4889 | Claude SDK: confirmed on the transcript record | easy | — |
| POD-4890 | Grok ACP: confirmed on `updates.jsonl` | easy | — |
| POD-4891 | OpenCode v1: confirmed on the text part | easy | — |
| POD-4892 | OpenCode v2: durable `accepted`, confirmed on promotion, 409 | easy | POD-4876, POD-4886 |
| POD-4893 | Prompt entries in the Codex and OpenCode readers | easy | — |
| POD-4894 | Self-check alarm (first case) | easy | — |
| POD-4876 | Bug: the `opencode2` request body refused by 1.18.33 | easy | — |
| POD-4884 | Bug: a direct send's throw read as refused | easy | — |
| POD-4879 | Grok's missing `StopCancelled` hook | easy | — |

Held until the operator decides the proposed simplifications: the order-plus-text matching rule
(its anchor), and the terminal receipts per program (Claude, Codex, Grok, OpenCode terminals —
whether hooks stay in receipt proof). Also pending that decision, and not built by the issues
above: `failed → confirmed` on an exact id (POD-4885 keeps `failed` final; adding the move later
is small), and Codex `thread/queue` handling (Podium does not use that transport today).

Upstream: Claude's queued-prompt `prompt_id` behaviour may be worth reporting to Claude Code.

## 11. Handed to other phases

| To | What | Where |
|---|---|---|
| Phase D (POD-4821) | Only type into an empty input box; clear text left behind and prove the clear with an input fence (reported to B as `not-submitted`); what Escape, arrow-up and autocomplete put into the box; the typing lock as an optional, time-limited optimization; keep B's counter correct; Draft Sync unsupported (POD-4851, filed there). Measured since: Codex's Ctrl-C puts held messages back into the box joined by newlines; Cursor restores a failed prompt into the box | `docs/plans/pod-4821-phase-d-handoff.md` |
| Phase C (POD-4820) | Claude's own queue and "send now" as Claude's steer; Codex steer recorded at the next model call, and a busy `turn/start` silently steering; Codex's durable `thread/queue`; OpenCode v2 `queue`/`steer`; a stored OpenCode message left unanswered after an interrupt until something starts a turn; one meaning of delivered for every mode | `docs/plans/pod-4820-phase-c-handoff.md` |
| Phase A (POD-4818) | Nothing moves: wrapping automations and auto-continue (POD-4868) and the input-box bug (POD-4844) stay in B because they make B smaller | this spec, §10 |

## 12. Review record

An independent first-principles review (Opus 5.5, 2026-09-29) of an earlier version found, and this
version fixes: a temporary refusal counted as a "no"; order credit blind to prompts submitted before
our position; a quoted id able to confirm the wrong message (POD-4860); an input log lost on
restart; `accepted` as a resting end state; a screen reading used as a "no"; `failed` never
correctable; decided rules resting on unproven program behaviour; a *run* claim without committed
evidence; wrong citations. It simplified: a counter instead of an ordered input log, no text-only
credit, resend under the same id where the program ignores a repeat, the input-box "no" moved to
Phase D, the watch closed only by time or a history rewrite.

The measurements (POD-4834, 2026-09-29) then changed: a model error is not a "no"; OpenCode v2's
409 means already recorded; `accepted` held durably (Codex queue, OpenCode v2) does not go
`unknown` by a timer; within one history the position wins over timestamps; a program-recorded drop
is a "no" (N2b); hooks are at most `accepted` everywhere; and the README's Claude idle order (the
record written before the hook) was wrong — the hook comes first.
