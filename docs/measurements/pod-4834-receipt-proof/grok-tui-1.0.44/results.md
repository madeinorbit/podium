# Grok 1.0.44 terminal UI — what it reports when it takes a prompt (run 2026-09-29, POD-4865)

Everything below is **run** unless marked *read*. Grok ACP is measured separately (POD-4837,
`../grok-acp-1.0.44/` and its section in `../README.md`). The two agree where they overlap:
`updates.jsonl`'s `user_message_chunk` has `promptIndex` and an event id but no `promptId`; the
prompt is recorded after the `UserPromptSubmit` hooks and before the model call; an error reply
from the model still leaves the prompt recorded. The difference: ACP takes our id
(`_meta.promptId`) and acks the queue at once; the terminal takes no id and shows nothing for a
queued prompt. Ground truth for "the model got it" is the fake model server's request log.

## Setup

- `grok 1.0.44 (5b807183dd79)`, TUI in a 180×45 tmux pane, driven with `tmux send-keys`
  (multi-line, long and unicode text by bracketed paste: `tmux paste-buffer -p`).
- Scratch `HOME` and `GROK_HOME`; `config.toml` has `[model.fake] base_url = http://127.0.0.1:47361/v1`,
  `env_key = FAKE_KEY` (value `dummy-not-a-key`), `[models] default = "fake"`. Flags
  `-m fake --always-approve --trust`. No real credentials; every model request went to the local fake.
- Fake model: `fake-openai-chat-server.ts` (OpenAI chat-completions SSE, the wire Grok uses for a
  custom model). `TOOLSLEEP` → a `run_terminal_command` `sleep 8` call; `SLOWTEXT` → 20 words in
  10 s; `ERRORNOW` → HTTP 400; a compaction prompt → a `<summary>` block. Every request is logged
  with its full non-system messages (`raw/model-requests.jsonl`; messages over 1 000 characters that
  are not a `<user_query>` are trimmed).
- Hooks: `~/.grok/hooks/log-all.json` registers `hooklog.sh` for **all 15 documented events**
  (SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure,
  PermissionDenied, Stop, StopFailure, StopCancelled, Notification, SubagentStart, SubagentStop,
  PreCompact, PostCompact; the list is Grok's `docs/user-guide/10-hooks.md`, and the binary's strings
  hold no other event name — *read*). Podium's own installed file (`hooks/podium.json`, copied from
  this machine, 14 events) ran next to it with `PODIUM_GROK_HOOK_URL` pointing at the fake
  (`raw/podium-hook.jsonl`).
- `file-watch.ts` polls every file under `GROK_HOME/sessions` every 20 ms and logs each new line in
  file order with the time it was first seen; from 18:14:30 local time on (the second watcher, first used for S4) it also
  detects a rewritten file (content before the old end changed, or a new inode)
  (`raw/session-files-observed.jsonl`, field `watcher`). `timeline.py raw <label>` merges keys,
  hooks, model requests and file records; `timelines/*.txt` are its output per scenario.
- `session-files/` holds the session's final `updates.jsonl`, `events.jsonl`,
  `rewind_points.jsonl`, `btw_history.jsonl`, `prompt_history.jsonl` and `chat_history.final.jsonl`
  (system prompt and injected reminders trimmed).

Times are milliseconds after the prompt's Enter. Delays for an idle prompt are over 23 idle submits.

## Where Grok records a prompt

