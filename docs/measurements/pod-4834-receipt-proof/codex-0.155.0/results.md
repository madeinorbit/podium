# Codex 0.155.0 — what it reports when it takes a message (POD-4863)

Run 2026-09-29 on codex-cli 0.155.0 (`codex --version`), Linux x64, through the app-server
(`codex app-server`, JSON-RPC over stdio) and in its terminal UI. Every fact below is *run*
unless marked *read*. Phase B spec: `docs/plans/pod-4819-harness-receipt-proof.md`.

## Method

- **Ground truth** that the model got a message: `tools/fake-responses-server.ts`, a fake OpenAI
  Responses server on localhost. Each run's `model-requests.jsonl` has every request with its
  full `input` (Codex's own `instructions` and tool schemas replaced by length and hash). Markers
  in the last input item: `TOOLSLEEP` (one `exec_command` of `sleep 8`), `SLOWTEXT` (20 words over
  10 s, no tool call), `HTTP400` (an HTTP 400 reply), `TOOLBG` (a command that outlives its
  500 ms yield: a background terminal).
- **Scratch home**, dummy key, fake server only: `tools/setup-home.sh` writes `config.toml`
  (fake provider, `approval_policy = "never"`, the work directory trusted, `[features] hooks =
  true`) and a `hooks.json` with **all 11 hook events 0.155.0 knows** (`SessionStart`,
  `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`,
  `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop` — the event list is
  *read* from the binary's hook enum and matches the app-server's `HookEventName`, which also has
  `interrupt` with no hooks.json key). Each hook runs `tools/hooklog.sh`.
- **Hook trust.** The app-server ignores `--dangerously-bypass-hook-trust`: `hooks/list` showed
  all 11 hooks `trustStatus: "untrusted"` and none ran (*run*). `tools/trust-hooks.ts` therefore
  writes `[hooks.state."<key>"] trusted_hash` for our own logging hooks, using the hashes Codex
  reports, **in the scratch home only**.
- **History watcher** `tools/watch-history.ts` polls every 10 ms and logs, in file order with the
  time each line was first seen, every line of every rollout file and of `history.jsonl`, and
  every change of the durable queue table (`queue_1.sqlite` `queued_items`). Per run:
  `watch.jsonl`; the rollout files themselves: `rollout-N.jsonl`.
- **App-server**: `tools/appserver.ts` + `tools/as-scenarios.ts` log every JSON-RPC frame both
  ways with its time (`frames.jsonl`); `thread-reads.txt` summarises every `thread/read` and
  `thread/queue/list`.
- **Terminal**: `tools/tui.ts` + `tools/tui-scenarios.ts` drive the TUI in a 180×45 tmux pane
  (unique session name, killed at the end) with `tmux send-keys`; every key is a mark
  (`marks.jsonl`), screens at chosen moments in `screens.txt`, Codex's own prompt history
  `codex-history.jsonl`. A pause of 600 ms separates typed text from its Enter (an Enter inside a
  fast burst is taken as part of a paste — typing mechanics are Phase D's, not measured here).
- `timeline.txt` in every run merges all of it into one time order; **times are ms after the
  first send** (`send …` mark). Scripts: `bun tools/timeline.ts <scratch-run-dir>`.
- A SIGKILL goes to the **native** binary: `codex` is a Node wrapper, and killing the wrapper only
  closes the native process's stdin, which then shuts down gracefully (first attempt; rerun).

Ids: **ours** = Podium's `clientUserMessageId`; **Codex's** = ids Codex mints (turn id, item id,
queued-submission id, the TUI's per-submit `client_id`).

## App-server

POD-4835 (`packages/harness/src/driver/families/codex/__fixtures__/client-message-id.json`,
`turn-lifecycle.json`, `steer-interrupt.json`, and the comments in `capabilities.ts`) already
ran: `clientUserMessageId` on `turn/start` / `turn/steer` comes back as `clientId` on the
`userMessage` item; the same id on a second `turn/start` makes a second turn and the model sees
the words twice; the same id on a second `turn/steer` is recorded twice; `thread/read
{includeTurns}` on a fresh app-server lists every item with its `clientId`; a steer acked and then
interrupted before Codex's next model call is dropped. Those rows are marked 4835 below; every
other row is this run.

| Scenario | Signal | Delay after send | Id | Shows | Evidence |
|---|---|---|---|---|---|
| S1 idle `turn/start` | reply `{turn: {id, status: inProgress}}` | +6 … +26 | Codex's new turn id | accepted | `app-server/s3-steer/timeline.txt` (`our_busy`), `s3-turnstart` |
| | `turn/started` | +110 … +120 | turn id | accepted | same |
| | `UserPromptSubmit` hook (also `hook/started` / `hook/completed` notifications) | +179 … +206 | `turn_id` = the new turn; payload has **no** `clientId` | about to record (fires 8–38 ms *before* the record) | same, `hooks.jsonl` |
| | rollout `response_item` user message | +195 … +216 | Codex's `msg_…` id + `turn_id` in `internal_chat_message_metadata_passthrough` | confirmed | same, `rollout-1.jsonl` |
| | `item/started` / `item/completed` `userMessage` | +213 … +239 | **ours** as `clientId` + Codex's item id | confirmed | same, `frames.jsonl` |
| | rollout `event_msg` `item_completed` `UserMessage` | +217 … +238 | **ours** as `client_id` + item id + `turn_id` | confirmed (durable) | same |
| | model request | +275 | — | ground truth | `model-requests.jsonl` |
| S2 busy in a tool, `turn/steer` | 4835 | | | | `steer-interrupt.json` |
| S2 busy in a tool, `thread/queue/add` (experimental API) | reply `{queuedSubmission: {id, clientUserMessageId}}` + `thread/queue/changed` | +9 | **ours** + Codex's queued-submission id | accepted, **durable** (row in `queue_1.sqlite` with `client_id` at +35) | `app-server/s2-queue/` |
| | after the turn ends: `thread/queue/changed`, a **new** turn, `UserPromptSubmit` (new `turn_id`), `item/completed` with `clientId` = ours | +6 331 … +6 439 | ours + new turn id | confirmed | same |
| S3 busy streaming text, `turn/start` | reply with the **running** turn's id, `status: inProgress` — the call is silently a steer (`TurnStartParams`: "ignored when this request steers an already-active turn", *read*) | +2 | running turn id (not a new one) | accepted | `app-server/s3-turnstart/` |
| | nothing until the text stream ends; then `UserPromptSubmit` (running `turn_id`), rollout user message, `item/completed` `clientId` = ours | +8 033 … +8 095 | ours | confirmed | same |
| | model request containing it (the next call of the same turn) | +8 153 | — | ground truth | same |
| S3 busy text, `turn/steer` | reply `{turnId}` | +11 | running turn id | accepted | `app-server/s3-steer/` |
| | at the next model call: `UserPromptSubmit`, rollout user message, `item/completed` `clientId` = ours | +8 130 … +8 157 | ours | confirmed | same |
| S3 busy text, `thread/queue/add` | reply + durable row | +31 / +50 | ours + queued id | accepted, durable | `app-server/s3-queue/` |
| | after the turn: new turn, `UserPromptSubmit` (new `turn_id`), `item/completed` `clientId` = ours | +8 294 … +8 400 | ours | confirmed | same |
| S4 interrupt (text or tool), then send | `turn/interrupt` reply `{}`; rollout gets a **user-role** `<turn_aborted>` message and `event_msg turn_aborted`; `turn/completed status: interrupted` | +32 … +55 after the interrupt | turn id | — | `app-server/s4-text/`, `s4-tool/` |
| | the interrupted turn keeps its user item (`thread/read`: `interrupted`, `our_busy`) | | ours | confirmed stays confirmed | `thread-reads.txt` |
| | the tool process is not stopped: its `item/completed commandExecution` arrives 5.4 s after the interrupt, in the old turn | | | | `s4-tool/timeline.txt` |
| | the next `turn/start`: same signals as S1; the model request carries `<turn_aborted>` before it | | | | same |
| S4 with a queued item | the queued item is **held, not run**: `thread/queue/list` still lists it 10.7 s after the interrupt with the thread idle | | ours | accepted, held | `app-server/s4-queued/` |
| S5 same id twice | `turn/start`, `turn/steer`: 4835 (no dedupe) | | | | `client-message-id.json` |
| | `thread/queue/add` twice with one id: two queued submissions (two Codex ids), two turns, two items with the same `clientId`, the model sees the text twice | | ours ×2 | no dedupe | `app-server/s5-queue/` |
| S6 restart, settled turn (SIGTERM) | `thread/resume` + `thread/read` list the item with `clientId`; a new turn appends to the **same rollout file**, `ordinal` continuing | | ours survives | confirmed survives | `app-server/s6-settled/` |
| S6 restart with a steer acked and a queued item pending, **SIGTERM** | graceful stop aborts the turn (`<turn_aborted>` written); the acked steer is **lost** (in no item, never sent to the model); the queued item **survives and stays held** ≥ 6 s after resume, not run | | ours (queued) | steer: accepted → lost; queued: accepted, held | `app-server/s6-pending-term/` |
| S6 same, **SIGKILL** of the native process | no abort written; steer **lost**; queued item survives and is **started automatically** on `thread/resume` (+150 ms after the resume reply) as a new turn with `clientId` = ours; the killed turn reads `inProgress`, later `interrupted` | | ours | queued: confirmed after restart | `app-server/s6-pending-kill/` |
| S7 text | trailing spaces and newlines, CRLF, 3 blank lines, tab, 100 889 chars, NFD, ZWJ emoji, ZWSP, BOM, NBSP, BEL/ESC control chars, whitespace-only: **byte-identical** in `item/completed`, both rollout records and the model request | | | | `app-server/s7/` |
| S8 timestamps | see "Timestamps" below | | | | |
| S10 explicit error reply | `-32600` for unknown thread, steer with no active turn, malformed input, wrong `expectedTurnId`: none of those ids is anywhere in the rollout | +1 … +11 | — | nothing recorded | `app-server/s10-errors/` |
| S10 model error (HTTP 400) | `turn/start` accepted; user item **recorded** with `clientId` (+148); then `error` notification and `turn/completed status: failed` | | ours | **confirmed** although the turn failed | same |
| S10 SIGKILL right after the `turn/start` reply (+56 ms after it) | after resume the turn exists as `interrupted` with **no** user item; never sent to the model; not retried | | — | accepted → lost | `app-server/s10-kill-on-reply/` |
| S10 SIGKILL right after `item/completed` | the item survives with `clientId`, turn `interrupted` | | ours | confirmed survives | `app-server/s10-kill-on-item/` |

## Terminal (the TUI)

| Scenario | Signal | Delay after Enter | Id | Shows | Evidence |
|---|---|---|---|---|---|
| S1 idle | rollout `event_msg task_started` | +18 … +60 | Codex's new turn id | accepted (no text) | `tui/t-idle/`, `t-busy-tool/`, `t-busy-text/` |
| | `history.jsonl` line `{session_id, ts, text}` | +18 … +113 | none (session id only) | accepted, not proof (below) | `codex-history.jsonl`, `watch.jsonl` |
| | `SessionStart` hook — first submit only, not at launch; `source: startup` / `resume` / `compact` | +133 … +324 | session id | — | `hooks.jsonl` |
| | `UserPromptSubmit` hook (fields: `session_id`, `turn_id`, `cwd`, `transcript_path`, `hook_event_name`, `model`, `permission_mode`, `prompt`) | +166 … +358 | `turn_id` = the new turn; no `client_id` | about to record | same |
| | rollout `response_item` user message, then `item_completed` `UserMessage` | +189 … +384 | the TUI mints a random `client_id` (UUID v4) per submit + item id + `turn_id`; **no way to pass ours** | confirmed | `rollout-1.jsonl` |
| | model request | +485 | — | ground truth | `model-requests.jsonl` |
| | a second model request after every turn: "Generate a concise, single-line task title … User prompt: <text>" — carries the prompt text but is **not** a conversation entry | end of turn | — | — | `t-idle/model-requests.jsonl` #2 |
| S2 busy in a tool, Enter | `history.jsonl` line; screen "Messages to be submitted after next tool call" | +20 … +50 | none | accepted (held **in memory**, `queue_1.sqlite` never has a row) | `tui/t-busy-tool/` |
| | after the tool: `UserPromptSubmit` with the **running** `turn_id`, rollout user message, `item_completed` — one entry per held message, never merged, in submit order | +6 235 … +6 267 (GAMMA) | TUI `client_id` | confirmed | same |
| | model request (both held messages, next call of the running turn) | +6 378 | — | ground truth | same |
| S2 busy, **Tab** | nothing at Tab (no history line); screen "Queued follow-up inputs" | | | accepted, held in memory | same |
| | after the turn: new turn, `history.jsonl` line, `UserPromptSubmit` (new `turn_id`), rollout records | +4 114 … +4 165 | TUI `client_id` | confirmed | same |
| S3 busy streaming text, Enter | `history.jsonl` +37; after the stream ends: `UserPromptSubmit` (running `turn_id`) +8 066, rollout user message +8 089, model +8 215 | | | accepted → confirmed | `tui/t-busy-text/` |
| S3 busy text, Tab | new turn after the running one ends | +5 907 | | confirmed | same |
| S4 Escape while busy, one Enter-held + one Tab-queued message | `<turn_aborted>` user-role record +40; the held message is **re-submitted as a new turn** (+72: `task_started`, a **second** `history.jsonl` line for the same text; `UserPromptSubmit` new `turn_id` +136; rollout +149); then the queued one as the next turn (+339 … +392). Nothing lost, order kept. Screen: "Model interrupted to submit steer instructions." | | | confirmed | `tui/t-interrupt-tool/`, `t-interrupt-text/` |
| S5 same text twice (idle) | two turns, two `UserPromptSubmit`, two rollout entries, two different `client_id`s, two `history.jsonl` lines | | | no dedupe | `tui/t-idle/` |
| S6 quit (Ctrl-C ×3) with one held + one queued message | Ctrl-C 1 interrupts (`<turn_aborted>`); the held and the queued texts go **back into the input box joined by "\n"** (Ctrl-C 2 clears the box into one `history.jsonl` line holding both); neither reaches the conversation; `SessionEnd` on exit. `codex resume --last` re-sends nothing; screen "Conversation interrupted" | | | accepted → not delivered | `tui/t-restart-quit/` |
| S6 kill -9 with one held + one queued message | both **lost**; `history.jsonl` keeps the held text (written at Enter) although it never reached the conversation; resume appends to the same rollout, `SessionStart source: resume` | | | accepted → lost | `tui/t-restart-kill/` |
| S7 text | **leading and trailing whitespace trimmed** (a paste's trailing newline too); inner blank lines, indentation, tabs, NFD (`e`+U+0301), ZWJ emoji, ZWSP, NBSP kept; a 15 889-char paste shows as `[Pasted Content 15889 chars]` in the box and is recorded in full, exactly. The hook's `prompt`, both rollout records and `history.jsonl` hold the same (trimmed) text | | | | `tui/t-text/` |
| S9 order | Tab-queued P1 (submitted first) is recorded **after** the Enter-held D1 (submitted 0.9 s later): history order ≠ submit order | | | | `tui/t-order/` |
| S9 untyped user-role entries | `<turn_aborted>` (interrupt, also on a graceful exit), `<hook_prompt hook_run_id=…>reason</hook_prompt>` (a `Stop` hook's block reason; its `item_completed` item is `HookPrompt`, not `UserMessage`; no `UserPromptSubmit`), `<environment_context>` (first turn and after `/compact`). `/compact` writes a `compacted` record whose `replacement_history` repeats earlier user prompts ("ONE first") and adds the summary as a user-role message. `UserPromptSubmit` `additionalContext` becomes a **developer** message. `/status`: nothing. A background terminal finishing: nothing within 12 s | | | | `tui/t-untyped/`, `t-order/` |
| S10 model error (HTTP 400) | prompt recorded (`item_completed` `UserMessage`), `task_complete`, **no** `Stop` hook | +368 | | confirmed | `tui/t-errors/` |
| S10 kill -9 after the record (+511) | survives `resume --last` | | | confirmed survives | same |
| S10 kill -9 at +43, before the record | only `task_started` and a `history.jsonl` line; nothing after resume; never sent to the model | | | lost | `tui/t-kill-early/` |

Hooks that fired, over all runs: `SessionStart` 32, `UserPromptSubmit` 74, `PreToolUse` 12,
`PostToolUse` 5, `Stop` 54, `SessionEnd` 18, `PreCompact` 1, `PostCompact` 1 (`trigger: manual`).
Not observed: `PermissionRequest` (approval policy `never`), `SubagentStart`, `SubagentStop` (no
subagent). No hook fires at Enter while busy; `UserPromptSubmit` fires when the prompt is
recorded, with the turn it joins.

## Timestamps (S8)

- Rollout: every line has `timestamp` (ISO 8601 UTC, ms) and `ordinal` (0, 1, 2, … per file,
  contiguous, continued across resumes of the same thread). Over 799 lines of 27 runs the
  timestamp is the **write time**: first seen 5–14 ms later (p50 6 ms, p95 13–14 ms, max 92 ms;
  the few negative values, down to −11 ms, are clock/poll noise). Timestamps never decrease in
  file order. A held message's record carries its record time (+8 s), **not** its send time.
- `item_completed` has `started_at_ms` / `completed_at_ms` (ms); the user `response_item` has
  `create_time` (seconds with µs). `thread/read` turns: `startedAt` in **seconds**.
- `history.jsonl`: `ts` in **whole seconds**, write time; written at Enter for an Enter submit, at
  turn start for a Tab-queued one, and again for a held message Escape re-submits.

## CONTRADICTS OR EXTENDS THE SPEC

**§4 statuses.**
- App-server `accepted` has three sources with different lifetimes: the `turn/start` reply (idle:
  a new turn), the `turn/steer` reply and a `turn/start` sent while busy (both: held for the next
  model call, **lost** on interrupt, graceful stop or kill), and `thread/queue/add` (held
  **durably** in `queue_1.sqlite`, survives SIGTERM and SIGKILL, carries our id). `confirmed` is
  `item/completed userMessage` with `clientId` = ours, equal to the rollout `item_completed`
  `client_id`.
- **Extends:** a `turn/start` reply is not proof a new turn opened: sent while busy it returns the
  *running* turn's id and acts as a steer (run, S3). A driver that tracks turns by the reply is
  wrong then.
- **Extends:** an `accepted` queued message can stay held with no turn open — after an interrupt
  and after a graceful restart it is not run (≥ 10.7 s / ≥ 6 s observed) — and after a SIGKILL
  restart it runs on its own at `thread/resume`. So `accepted` → `unknown` by time is not the end
  for it; late proof (§5.4) must keep watching, and a resend could double it (no dedupe, S5).
- A model error does not undo `confirmed`: with HTTP 400 the message is recorded (S10).
- Terminal `accepted`: the only early signals are `task_started` (idle only; no text, no id of
  ours) and the `history.jsonl` line (no id; written for messages later lost, written twice for an
  Escape re-submit, written for box text cleared by Ctrl-C that was never submitted, not written
  at Tab). Neither is proof. `confirmed` = rollout `item_completed` `UserMessage`.

**§5.1 ways to match.**
- App-server: way 1 holds for `turn/start`, `turn/steer` and `thread/queue/add` (our id in, our
  id back on the item and in the rollout). `thread/queue/add` requires the id.
- Terminal: no way to pass our id. Codex mints a `client_id` per submit, but it is only in the
  rollout: the hook payload does not carry it and nothing returns it to the sender, so way 2 is
  not available. Wrapped messages keep our frame (text is kept exactly apart from outer
  whitespace); unwrapped ones need §5.3.
- `UserPromptSubmit` is not a proof hook: it fires 8–38 ms *before* the record, carries the turn
  id (the **running** turn's for a held message, like Claude's `prompt_id`), no id of the prompt
  itself.

**§5.2 position.** The rollout is append-only in every run, including resumes (same file,
`ordinal` continues), interrupts and `/compact` (a `compacted` record is appended; nothing is
rewritten). Each line's `ordinal` is a position, as is the file length by `stat`. Timestamps are
write times in ms, monotonic in file order. **Extends:** `compacted.replacement_history` repeats
older user prompts; a reader that expands it would see an older identical prompt as new.

**§5.3 preconditions (terminal).**
- History order = submit order: **no** when a Tab-queued message is involved (S9: P1 then D1
  submitted, D1 then P1 recorded). Yes for Enter-only submits in all runs, including Escape
  re-submits.
- Every prompt entry comes from a submit: **yes** if a prompt entry is `item_completed` with
  `item.type == "UserMessage"` (what `packages/harness/src/adapters/codex/transcript.ts` reads);
  **no** for `response_item` role `user` (`<turn_aborted>`, `<hook_prompt>`,
  `<environment_context>`).
- Text tolerance: leading and trailing whitespace trimmed; everything else exact.
- Merging: never in the rollout (held messages become one entry each). But Ctrl-C returns held
  and queued texts to the input box joined by `"\n"`; submitted again, they would be one entry
  holding several messages (the join is *run* only in `history.jsonl`).
- A message typed while busy is recorded when the running tool call or text stream ends (+6 s,
  +8 s here): the order window has to stay open that long.

**§6.1 N2–N4 preconditions.**
- N2 (app-server): **holds** for JSON-RPC errors (four kinds, nothing recorded). A failed turn
  (model error) is not an N2 "no": the message was recorded.
- N3 (app-server, "no turn open means no copy"): **does not hold** with the queue. With no turn
  open, `thread/queue/list` can still hold our id, and it may run later (after a SIGKILL
  restart). N3 needs "no turn open **and** our id not in `thread/queue/list`". For steers it holds
  (a steer is dropped once its turn ends without another model call: 4835, S6).
- N4 ("nothing it held survives a resume"): **app-server: does not hold** for queued items (they
  survive and may run). Steers and a message killed before its record: nothing survives.
  **Terminal: holds** in these runs — held and Tab-queued inputs do not survive a kill or a quit
  (the TUI queue is in memory; `queue_1.sqlite` stays empty) and a message killed before its
  record leaves only `task_started`. On a Ctrl-C quit the texts go back into the input box first
  (Phase D's concern).

**§7 row "Codex · app-server"**: *run* now also: busy text (a `turn/start` while busy is a steer,
recorded at the next model call +8 s), interrupt (`<turn_aborted>`, user item kept, queue held),
restart (acked steers lost, queued items survive; SIGKILL resume auto-runs them), text changes
(none), timestamps, explicit errors (nothing recorded), model error (recorded), kill right after
the reply (lost, empty interrupted turn). New transport to decide on: the experimental
`thread/queue/*` API (durable, our id, no dedupe).

**§7 row "Codex · terminal"**: *run* now: everything in the terminal table. `UserPromptSubmit`
fires for every typed prompt when it is recorded (not at Enter while busy), with a turn id, no
prompt id; rollout records carry a Codex-minted `client_id`; the TUI's Enter-while-busy queue
("messages to be submitted after next tool call") joins the running turn, its Tab queue runs as
the next turn, both only in memory; Escape re-submits held messages (unlike the app-server's
dropped steer, POD-4849).


## Expanded input rerun (2026-09-30, POD-4984)

The installed CLI advanced to **0.159.0**; the new measurements are versioned in
[Codex 0.159.0 results](../codex-0.159.0/results.md). They cover 2/10/200 lines,
1/16/100 KiB, tabs, CRLF and final LF, each plain and framed, through app-server,
bracketed terminal paste, unbracketed input, and a separately labelled startup argument.
The app-server keeps every input byte and our id. Terminal CRLF/tab changes need
POD-5003; long unbracketed editor observations are bounded pending-input results.
These new facts do not retroactively change this file's 0.155.0 timing/version pin.
