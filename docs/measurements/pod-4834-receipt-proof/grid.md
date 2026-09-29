# Receipt grid — every program, one table (POD-4834)

What each agent program reports when it takes a message, measured on the real CLI on
2026-09-29 against a fake model server (ground truth for "the model got it"). This page only
summarises; every cell comes from the lane's `results.md`, which has the evidence files, the
ranges and the scenarios behind it. Times are ms after the send (Enter, or our protocol write).

Lanes: Claude terminal + SDK `claude-2.1.284/results.md` (POD-4862); Codex app-server + terminal
`codex-0.155.0/results.md` (POD-4863, builds on POD-4835); Grok ACP `README.md` §Grok and
`grok-acp-1.0.44/` (POD-4837); Grok terminal `grok-tui-1.0.44/results.md`, Cursor
`cursor-agent-2026.07.23/results.md`, Pi `pi/results.md` (POD-4865); OpenCode HTTP v1, v2 and
terminal (POD-4864, **still running** — its rows are pending).

Words as in the spec (`docs/plans/pod-4819-harness-receipt-proof.md` §4): **accepted** = the
program has taken the message but it is not yet in its history; **confirmed** = it is in the
history the model is sent, so it survives a restart.

## 1. Signals: id, accepted, confirmed

| Program · transport | Can we pass our id? | Earliest *accepted* signal (delay, id) | *Confirmed* signal (delay, id) | Signals that look like proof but are not |
|---|---|---|---|---|
| Claude · terminal 2.1.284 | No (only in the text) | Idle: none reliable. Busy: `queue-operation enqueue` in the transcript at Enter (+9–109, no id, has the text) | Transcript `user` record, `promptSource: typed`/`queued` (idle +157–824, median 240; new `promptId`); for a prompt taken in at a tool boundary: `queued_command` attachment (own `uuid`, `source_uuid`) | `UserPromptSubmit` (+33–256; fires before the record; a busy prompt's hook carries the **running** turn's id; seen for a prompt whose record was never written). `history.jsonl` (written for blocked prompts too). The model answering (a SIGKILL at +200/+286 ms left a prompt the model had seen and no record; gone after resume). `enqueue` (written before a blocking hook drops it). |
| Claude · SDK 2.1.284 | **Yes** — message `uuid` | `command_lifecycle queued` +2–32 (median 5), ours; then `started` | Transcript `user` record with `uuid` = ours (+103–322, median 114), or `queued_command` with `source_uuid` = ours. On the stream: `command_lifecycle completed`/`cancelled` of a started line came after its record in 28/28 (observed order, not a promise) | `queued`/`started` (SIGKILL right after them left nothing). The replay echo. `cancelled` and `result.is_error` (an HTTP 400 left the prompt recorded). |
| Codex · app-server 0.155.0 | **Yes** — `clientUserMessageId` on `turn/start`, `turn/steer`, `thread/queue/add` | `turn/start` reply +6–26 (Codex turn id); `thread/queue/add` reply +9 (ours + queue id; durable row in `queue_1.sqlite`) | `item/completed userMessage` with `clientId` = ours (+213–239); same id in the rollout `item_completed` | A `turn/start` sent while busy replies with the **running** turn's id — it is silently a steer. A steer's reply (dropped on interrupt, stop or kill: POD-4849). `UserPromptSubmit` (no `clientId`). |
| Codex · terminal 0.155.0 | No — the TUI mints its own `client_id` per submit, only in the rollout | Idle: rollout `task_started` +18–60 (no text, no id). Busy: nothing but a `history.jsonl` line (Enter) or nothing at all (Tab) | Rollout `item_completed` `UserMessage` (+189–384; Codex `client_id`, item id, `turn_id`) | `history.jsonl` (no id; written for lost messages, twice for an Escape re-submit, for box text Ctrl-C cleared). `UserPromptSubmit` (fires 8–38 ms before the record, carries the turn id). |
| Grok · ACP 1.0.44 | **Yes** — `session/prompt` `_meta.promptId`; Grok uses it as the turn id on every update | `_x.ai/queue/changed` naming ours, +3–22 warm (+84–89 on a session's first prompt) | No live echo. `updates.jsonl` `user_message_chunk` (no `promptId`; `promptIndex`, event id), written after the hooks, before the model call; the driver (after POD-4837) binds it at the turn's first output (+375–473) | `hook_execution` (only when a hook is configured). The `session/prompt` reply (only at the end of the turn). |
| Grok · terminal 1.0.44 | No — `--session-id` takes ours at session level only | Idle: `UserPromptSubmit` hook +42–270 (median 82), Grok's own new `promptId`. Busy: **nothing** until Grok runs it (+6–10 s after Enter) | `updates.jsonl` `user_message_chunk` (+115–464, median 218; `promptIndex`, event id; bound to `promptId` by the `hook_execution` record written right before it) | The hook (fired for a prompt a kill at +75 ms then lost). `prompt_history.jsonl`. Resume's `turn_completed interrupted` for a prompt that never reached the history. |
| OpenCode · HTTP v1 1.18.33 | pending (POD-4864) | pending | pending | pending |
| OpenCode · HTTP v2 1.18.33 / opencode2 beta-18866 | pending (POD-4864) | pending | pending | pending |
| OpenCode · terminal 1.18.33 | pending (POD-4864) | pending | pending | pending |
| Cursor · terminal 2026.07.23 | No | `beforeSubmitPrompt` hook +282 (Cursor's `generation_id`, exact text) — also fires for a follow-up that never runs | **Not measurable**: Cursor cannot use a fake model (`--base-url` refused outside `agent-cli-local`); with no backend the transcript never gets a user record | — |
| Pi | Not installed on this machine; nothing measured | | | |

## 2. A message sent while the program is busy

| Program · transport | What happens | Signal at the send | When it reaches the history |
|---|---|---|---|
| Claude · terminal | Busy in a tool: joins the running turn at the tool boundary. Busy in text: next turn. Escape with one queued: it runs at once as a new turn. Send-now: moves a running Bash to the background | `enqueue` | Tool boundary (`queued_command`) or right after the turn (`user`, new `promptId`) |
| Claude · SDK | Same routes; `priority: "now"` cuts streamed text at once, a tool at its end, and marks the preempted line `cancelled` although it stays in the history | `queued` (ours) | Same, under our id |
| Codex · app-server | `turn/steer` or a busy `turn/start`: recorded at the next model call of the running turn (+8 s in text). `thread/queue/add`: a new turn after the running one | reply | Next model call / next turn |
| Codex · terminal | Enter: held in memory, joins the running turn after the tool or text. Tab: next turn. Escape: held messages re-submitted as a new turn, nothing lost | Enter: `history.jsonl` only; Tab: nothing | +6–8 s here |
| Grok · ACP | Listed in the queue behind the running prompt, runs after it | `queue/changed` (ours) | Next turn |
| Grok · terminal | Held on screen only ("Queued · Enter to send now"); runs as a new turn. Send-now cancels the running turn and wraps the text in `chat_history` | none | Next turn (+6–10 s) |
| OpenCode (all) | pending | | |

## 3. What the proof rules depend on

§6.1 N-rows are the spec's "proven no" conditions: N2 an explicit refusal, N3 no turn open,
N4 nothing held survives a restart.

| Program · transport | Same id / same text twice | Restart with a message held | Model error (HTTP 400/402) | Explicit "no" seen | History order = submit order? | Entries nobody typed | Text changes |
|---|---|---|---|---|---|---|---|
| Claude · terminal | Two entries, never merged (`history.jsonl` drops a repeat — do not read prompts there) | Queued prompt **lost** (SIGTERM, SIGKILL). N4 holds for the history, not for side effects (the model may have seen it once) | Recorded; stays in the history | Blocking `UserPromptSubmit`: queued → `remove reason: dropped_by_hook`; idle → `system/informational` "blocked by hook", no `user` record | Yes (file order differs from event order around an Escape) | Interrupt markers, synthetic `tool_result`s (also after resume), Stop-hook feedback, task notifications (`promptSource: system`, **with** `UserPromptSubmit`), slash-command records, the compact summary (`isCompactSummary: true`) | Tab → 4 spaces; CR/CRLF → LF; U+200B removed and its Enter swallowed; else exact |
| Claude · SDK | Repeated uuid **skipped** (in history, in queue or running); a lost line resent under the same uuid runs once → resend is safe, N3 not needed | Queued line lost on SIGKILL; resend same uuid recovers. Stdin close finishes the queue | Recorded; `cancelled` + `is_error` | None other than a skipped repeat | Yes | As terminal | Byte-exact |
| Codex · app-server | **No dedupe** (`turn/start`, steer, queue all run twice) | Steer **lost**. Queue item survives: held after SIGTERM, **run by itself** on `thread/resume` after SIGKILL. Killed right after the `turn/start` reply: lost, empty `interrupted` turn. N3 needs "no turn open **and** our id not in `thread/queue/list`"; N4 fails for queue items | Recorded (`turn/completed failed`) | JSON-RPC `-32600` (4 kinds): nothing recorded (N2 holds) | Yes | Only as `response_item` role user (`<turn_aborted>`, `<hook_prompt>`, `<environment_context>`, `compacted.replacement_history` repeating old prompts); `item_completed UserMessage` is clean | Byte-exact |
| Codex · terminal | Two entries | Held and Tab-queued **lost** on kill; Ctrl-C quit puts them back in the input box joined by `\n`. N4 holds | Recorded | — | **No** when Tab-queued and Enter-held mix | As app-server | Leading/trailing whitespace trimmed; else exact |
| Grok · ACP | **Not deduplicated by Grok**; the driver (POD-4837) finds the id in the history and does not resend | Replayed by `session/load`; the driver accepts from the history | 402: recorded, error reply | Blocking hook: `turn_completed cancelled` `HookDenied`, nothing written | Yes | — | — |
| Grok · terminal | Two turns, never merged | Queued prompt **lost**; resume writes `turn_completed interrupted` for a dead prompt (must not count as recorded) and a synthetic system-reminder user entry; event ids restart at `-0` (not unique). N4 holds on `updates.jsonl` | Recorded; resent with the next prompt | Not run (blocking hook) | Yes | Task-completed auto-wake (`hideFromScrollback`, hook `promptId: task-completed-…`); `/loop` recorded as its expansion; in `chat_history` also the send-now wrapper, the compaction copy of the last prompt, `synthetic_reason` records | Exact, except tab → 4 spaces in the input box |
| OpenCode (all) | pending | | | | | | |

## 4. Position and time (spec §5.2)

| Program | Append-only history? | Record timestamp |
|---|---|---|
| Claude (both) | Transcript: yes | Set at creation, written up to ~800 ms later; `queued_command` carries its enqueue time; post-resume synthetics carry the resume time — so a record can sit after a saved position with a time before the saved time |
| Codex (both) | Rollout: yes, also across resume, interrupt and `/compact`; `ordinal` per line | Write time, ms, monotonic in file order |
| Grok (both) | `updates.jsonl`: yes. **`chat_history.jsonl`: no** — replaced by rename on cancel and resume, earlier lines rewritten, compaction 62 → 5 lines | `updates.jsonl`: whole seconds + `_meta.agentTimestampMs` (dispatch time); not in event-id order; `chat_history` has none |
| OpenCode | pending | pending |

## 5. Findings that touch Podium's code (for the design session, not fixed here)

- `packages/harness/src/adapters/grok/transcript.ts` reads `chat_history.jsonl`, which Grok
  rewrites; `updates.jsonl` is the append-only record (Grok terminal lane).
- `packages/harness/src/adapters/grok/instrumentation.ts` does not install `StopCancelled`; a
  Ctrl+C reaches Podium only through `updates.jsonl` (Grok terminal lane).
- `packages/harness/src/adapters/claude-code/transcript.ts` has no `isCompactSummary` filter; the
  compact summary is a `user` record (Claude lane, confirms the spec's *read*).
- The Claude idle order in `README.md` (record ~100 ms before the hook) is contradicted by 17
  runs: the hook came first every time and the record usually after the model request (Claude
  lane, point 1).

## 6. Still not run

- **OpenCode**, all three transports (POD-4864 in progress).
- **Cursor** past the submit: needs real credentials or the separate `agent-cli-local`.
- **Pi**: not installed.
- Claude: auto-compact, Desktop's queued-prompt merging (upstream #53670), any version but 2.1.284.
- Grok terminal: a blocking `UserPromptSubmit` / `Stop` hook; scheduler (`/loop`) fires.