| Signal | Where | Ids | Delay (idle, min / median / max) | Means |
|---|---|---|---|---|
| `prompt_history.jsonl` line | `sessions/<cwd>/prompt_history.jsonl` (per directory) | `session_id`; no prompt id | 31 / 53 / 239 | Grok started a turn for it. Text is trimmed. Also written for prompts that never reached the conversation (kill at +41 and +75 ms). **Not** proof. |
| `events.jsonl` `turn_started` | session dir | `turn_number`, no prompt id | 31 / 68 / 239 | Same moment as `prompt_history`. |
| **`UserPromptSubmit` hook** | hook stdin | `promptId` — **Grok's own new UUID per turn** — plus `sessionId`, `prompt` (exact text), `transcriptPath` (= `updates.jsonl`) | 42 / 82 / 270 | **accepted**: Grok took it. Fired for a prompt that was then lost (kill at +75 ms). |
| Podium's installed hook | `PODIUM_GROK_HOOK_URL` | same `promptId` | 87 / 139 / 350 | Works as installed (curl, env-gated). |
| `updates.jsonl` `hook_execution` `user_prompt_submit` | session dir | `prompt_id` (= hook `promptId`), `_meta.eventId` `<session>-<n>` | 95 / 167 / 423 | Written after the hook finished. |
| **`updates.jsonl` `user_message_chunk`** | session dir | `_meta.promptIndex`, `_meta.eventId` `<session>-<n+1>`; **no prompt id** | 115 / 218 / 464 | **confirmed**: in the conversation (see S10: the only record that decided whether a prompt survived a kill). Exact typed text. Always the record right after its `hook_execution` (35 of 35, eventId n+1). |
| `chat_history.jsonl` user record | session dir | `prompt_index` (= `promptIndex`); no id, no timestamp | 112 / 192 / 464 | The conversation the model is sent, `<user_query>\n…\n</user_query>`. **Rewritten in place** (see §5.2 below). |
| Main model request | fake log | — | 132 / 250 / 680 | The `user_message_chunk` was on disk before, or within one 20 ms poll of, the main request in 35 of 35 prompts. A side request (session title, model `grok-4.6`, 1 tool) carries the text too, sometimes earlier. |
| `turn_completed` | `updates.jsonl` | `prompt_id`, `stop_reason` `end_turn` / `cancelled` / `error` / `interrupted` | end of turn | Also written at resume, `interrupted`, for a turn that died — even when its prompt never reached the conversation. |
| `Stop` / `StopCancelled` / `StopFailure` hooks | hook stdin | `promptId` | end of turn | `Stop` also fires at shutdown with `promptId: null`, `reason: shutdown`. |

`agent_message_chunk` carries `_meta.promptId`; the prompt's own `user_message_chunk` does not.
The link from the chunk to Grok's `promptId` is the `hook_execution` record just before it.

## Results per scenario

