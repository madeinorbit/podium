# Claude Code 2.1.284 — receipt facts, terminal and SDK (POD-4862)

Run 2026-09-29 on this host (7 cores, load about 11 throughout). Every fact below was *run*: a
fake Anthropic model server logged every request with its full body (`*/model-requests.jsonl`),
all 33 hook events Claude knows were switched on and logged (`*/hooks.jsonl`), every keystroke or
protocol line was marked (`tui/marks.txt`, `sdk/sdk.log`), and every line appended to the
transcript and to `history.jsonl` was logged in file order with the time it was first seen
(`*/transcript-watch.jsonl`). Merged per-scenario timelines are in `tui/timelines/` and
`sdk/timelines/` (made by `rig/timeline.py <dir> <from-mark> <to-mark>`). Final transcripts are
in `*/transcripts/`, TUI screens in `tui/screens/`, and the exact bytes pasted in `tui/sent/`.

Method: `rig/` (`mkrun.sh` makes a scratch `CLAUDE_CONFIG_DIR` with hooks for all 33 events, a
status line command, the fake server and the watcher; `tui.sh` drives a 180×45 tmux pane;
`drive-sdk.ts` spawns `claude` with the flags of `packages/harness/src/driver/families/claude-sdk/protocol.ts`
plus `--permission-mode bypassPermissions`; `killer.py` presses Enter and SIGKILLs the CLI a set
time later). A fake-key string, no real credentials. Markers in a prompt make the fake busy:
`TOOLSLEEP` → a Bash `sleep 8`, `SLOWTEXT` → 10 s of streamed text, `HANGFIRST` → first byte after
6 s, `ERR400` → an HTTP 400 reply.

**Time resolution.** "seen" times come from a 5 ms poll of the files; under this load the poll
stalled more than 40 ms 542 times (at most 417 ms), so a "seen" time is an upper bound on when
the line was written. Order claims that matter are proven without the poll, by SIGKILL (§ TUI
S10): what the file holds after a kill is what had been written.

Scope is signals and ids. Typing mechanics (Phase D) were not measured; the two keystroke facts
below (the invisible-character Enter, tmux's paste conversion) are recorded only because they
change what is recorded.

## Hook events

13 of the 33 events fired in these runs: `SessionStart` (startup / resume / compact),
`SessionEnd` (`other` on SIGTERM and stdin close, `prompt_input_exit` on `/exit`; none on SIGKILL),
`UserPromptSubmit`, `UserPromptExpansion` (custom slash command), `PreToolUse`, `PostToolUse`,
`PostToolBatch`, `Stop`, `StopFailure` (model API error, `error: "unknown"`), `MessageDisplay`
(each assistant message: `prompt_id`, `turn_id`, `message_id`, `index`, `final`), `SubagentStop`,
`PreCompact`, `PostCompact`. The other 20 did not fire in any scenario here (PostToolUseFailure,
Notification, SubagentStart, Pre/PostModelSwitch, PermissionRequest/Denied, Setup, TeammateIdle,
TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate/Remove,
InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded). **No hook fires when a queued
prompt is taken in at a tool boundary, when the model is called, or on Escape / interrupt.** No
hook payload, status-line input or `history.jsonl` entry carries a queued prompt's `source_uuid`
(or any id of its own) before it is taken in; the status line carries only the turn's `prompt_id`.

## Terminal (TUI)

Times are ms after the prompt's Enter. `n=17` idle sends (A1–A13, after-interrupt, after-compact,
after-resume) give the ranges in the first row.

