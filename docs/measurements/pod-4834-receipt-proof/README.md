# POD-4834 — receipt proof, measured on the real CLIs

**All programs in one table: [`grid.md`](grid.md).** The Claude terminal section below is the
first run (S1–S3); its idle order is superseded by `claude-2.1.284/results.md` (17 runs: the hook
comes before the record, and the record usually after the model request).

Ground truth for "the model received the prompt" is the fake model server: it logs every model
request with the messages it carries (`fake-model-server.ts`). Hooks are logged by `hooklog.sh`
(set `HOOK_LOG`), the harness's own history file is read in **file order** (a record's
`timestamp` field is not the time it was written), and each keystroke is marked in `marks.txt`.
Never real credentials: a scratch config directory, a dummy key, the fake server on localhost.

## Claude Code 2.1.284, terminal UI (run 2026-09-29, `claude-tui-2.1.284/`)

Setup: `CLAUDE_CONFIG_DIR=<scratch>` holding `settings.json` (hooks for SessionStart,
UserPromptSubmit, PreToolUse, PostToolUse, PostToolBatch, Stop; `Bash(sleep:*)` allowed) and
`.claude.json` (onboarding done, the dummy key approved, the work directory trusted);
`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, `ANTHROPIC_API_KEY=<dummy>`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`; the TUI in a 180×45 tmux pane, driven with
`tmux send-keys`. The fake answers a prompt containing `TOOLSLEEP` with a Bash `sleep 8` tool
call and one containing `SLOWTEXT` with 10 s of streamed text.

Times are milliseconds after the prompt's Enter.

| Scenario | Prompt | Transcript, in file order | `UserPromptSubmit` | Reached the model |
|---|---|---|---|---|
| Idle | ALPHA | `user` record, `promptId` P1, +71 | +167, `prompt_id` **P1** | request #2, +371 |
| Busy in a tool (BETA running, P2) | GAMMA | `queue-operation enqueue` (content = text) at +18; after the tool: `user` tool_result, `queue-operation remove` reason `absorbed_mid_turn`, then the `queued_command` attachment (its `timestamp` = Enter time, `source_uuid` set, no `promptId`) at about +5 900 | +43, `prompt_id` **P2 — the running turn's** | the next request after the tool, inside the `tool_result` content as `<system-reminder> The user sent a new message while you were working: …` (rerun ZETA/ETA, full request bodies in `rerun-eta-requests.json`: request #3 at +5 600 after ETA's Enter; request #2 did not contain ETA. The first run logged no full bodies, so GAMMA's route rests on the rerun.) |
| Busy streaming text, no tool (DELTA running, P3) | EPSILON | `queue-operation enqueue` at +15; after DELTA ends: `queue-operation dequeue`, then a `user` record with a **new** `promptId` P4 at +7 176 | +43, `prompt_id` **P3 — the running turn's**; **none** fires with P4 | request #9, +7 212, as a new turn; the next `Stop` carries P4 |

What this settles for Claude's terminal UI:

- An idle submit has one id end to end: the `user` record and the hook carry the same new
  `prompt_id`; the record is written about 100 ms before the hook, the model request follows.
- `prompt_id` / `promptId` is a **turn** id. A prompt entered while Claude is busy gets no turn id
  of its own at Enter: the hook fires then with the running turn's `prompt_id`, and its payload
  has no id for the prompt itself (fields: `session_id`, `transcript_path`, `cwd`,
  `permission_mode`, `hook_event_name`, `prompt`, `prompt_id`). Taken into the running turn at a
  tool boundary, it never gets a turn id: its `queued_command` record has its own `uuid` and a
  `source_uuid`, and no `promptId`. Run after the turn ends, it gets a new `promptId` and
  `promptSource: 'queued'` on its `user` record, and no hook fires with that id.
- The earliest history signal of a queued prompt is `queue-operation enqueue` (at Enter, with
  the text; upstream #96891 says it is written even when a hook then blocks the prompt, so it is
  not proof the prompt was taken). The signal that it reached the model is the `queued_command`
  attachment (tool boundary) or the `user` record after `dequeue` (after the turn).
