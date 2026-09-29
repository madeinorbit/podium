# POD-4834 — receipt proof, measured on the real CLIs

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