| Scenario | Signals, in order (ms after Enter) | Ids | accepted / confirmed | Evidence |
|---|---|---|---|---|
| **S1** idle | prompt_history +239, hook +270, hook_execution +364, chat_history +384, user_message_chunk +404, main request +499 | new `promptId` P1 on hook, hook_execution, turn_completed; `promptIndex` 0 | accepted at the hook; confirmed at the chunk | `timelines/S1-idle.txt` |
| **S2** busy in a tool (BETA's `sleep 8`) | **nothing at Enter**: no file, no hook. The TUI shows "Queued · Enter to send now" only on screen. After BETA's turn ends: prompt_history +8 843, hook +8 899 with a **new** `promptId`, chunk +9 092, request +9 098 — as an idle prompt, as a new turn | own new `promptId`, `promptIndex` 2 | no signal at all until dispatch, ~6 s after Enter | `timelines/S2-busy-tool.txt` |
| **S3** busy streaming text (DELTA, 10 s) | same as S2: nothing at Enter; dispatched as a new turn after DELTA ends (+10 495 prompt_history, +10 510 hook, +10 575 chunk) | own new `promptId`, `promptIndex` 4 | as S2 | `timelines/S3-busy-text.txt` |
| S2b "send now" (Enter on an empty box while one is queued) | the running turn is cancelled (`turn_ended` `cancelled`, trigger `send_now`; its tool moved to background; **no** `Stop` or `StopCancelled` hook for it); the queued prompt is dispatched at once: prompt_history, hook (new `promptId`), chunk (raw text). Its `chat_history` record and the model request **wrap the text**: `The user sent a message while you were working:\n<user_query>…</user_query>\nIf the user is asking for a response…`. A later auto-wake turn follows (S9). | new `promptId` | as S1 from dispatch | `timelines/S2b-send-now.txt` |
| **S4** interrupt, then send | Escape does nothing. Ctrl+C: `turn_ended` `cancelled` (trigger `ctrl_c`) +44, `StopCancelled` hook +128 with the turn's `promptId`, `reason: user_interrupt`; `chat_history.jsonl` replaced by rename. The next prompt is an ordinary idle prompt; its chat_history record carries `"prior_turn_interrupt":"mid_turn_abort"`. The interrupted prompt stays in the conversation. | as S1 | as S1 | `timelines/S4-interrupt.txt` |
| S4b queued, then interrupt | the queued prompt is dispatched right after the cancel (+155 after Ctrl+C), new `promptId` | as S1 | as S1 from dispatch | `timelines/S4b-queued-then-interrupt.txt` |
| **S5** same text twice | two turns, two `promptId`s, `promptIndex` 14 and 15, two chunks, two chat_history records; no dedupe, no merge. `grok --help` lists no per-prompt id option (*read*). `--session-id <uuid>` (our id) becomes the session id everywhere: session directory, every hook's `sessionId`, every eventId prefix | our id only at session level | — | `timelines/S5-same-text-twice.txt`, `timelines/S5-our-session-id.txt` |
| **S6** restart / resume | `grok -c` resumes the same session id (`SessionStart` `source: load`). For a turn that died, resume appends `turn_completed` `interrupted` with that turn's `prompt_id`, a tool result "cancelled by the user", and a **synthetic user entry** `<system-reminder> The previous turn was interrupted …` (chat_history `synthetic_reason: system_reminder`), which the model receives as a user message. `promptIndex` continues (29 after 28); every old `prompt_id` stays in `updates.jsonl`. The resume record's eventId restarts at `<session>-0` (5 times in this session), so **eventIds are not unique** across restarts. **A queued prompt does not survive**: after `kill -9` and after SIGTERM its text is nowhere under `GROK_HOME`. (Ctrl+Q does not quit while busy; `/quit` fires `SessionEnd` then `Stop` with `promptId: null`.) | session id, `promptIndex` survive; queue lost | — | `timelines/S6-*.txt`, `timelines/S10-kill9-with-queued.txt` |
| **S7** text changes | Hook `prompt` and `user_message_chunk` = the typed text exactly (leading/trailing spaces, trailing newline, 6 009 characters, CJK, emoji and a combining accent kept, no Unicode normalization). A pasted tab arrives as 4 spaces (the input box converts it before submit). `prompt_history` trims surrounding whitespace. `chat_history` and the model get `<user_query>\n` + text + `\n</user_query>`. A long paste is not collapsed to a placeholder. | — | — | `timelines/S7-text-changes.txt` |
| **S8** timestamps | `prompt_history.timestamp`: RFC 3339, ns; the **dispatch** time (a queued prompt gets its dequeue time, 6 s after its Enter). Hook `timestamp`: ns, dispatch time. `updates.jsonl`: `timestamp` in **whole seconds** plus `_meta.agentTimestampMs` (ms, event time; the chunk's record lands 0–100 ms later). `updates.jsonl` is **not** in eventId order: each turn's `agent_message_chunk` is written after that turn's `Stop` record (20+ inversions). `events.jsonl` `ts`: ms. `chat_history.jsonl`: **no timestamps**. `rewind_points.created_at`: ns, written at turn end. | — | — | `session-files/` |
| **S9** foreign / non-typed entries | Two prompts queued 0.7 s apart run as **two** turns in submit order; two submits 35 ms apart: the first runs, the second is queued and runs next — history order = submit order, **never merged**. User entries nobody typed: (a) a finished background task auto-wakes a turn: `UserPromptSubmit` with `promptId: "task-completed-call_fake21"` (not a UUID) and a `<system-reminder>` prompt, a `user_message_chunk` with `_meta.hideFromScrollback: true`, chat_history `synthetic_reason: task_completed`; (b) `/loop 1m …` is recorded (hook, chunk, prompt_history, chat_history) as its **expanded template** (`# /loop -- schedule a recurring prompt …`), not the typed text; (c) `/compact` fires `PreCompact` / `PostCompact` (no `promptId`), writes **no** user record to `updates.jsonl`, and rewrites `chat_history.jsonl` from 62 to 5 records: the summary as a user record (`synthetic_reason: compaction_meta`) and a **copy of the last prompt as a plain user record without `prompt_index`**; (d) resume after a dead turn adds a system-reminder user entry (S6); (e) "send now" wraps the text (S2b). `/btw` writes only `btw_history.jsonl` (no hook, nothing in the conversation). | — | — | `timelines/S9-*.txt` |
| **S10** error reply | HTTP 400 from the model: the prompt **is recorded** (chunk, chat_history) and **stays in the conversation**: the next request carries it again, followed by the next prompt. `StopFailure` hook with `promptId`, `error: invalid_request`, `errorDetails`; `turn_completed` `stop_reason: error`. No retry for a 400. | own `promptId` | accepted and confirmed although the model call failed | `timelines/S10-error-reply.txt`, `timelines/S10-after-error.txt` |
| **S10** killed right after it took a prompt | `kill -9` at +41 ms: only prompt_history and turn_started written; at +75 ms: also the hook fired (with `promptId`) and Podium's hook got it; at +136 ms: chunk and chat_history already written. After `grok -c`: the +41 and +75 prompts are **absent from the conversation** (next model request, `chat_history`), and resume wrote `turn_completed` `interrupted` for their `promptId`s; the +136 prompt is in the conversation and reached the model. | — | +75: accepted, never confirmed | `timelines/S10-kill-*.txt`, `timelines/S6-*-after-kill-60ms.txt` |

Hook events seen: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, Stop,
StopCancelled, StopFailure, Notification (`idle_prompt`, `task_complete`), PreCompact, PostCompact.
Not triggered by these scenarios: PostToolUseFailure, PermissionDenied, SubagentStart,
SubagentStop. `PreToolUse` / `PostToolUse` carry `promptId: null` (the docs say every turn event
carries it — *read*).

Not run: scheduler fires (the fake never created a schedule, so `/loop` never fired), a blocking
`UserPromptSubmit` or `Stop` hook, a Grok update between runs.

## CONTRADICTS OR EXTENDS THE SPEC

- **§4 `accepted` for a queued prompt.** Grok's own queue is invisible: a prompt entered while
  Grok is busy produces no file record and no hook until the running turn ends (6–10 s here). There
  is no `accepted` signal for it, only `typed`, and it is lost without a trace if Grok exits
  (`kill -9`, SIGTERM). It is not merged with other queued prompts.
- **§4 / §7 what sets `accepted` and `confirmed`.** `accepted` = the `UserPromptSubmit` hook
  (+42–270 ms idle), which also gives Grok's `promptId`. `confirmed` = the `user_message_chunk` in
  `updates.jsonl` (+115–464 ms): the only record whose presence decided whether a prompt survived a
  kill and reached the model. The hook alone is not proof (fired for a prompt then lost), nor is
  `prompt_history.jsonl`, nor a resume's `turn_completed` for the `promptId`.
- **§5.1 binding.** The Grok TUI takes no per-message id from us. Wrapped messages bind by our id in
  the text (the chunk and the hook keep the text exactly). Grok's own id (`promptId`) comes back on
  the hook and on the `hook_execution` record right before the chunk; the chunk itself has only
  `promptIndex`. `--session-id` takes our id at session level only.
- **§5.2 position.** `updates.jsonl` stayed append-only through everything the second watcher saw (232 records in
  the end; compaction, cancels, a send-now, 4 × `kill -9`, 2 × SIGTERM, 7 resumes): its byte length is a valid
  position. **`chat_history.jsonl` is not**: Grok replaces it by rename on cancels and resumes, and
  rewrites earlier lines on new prompts (old tool results become `[Tool result omitted — too old]`)
  and on compaction (62 → 5 lines). Podium's Grok transcript reads `chat_history.jsonl`
  (`packages/harness/src/adapters/grok/transcript.ts:9`), so a length position there is wrong; a
  compaction also re-adds an old prompt as a new-looking user record. Timestamps: only
  `updates.jsonl` `_meta.agentTimestampMs` (ms) and its seconds-only `timestamp`; `chat_history`
  has none. `agentTimestampMs` is the dispatch time, later than our send for a queued prompt.
- **§5.3 preconditions (Grok terminal, on `updates.jsonl`).** History order = submit order: yes
  (queued and fast submits). Merging: never. Text tolerance: exact, except a tab becomes 4 spaces in
  the input box; a slash command that expands (`/loop`) is recorded as its expansion. Entries nobody
  typed: auto-wake turns (`hideFromScrollback: true`, hook `promptId` `task-completed-…`); in
  `chat_history` also `synthetic_reason` records, the compaction copy of the last prompt, and the
  send-now wrapper. `/compact`, `/btw` and interrupts add no user record to `updates.jsonl`.
- **§6.1 N2.** An explicit error reply (HTTP 400 from the model) does **not** mean nothing was
  recorded: the prompt is in the conversation and is re-sent with the next prompt. `StopFailure`
  is not a "no".
- **§6.1 N3.** Not applicable (no protocol in the terminal).
- **§6.1 N4.** Holds when read on `updates.jsonl`: after the process died, a prompt with no
  `user_message_chunk` was absent from the resumed conversation (2 of 2), and one with it was present
  (1 of 1). A prompt in Grok's queue is gone. Caveat: resume writes `turn_completed` `interrupted`
  with the dead prompt's `promptId`, so that record must not count as the prompt being in history.
- **Podium's hook list** (`packages/harness/src/adapters/grok/instrumentation.ts:66-80`) lacks
  `StopCancelled`: a Ctrl+C reaches Podium only through `updates.jsonl` `turn_completed`
  `cancelled`, and a send-now's cancel fires no hook at all. The installed command works as
  installed: each installed event reached the capture URL with the same `promptId` as the logging
  hook (one shutdown pair missed it because the capture server was stopped at the same moment).
- **§7 row "Grok · terminal"** can move from "—" to run for: the signals above, idle / queued /
  interrupt / send-now / restart / kill / text changes / timestamps / non-typed entries.
- Side note: `turn_completed` was seen within 0.35 s of `events.jsonl` `turn_ended` in all 37 turns
  (most 20–45 ms); the "~17 s later" in `packages/harness/src/adapters/grok/state-causal.ts:78` did not show in 1.0.44's
  terminal UI.


## Expanded input storage (2026-09-30, POD-4984)

[Corpus and exact byte definitions](../expanded-input/README.md). All 18 bracketed-paste
cases and all 18 bounded unbracketed cases produce **one** `updates.jsonl` user chunk each,
including 200 lines and 100 KiB. There is no primary-history wrapper, split, or truncation.
Every one of the nine framed inputs retains its strict frame id in each method.
[Paste and early key observations](../expanded-input/grok-terminal/results.md),
[completed bounded keyboard/drain table](../expanded-input/grok-terminal-paced/results.md).

- Bracketed paste keeps LF, CRLF, final LF, and long text. Three tabs expand to four spaces
  each: 35→44 B plain, 179→188 B framed.
- Unbracketed input removes those tabs (35→32 B, 179→176 B) and converts CRLF to LF
  (52→50 B, 196→194 B); final LF stays in the native chunk. The 100 KiB plain editor took
  about 196 s to reach its final marker; the measured prompt still stored all 102,400 bytes.
- `prompt_history.jsonl` trims outer whitespace (including final LF); its exact records are
  included as auxiliary `input-history`, separately from the chunk.
- `chat_history.jsonl` and model input wrap ordinary text in `<user_query>` (27 additional
  UTF-8 bytes). At 100 KiB they instead store an excerpt plus an offload note, with the complete
  wrapped request saved to `prompts/prompt_0.txt` (102,427/102,571 B plain/framed). The native
  chunk remains full. The fake never reads the omitted portion through a tool call.
  [Offload byte details and ACP comparison](../grok-acp-1.0.44/results.md).

**POD-5005 — Grok terminal text matching** owns the tab/CRLF tolerance change. The reader
already uses the full `updates.jsonl` chunk, so the offload needs no reader switch. Plain
control-byte inputs miss the current trim-only matcher; every stored framed prompt still
matches by its frame id. No reader code changes in this issue.