| Scenario | Signal | Delay | Id it carries | Shows | Evidence |
|---|---|---|---|---|---|
| S1 idle (n=17) | `UserPromptSubmit` | 33–256 (median 85) | new `prompt_id` (ours: none) | seen, not accepted (a blocking hook decides after it; see block rows) | `tui/timelines/*` |
| | `history.jsonl` entry | seen 51–252; its `timestamp` = Enter +15–177 | none (`sessionId`) | seen — written even for blocked prompts and for prompts that never reach the transcript | same |
| | model request | 113–639 (median 172) | — | the model got it | `tui/model-requests.jsonl` |
| | transcript `user`, `promptSource: "typed"`, `origin.kind: "human"` | seen 157–824 (median 240); **after the hook in 17/17, after the model request in 16/17**; its `timestamp` = Enter +19–186 (creation, not write) | `promptId` = the hook's `prompt_id`; own `uuid` | **confirmed** | same; order proven by S10 kills |
| S2 busy in a tool | `UserPromptSubmit` | 24–253 | the **running** turn's `prompt_id` (usual); **once (A14) it fired only at take-in with the prompt's own new `prompt_id`** — timing-dependent | seen | `S9-two-rapid-submits.txt` |
| | `queue-operation enqueue` | seen 112–243, `timestamp` Enter +9–109 | none; `content` = text | accepted (held in Claude's queue) | `S5-S9-three-queued-at-tool-boundary.txt` |
| | at the tool boundary: `queue-operation remove` `reason: "absorbed_mid_turn"` + `attachment/queued_command` | at the next tool result (~+5 s here) | attachment: own `uuid`, `source_uuid`, no `promptId`; `timestamp` = its enqueue time | **confirmed** (the model request carries it as a text block after the `tool_result`) | same |
| | `history.jsonl` entry | at take-in, not at Enter | none | — | same |
| S3 busy in text | `enqueue` at Enter; after the turn `queue-operation dequeue` (no content, no id) + `user` `promptSource: "queued"` | take-in right after the turn's `Stop` | new `promptId` per queued prompt; **no `UserPromptSubmit` with it** unless the A14 timing | confirmed | `S9-three-queued-after-text-turn.txt` |
| S4 Escape, prompt queued in a tool | tool interrupted; the queued prompt **runs at once as a new turn** (not dropped, not put back in the input box): `dequeue`, `user` `promptSource: "queued"`, then the interrupted `tool_result` and `[Request interrupted by user for tool use]`, all with the **new** `promptId` | model request +227 after Escape | new `promptId` | confirmed | `S4-escape-with-queued-prompt-in-tool.txt` |
| S4 interrupt, no queue (text / tool) | `user` `[Request interrupted by user]` (partial assistant text recorded) / `tool_result` + `[… for tool use]` | +225 / +245 after Escape | the interrupted turn's `promptId` | a user entry nobody typed | `S4-interrupt-then-send.txt` |
| | next send | as S1 | new `promptId` | confirmed | same |
| Send now (ctrl+x ctrl+s, ctrl+enter as CSI `13;5u`: identical), prompt queued in a tool | the running Bash is **moved to the background** (`tool_result`: "Command was moved to the background … so that a message that arrived while it was running can reach you"), `PostToolUse`, then `remove absorbed_mid_turn` + `queued_command` | model +790 after the key | `source_uuid` | confirmed | `sendnow-ctrl-x-ctrl-s-in-tool.txt`, `sendnow-ctrl-enter-in-tool.txt` |
| | later the background task ends: `UserPromptSubmit` (prompt `<task-notification>…`), `enqueue`+`dequeue`, `user` `promptSource: "system"`, `origin.kind: "task-notification"` | ~3 s later | new `prompt_id` | a user entry nobody typed, **with** `UserPromptSubmit` (#94675 run) | same |
| Send now during streamed text | stream cut (partial assistant recorded, no interrupt marker), `dequeue`, `user` `promptSource: "queued"` | model +170 after the key | new `promptId`, no hook with it | confirmed | `sendnow-during-text.txt` |
| Blocking `UserPromptSubmit` hook, idle | no `user` record; `system/informational` "UserPromptSubmit operation blocked by hook"; `history.jsonl` written anyway | +251 | — | a proven "no" (the system record) | `userpromptsubmit-hook-blocks-idle-and-queued.txt` |
| Blocking hook, queued (tool or text) (#96891) | `enqueue` **is** written, then `remove` with **`reason: "dropped_by_hook"`** 25–32 ms later; `history.jsonl` written anyway; no model request | at Enter | none | a proven "no" (`dropped_by_hook`) | same |
| Stop hook blocks (#94675) | `user` `isMeta: true` "Stop hook feedback:\n…" + `attachment/hook_blocking_error`; **no `UserPromptSubmit`** | +592 | the running turn's `promptId` | a user entry nobody typed | `stop-hook-feedback.txt` |
| Slash commands | `/cmdx arg` (custom): `UserPromptExpansion` + `UserPromptSubmit` (prompt `/cmdx arg`), `user` `<command-message>…` (no `promptSource`) + `isMeta` expansion; `/cost`: only `history.jsonl`; `/compact`: see below; none has `promptSource` | — | `promptId` | user entries whose text is not what was typed | `S9-slash-commands.txt` |
| `/compact` | `PreCompact`, `SubagentStop`, `SessionStart source=compact`, `PostCompact`; records: `user` "/compact", `system/compact_boundary` (`parentUuid: null`), **`user` with `isCompactSummary: true` (the summary)**, `isMeta` local-command-caveat, `user` `<command-name>/compact`, `user` `<local-command-stdout>`; **no `UserPromptSubmit`** | +538 | `promptId` of the /compact | the summary **is** a `user` record | `S9-compaction.txt` |
| S5 same text twice, idle | two `user` records, two `promptId`s; **`history.jsonl` keeps only the first** (consecutive duplicates dropped) | as S1 | distinct | confirmed ×2 | `S5-same-text-twice-idle.txt` |
| S5/S9 three queued at a tool boundary (two identical) | three `enqueue`, three `remove absorbed_mid_turn`, three `queued_command` attachments in submit order, three text blocks in one request; `history.jsonl` drops the repeated one | — | three `source_uuid`s | confirmed ×3, not merged | `S5-S9-three-queued-at-tool-boundary.txt` |
| S9 three queued during text | three `dequeue`, three `user` `promptSource: "queued"` in submit order, **each its own `promptId`**, sent as **one** model request (one user message); later hooks carry the **last** `promptId` | — | three `promptId`s | confirmed ×3 | `S9-three-queued-after-text-turn.txt` |
| S9 two submits 60 ms apart | A: idle path; B: `enqueue` at Enter, **hook deferred to take-in with B's own `prompt_id`**, `user` `promptSource: "queued"`; history order = submit order | — | — | — | `S9-two-rapid-submits.txt` |
| S6 SIGTERM with a prompt queued | `SessionEnd reason=other`; the `enqueue` stays with **no `dequeue`/`remove`**; after `--resume` the queue and the input box are empty: **the held prompt is lost** | — | — | not delivered | `S6-sigterm-with-queued-then-resume.txt` |
| | on the next submit after resume: synthetic `tool_result` "[Tool call interrupted: the session ended …]" and assistant "No response requested." | written at that submit; `timestamp` = resume time | the **new** turn's `promptId` | user entry nobody typed | same |
| S6 SIGKILL with a prompt queued (streaming) | same as SIGTERM, no `SessionEnd`, the partial assistant text is not recorded | — | — | not delivered | `S6-kill9-with-queued-then-resume.txt` |
| S10 SIGKILL after an idle Enter | at +60…334 ms (B5) and +151 ms (C1): at most a `UserPromptSubmit` (B5's with an **empty payload**), no model request, nothing on disk. **+200 and +286 ms: the model request was already sent (+113 / +199), `UserPromptSubmit` and `history.jsonl` written, the transcript `user` record never written; after resume the prompt is not in the conversation** (request #81). +400 ms: record on disk, in the conversation after resume | — | — | the transcript alone decides | `S10-kill9-idle-*.txt` |
| S10 model replies HTTP 400 | `user` record **written** (`promptSource: "typed"`), assistant `isApiErrorMessage: true` "API Error: 400 …", `StopFailure`; the prompt stays in the conversation (later requests carry it) | +296 | `promptId` | **confirmed** — an error reply is not a "no" | `S10-explicit-400.txt` |
| S7 text | tab → 4 spaces; each CR and each CRLF → `\n`; leading/trailing spaces and blank lines kept; Unicode kept exactly (no NFC, ZWJ, combining mark, NBSP kept); **U+200B removed and that Enter does not submit** ("Removed 1 invisible character · review and press Enter to send"; nothing recorded until a second Enter); a 60-line paste is recorded in full in the transcript, the hook and the model request, while `history.jsonl` keeps small pastes inline and large ones as a `contentHash` behind "[Pasted text #N +k lines]". Hook text = record text = model text in every case | — | — | tolerance | `S7-text-changes.txt`, `tui/sent/` |
| S8 timestamps | transcript `timestamp`: ISO-8601, ms, UTC; set at creation (typed: Enter +19–186; `queued_command`: its enqueue time; queued `user`: take-in; synthetic post-resume records: the resume time) and **written later** (typed: seen +157–824). `history.jsonl` `timestamp`: epoch ms, Enter +15–177 for an idle send, take-in time for a queued one | — | — | a timestamp is never the write time | all |

Note on driving: tmux `paste-buffer` without `-r` turns LF into CR; the S7 CRLF row was re-run
with `-r` (A22).

## SDK (stream-json)

Times are ms after our line was written to stdin. `n=14` fresh lines (idle, then busy starts).

| Scenario | Signal | Delay | Id | Shows | Evidence |
|---|---|---|---|---|---|
| S1 idle (n=14) | `command_lifecycle queued` | 2–32 (median 5) | `command_uuid` = **ours** | accepted | `sdk/timelines/S1-idle.txt` |
| | `command_lifecycle started` | 3–36 | ours | taken in (not recorded: see S10) | same |
| | `UserPromptSubmit` | 15–150 | new `prompt_id` | seen | same |
| | model request | 41–318 (median 92) | — | model got it | same |
| | `user` echo, `isReplay: true`, with `timestamp` | 43–333 (median 100); right before the first `stream_event` | ours | model answering; not proof of the record | same |
| | transcript `user`, `promptSource: "sdk"` | seen 103–322 (median 114) | **`uuid` = ours**, new `promptId` | **confirmed** | same |
| | `result`, then `command_lifecycle completed` | end of turn | ours | **every `completed`/`cancelled` frame for a line that had `started` came after that line's record was on disk (28/28 frames)** | computed from `sdk/sdk.log` + watch |
| S2 line while busy in a tool (default priority) | `queued` +2; `enqueue` (no content) | at write | ours | accepted | `S2-queued-in-tool.txt` |
| | at the tool boundary: `UserPromptSubmit` (**running** turn's `prompt_id`), echo (timestamp = enqueue time), `started`, `queued_command` attachment with **`source_uuid` = ours**, `remove`; model request carries it after the `tool_result` | +5.8 s here (tool end) | ours | confirmed | same |
| | `completed` for our line, then `completed` for the running line | end of turn | ours | — | same |
| S3 line while streaming text (default / `later`) | `queued` +35; after the running line's `result`+`completed`: `started`, `UserPromptSubmit` with a **new** `prompt_id`, `dequeue`, `user` record **`uuid` = ours** | take-in after the turn | ours | confirmed | `S3-queued-in-text.txt`, `priority-later-in-text.txt` |
| `priority:"now"` in a tool | does **not** background or stop the tool; at the tool's end the running line gets **`cancelled`** (its `result` has empty text) and ours starts a new turn: `user` record `uuid` = ours | at tool end | ours | confirmed; the preempted line is `cancelled` **although it is in the conversation** | `priority-now-in-tool.txt` |
| `priority:"now"` while streaming | stream cut at once (+26), partial assistant recorded, running line `cancelled`, ours `started`, new turn | +110 to the model | ours | confirmed | `priority-now-in-text.txt` |
| S4 `control_request interrupt`, a line queued (tool / text) | `control_response success` +3–21; `[Request interrupted …]` records; `result error_during_execution`; running line **`cancelled`**; **the queued line then starts as a new turn** (not dropped) | queued line at the model +215 / +192 after the interrupt | ours | confirmed | `S4-interrupt-with-queued-in-*.txt` |
| | a line after the interrupt | as S1 | ours | confirmed | same |
| S5 same uuid while the first is still queued | the repeat gets only a timestamp-less echo, **no lifecycle frame at all**; the first line runs normally | — | ours | repeat skipped (dedupe includes the in-memory queue) | `S5-same-uuid-while-queued.txt` |
| S5 same uuid as the running line | same: echo only, skipped | — | ours | skipped | `S5-same-uuid-as-running.txt` |
| S6 SIGKILL with a line queued, then `--resume` | only the `enqueue` was written; the line is gone; **resent under the same uuid it runs normally** (queued/started/record/completed); resending the line that *was* recorded gets the timestamp-less echo and a lone `completed` | — | ours | lost; resend-same-id recovers | `S6-kill9-with-queued-then-resume-resend.txt` |
| S6 stdin closed with a line queued | the CLI finishes the running tool, takes the queued line in (`queued_command`, `source_uuid` = ours), answers, `completed` ×2, `SessionEnd reason=other`, exit 0 | — | ours | confirmed | `S6-stdin-close-with-queued.txt` |
| S10 SIGKILL right after the ack | +50 ms (after `queued`+`started`): nothing on disk; +170 ms: `enqueue`/`dequeue` + `UserPromptSubmit`, no `user` record, no model request. Resent under the same uuid after resume: both ran once, recorded under our uuid | — | ours | the lifecycle ack is not "recorded" | `S10-kill9-idle-40-150ms-then-resend.txt` |
| S10 model replies HTTP 400 | echo, assistant "API Error: 400 …" (`isApiErrorMessage` in the transcript), `result` `subtype: "success"`, `is_error: true`, **`command_lifecycle cancelled`**; the `user` record **is** written under our uuid | +107 | ours | **confirmed** — `cancelled` / `is_error` are not a "no" | `S10-explicit-400.txt` |
| S7 text | tab, CRLF, U+200B, combining mark, ZWJ, NBSP, leading/trailing spaces: transcript and model request **byte-equal** to what we sent | — | ours | tolerance: exact | `S7-text.txt` |
| S8 timestamps | `user` record `timestamp` ≈ take-in (not our write, not the file write); `queued_command` = enqueue time; the echo copies the record's `timestamp` (queued: the enqueue time); a skipped repeat's echo has none | — | — | — | all |

## CONTRADICTS OR EXTENDS THE SPEC

Against `docs/plans/pod-4819-harness-receipt-proof.md` and the Claude rows of
`docs/measurements/pod-4834-receipt-proof/README.md`.

1. **Contradicts README / §7 Claude terminal "an idle submit … `user` record (+71 ms) and
   `UserPromptSubmit` (+167 ms)" ("the record is written about 100 ms before the hook").** Over
   17 idle sends the hook came first every time (median +85) and the record was written after the
   model request in 16 of 17 (median +240). SIGKILL at +200 / +286 ms left a prompt that the
   model had received, with `UserPromptSubmit` and `history.jsonl` written, and **no transcript
   record; after resume it is not in the conversation**. So for §4 `confirmed` only the transcript
   record counts; `UserPromptSubmit`, `history.jsonl` and "the model answered" are at most
   `accepted`. A `PreToolUse` came before the prompt's record (A1: +139 vs +240): a tool can start
   on a prompt whose record is not yet on disk.
2. **Contradicts README / §7 "run after the turn … no `UserPromptSubmit`"** as a rule: in A14
   the hook was deferred to take-in and carried the queued prompt's own `prompt_id`. Which of the
   two happens is timing-dependent; turn tracking must not assume one `UserPromptSubmit` per
   Enter at Enter time, nor none at take-in.
3. **§5.1 for the Claude terminal:** the only id a queued prompt gets before take-in is none;
   `source_uuid` appears only in the `queued_command` attachment (hooks, `enqueue`, status line
   and `history.jsonl` never carry it). An idle or after-turn prompt has its `promptId`, which the
   hook also carries *when it fires with that id*. Binding a terminal send to an entry therefore
   rests on §5.3 (or on a wrapped id in the text).
4. **§5.3 preconditions, Claude terminal:**
   - *History order = submit order:* held in every run (A12, A13, A14, Escape and send-now
     included). Record *file* order is not event order around an interrupt: after Escape the
     queued prompt's `user` record precedes the interrupted `tool_result` and the interrupt marker.
   - *Every prompt entry comes from a submit:* **no**, unless "prompt entry" is defined as a
     `user` record with `promptSource` ∈ {`typed`, `queued`} or a `queued_command` attachment
     with `commandMode: "prompt"` and `origin.kind: "human"`. Entries nobody typed, all `user`
     type: interrupt markers, synthetic `tool_result`s (also after resume), Stop-hook feedback
     (`isMeta`), task notifications (`promptSource: "system"`), slash-command records
     (`<command-message>`, `<command-name>`, `<local-command-stdout>`, the caveat), the compact
     summary (`isCompactSummary: true`). `packages/harness/src/adapters/claude-code/transcript.ts`
     has no `isCompactSummary` filter (§7 *read* confirmed by run: the summary is a `user` record).
   - *Merging:* several queued prompts are **never merged into one entry** (separate attachments
     or separate `user` records, each with its own id), though they reach the model in one
     request. Identical texts are kept as separate entries (but `history.jsonl` drops a
     consecutive repeat — do not read prompts from `history.jsonl`).
   - *Text tolerance:* tab → 4 spaces; CR / CRLF → LF; U+200B removed (and its Enter swallowed);
     everything else exact, no Unicode normalisation.
   - *A counted foreign write the program itself makes:* a background task's completion creates
     a `promptSource: "system"` entry with `UserPromptSubmit`; send-now creates none beyond the
     queued prompt's own entry.
5. **§5.2 position/time:** the transcript `timestamp` is set at creation and the line is written
   up to ~800 ms later; `queued_command` carries the *enqueue* time and is written seconds later;
   synthetic post-resume records carry the *resume* time and are written at the next submit. So
   entries can lie **after** a saved position yet carry a timestamp **before** the saved time
   (another prompt enqueued earlier and taken in now; a prompt whose Enter preceded the save; the
   post-resume synthetics). The position floor and the time floor disagree on exactly these
   entries; §5.2's "or" must say which one wins for Claude (the time floor excludes them, the
   position floor admits them to §5.3's checks).
6. **§6.1 N1 has a Claude-terminal form:** a `UserPromptSubmit` block of a queued prompt writes
   `queue-operation remove` with `reason: "dropped_by_hook"`; an idle block writes a
   `system/informational` record and no `user` record. Upstream #96891 is *run*: the `enqueue` is
   written first, so `enqueue` alone is at most `accepted`.
7. **§6.1 N2 precondition fails for Claude (both transports):** an explicit model API error
   leaves the prompt recorded and in the conversation; the SDK then reports
   `command_lifecycle cancelled` and `result.is_error: true`. Neither is a "no". No run produced
   an explicit refusal of a user line by the CLI itself, other than a skipped repeat.
8. **§6.1 N4 precondition holds (both transports), with a caveat:** nothing Claude held survives
   an exit — a queued prompt (terminal SIGTERM/SIGKILL, SDK SIGKILL) and an unwritten idle record
   are gone after resume, and the resumed conversation does not contain them. But "not in the
   history" can still mean the model saw it once (S10 +200/+286), and a graceful SDK stdin close
   does finish the queue. N4 is right about the conversation, not about side effects.
9. **§4 `accepted` then lost (Claude's Escape, POD-4849 wording):** *not* observed on 2.1.284.
   Escape (terminal) and `interrupt` (SDK) with a prompt queued both ran the queued prompt as the
   next turn at once. Loss of an `accepted` prompt was observed only at process exit.
10. **§7 Claude SDK, "what sets `confirmed`":** the transcript record under our uuid (`user.uuid`
    or `queued_command.attachment.source_uuid`) is the proof. On the stream, `command_lifecycle
    completed` or `cancelled` of a line that had `started` came after its record was on disk in
    28/28 cases — a candidate stream signal for `confirmed`, *run* only as an observed order.
    `queued`/`started` are `accepted` only (SIGKILL right after them left nothing), and the
    timestamped echo is not proof of the record either.
11. **§3.8 resend under the same id, Claude SDK: run.** The CLI skips a repeated uuid that is in
    the transcript (lone `completed`) *or still in its queue/running* (echo only, no lifecycle),
    and runs a repeat whose first copy was lost (queued line lost to SIGKILL; idle line killed
    before its record). So recovery by resend is safe, and N3 is not needed for this transport.
12. **§7 Claude SDK "busy and steer":** a line sent while busy goes into the running turn at the
    next tool boundary (`queued_command`, our uuid as `source_uuid`) or becomes the next turn
    after streamed text; `priority:"now"` preempts streamed text at once and a tool at its end,
    and marks the preempted line `cancelled` although it stays in the conversation. The TUI's
    send-now differs: it moves a running Bash to the background.
13. **§7 Claude terminal, hook coverage:** 13 of 33 events fired; none marks take-in at a tool
    boundary or the model call. `MessageDisplay` (new here) fires per assistant message with
    `prompt_id`/`turn_id`/`message_id` — a reply signal, not a receipt.

Not run: a prompt that makes Claude compact on its own (auto-compact), `Notification`-type
events, Claude Desktop's merging (#53670), and any version other than 2.1.284.