- Only six hook events were switched on in this run (SessionStart, UserPromptSubmit, PreToolUse,
  PostToolUse, PostToolBatch, Stop); none of them fired with the prompt when it was sent to the
  model. The other 27 events Claude knows were not observed.

## Grok 1.0.44, ACP over `grok agent stdio` (run 2026-09-29, `grok-acp-1.0.44/`, POD-4837)

Setup: `HOME` and `GROK_HOME` point to a scratch directory whose `.grok/config.toml` defines one
`[model.fake]` (`base_url` = the fake on localhost, `env_key` = a dummy key) and makes it the
default; `grok-acp-1.0.44/fake-model-server.ts` answers OpenAI chat completions (markers for a
tool call, a slow reply, a 135 s reply and an HTTP 402). `acp-probe.ts` is a raw ACP client that
logs every frame with its time; the exact frames are in the driver's fixtures
(`packages/harness/src/driver/families/grok-acp/__fixtures__/live-frames.jsonl`, `prompt-ack.json`).

Times are milliseconds after the `session/prompt` write.

| Question | Run result |
|---|---|
| Can the prompt carry our id? | Yes: `session/prompt` `_meta.promptId`. Grok keeps it as the turn's id: on every `agent_message_chunk`/`tool_call(_update)` (`params._meta.promptId`), on `turn_completed` (`prompt_id`), on `_x.ai/session/prompt_complete`, and in the reply (`result._meta.promptId` and `requestId`). A top-level `messageId` (ACP crate field) is ignored; Grok mints its own id. |
| Earliest signal naming it | `_x.ai/queue/changed`: first `entries: [{id: <promptId>, text}]`, then `runningPromptId: <promptId>` with `runningText`. +3 to +22 ms on a warm session, +84 to +89 ms on a session's first prompt (it waits for MCP start-up). No event id: an ack, not history. |
| `hook_execution` `user_prompt_submit` | Only when a `UserPromptSubmit` hook is configured, as `_x.ai/session_notification` with `prompt_id` = ours, ~30 ms after the queue ack (`hook_run_started` first, without an event id). Not a general signal. |
| Live `user_message_chunk` echo | **Never sent** to the ACP client (0 in every run). Grok writes it to `updates.jsonl` at the start of the turn, with `promptIndex` and an event id but **no promptId**; `session/load` replays it followed by the turn's stamped updates. |
| When is the prompt recorded? | After the `UserPromptSubmit` hooks, before the model call. A blocking hook: queue ack, then `hook_execution` with `blocked: true`, `turn_completed` `stop_reason: cancelled` with `_meta.cancellationCategory: HookDenied`, reply `cancelled`; nothing is written to history. A provider 402: queue ack, `retry_state` failed, `turn_completed` `stop_reason: error` with our id, then a JSON-RPC error reply (-32603, `data.http_status` 402); the prompt **is** recorded. |
| Same promptId again | Not deduplicated: idle, a second turn under the same id; sent while the first runs, the queue shows no second entry, yet it runs a second turn afterwards. Grok's docs: a client that supplies its own id owns its uniqueness. |
| A prompt sent while Grok is busy | Listed in `entries` (queued) behind the running prompt; runs after it; the reply to the first request arrives after the second starts. |
| `session/prompt` reply | Only at the end of the turn. |

The driver after POD-4837 (`driver-live-check.ts`, output in `driver-live-check.txt`): accepted
+4 to +20 ms after the send on the queue ack; the entry `grok-user-<message id>` named at the
turn's first output (+375 to +473 ms here, +5 s for a reply whose first word took 5 s); the same
message id again, in the same process and after a `session/load` in a new one, accepted from the
history without a second `session/prompt`; a 135 s turn ended normally. Control arm
(`driver-live-check-control.txt`): with the old 120 s call timeout on `session/prompt`, the same
turn was reported failed at 120 s ("session/prompt did not answer within 120000ms") while Grok
was still answering.
