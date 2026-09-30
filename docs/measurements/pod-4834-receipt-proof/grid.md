# Receipt grid — every program, one table (POD-4834)

What each agent program reports when it takes a message, measured on the real CLI on
2026-09-29 against a fake model server (ground truth for "the model got it"). This page only
summarises; every cell comes from the lane's `results.md`, which has the evidence files, the
ranges and the scenarios behind it. Times are ms after the send (Enter, or our protocol write).
Expanded-input measurements from 2026-09-30 are in [§7](#7-expanded-input-storage-2026-09-30-pod-4984).
They extend the short-prompt text claims in §3; the original versioned timing runs remain separate.

Lanes: Claude terminal + SDK `claude-2.1.284/results.md` (POD-4862); Codex app-server + terminal
`codex-0.155.0/results.md` (POD-4863, builds on POD-4835); Grok ACP `README.md` §Grok and
`grok-acp-1.0.44/` (POD-4837); Grok terminal `grok-tui-1.0.44/results.md`, Cursor
`cursor-agent-2026.07.23/results.md`, Pi `pi/results.md` (POD-4865); OpenCode HTTP v1, v2 and
terminal `opencode-1.18.33/results.md` (POD-4864; v2 also on opencode2 beta-18866).

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
| OpenCode · HTTP v1 1.18.33 | **Yes** — `messageID` and text part `id` | None: a message is stored at once, idle or busy (no queue outside the history) | Text part row with our part id (warm +39–395; cold first prompt +2 202); `chat.message` hook carries our `messageID` | The 204 (a SIGKILL 67 ms after it lost the message, one run). The message row (existed ~2 s without text; survived a kill with no text). |
| OpenCode · HTTP v2 1.18.33 | **Yes** — `id` on `POST /api/session/{id}/prompt` | 200 admission +24–105 warm (ours, `admittedSeq`), `session.next.prompt.admitted`; **durable** (survived SIGKILL at the 200) | `session.next.prompted` + `session_message` user row, our id (idle +66–105; queue: at turn end; steer: at step end) | `GET /api/session/{id}/message` lists it only after `prompted`. No `chat.message` hook for v2 prompts. |
| OpenCode · HTTP v2 beta-18866 (`opencode2`) | **Yes** — `id` (body `{id, text, delivery}`, refused by 1.18.33) | 200 +24–68 (ours, no seq), `session.inbox.enqueued`; durable | `session.inbox.delivered` + user row (inbox row deleted) | User row `time.created` = delivery time, not admission |
| OpenCode · terminal 1.18.33 | No — OpenCode mints every id | None separate: stored at once, even when the screen says QUEUED | User message row + text part (+27–227) | `prompt-history.jsonl` (no id, no time, skips repeats, kept a line whose text was lost). A text-less user row (a kill at ~35 ms left one; it never reaches the model). |
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
| OpenCode · HTTP v1 / terminal | Stored at once; reaches the model at the next step of the running turn (+6–8 s here). After an interrupt it stays stored and **unanswered** until another prompt starts a turn | v1: hook + rows under our id; terminal: rows (OpenCode ids) | At the send |
| OpenCode · HTTP v2 (both builds) | `delivery: queue` → promoted at turn end, new turn; `steer` → at the end of the running step. After an interrupt or restart a pending input is **not** run until another prompt arrives or its id is resent | 200 + admitted/enqueued event (ours) | At promotion (+6–8 s here) |

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
| OpenCode · HTTP v1 | Safe only with **both** ids fixed and the **same** text (records nothing new, a busy→idle blip). Different text **overwrites** the stored text; no part id → text added twice; an id from another session overwrites that session's text | Stored busy message survives a kill, unrun; idle kill 67 ms after the 204: lost. Resend of a stranded message runs it once | Recorded; `session.error` arrives later, never as the reply | 400/404: nothing recorded | Yes | — | Byte-exact |
| OpenCode · HTTP v2 1.18.33 | **Deduplicated**: repeat returns the original admission; different text or another session's id → **409** (means *already recorded*, not a "no") | Admission survives SIGKILL, pending and unrun; a resend under the same id and text starts it. N3/N4 hold only if pending admissions (`session_input`, event log) are read | Recorded | 400/404: nothing recorded | — | — | Byte-exact |
| OpenCode · HTTP v2 beta-18866 | Deduplicated; different text → 200 with the **original**; another session's id → 409 | As 1.18.33 (`session_inbox`) | — | 400/404: nothing recorded | — | — | Byte-exact |
| OpenCode · terminal | Two user messages, never merged (`prompt-history.jsonl` drops the repeat) | Stored message survives a kill, unrun until the next prompt; a kill at ~35 ms left a text-less row (text lost) | Recorded | — | Yes (also keyboard vs HTTP 10 ms apart) | `/compact` (text-less user message), custom command (stored as its expanded template), crash half-records, messages sent over HTTP into the session | Typed exact; a paste gets a **trailing space** (a final newline becomes it) |

## 4. Position and time (spec §5.2)

| Program | Append-only history? | Record timestamp |
|---|---|---|
| Claude (both) | Transcript: yes | Set at creation, written up to ~800 ms later; `queued_command` carries its enqueue time; post-resume synthetics carry the resume time — so a record can sit after a saved position with a time before the saved time |
| Codex (both) | Rollout: yes, also across resume, interrupt and `/compact`; `ordinal` per line | Write time, ms, monotonic in file order |
| Grok (both) | `updates.jsonl`: yes. **`chat_history.jsonl`: no** — replaced by rename on cancel and resume, earlier lines rewritten, compaction 62 → 5 lines | `updates.jsonl`: whole seconds + `_meta.agentTimestampMs` (dispatch time); not in event-id order; `chat_history` has none |
| OpenCode v1 / terminal | SQLite rowid = insert order | `time.created` = when the server handled the request (ms), before the row write; the text part's time = its write |
| OpenCode v2 1.18.33 | Per-session `seq` + replayable `GET /api/session/{id}/event?after=` | Admission time (user row `time_updated` = promotion) |
| OpenCode v2 beta-18866 | `seq` on rows, no replayable event endpoint | User row = delivery time |

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
- OpenCode driver: the `opencode2` client's v2 body is refused by 1.18.33 (400 "Missing key
  prompt"); its comment that an id from another session answers with that session's input did
  not hold on either build (409) (OpenCode lane).

## 6. Still not run

- OpenCode: attachments, auto-compaction, subagent notifications, permission prompts; each
  kill case once.
- **Cursor** past the submit: needs real credentials or the separate `agent-cli-local`.
- **Pi**: not installed.
- Claude: auto-compact, Desktop's queued-prompt merging (upstream #53670), any version but 2.1.284.
- Grok terminal: a blocking `UserPromptSubmit` / `Stop` hook; scheduler (`/loop`) fires.

## 7. Expanded input storage (2026-09-30, POD-4984)

Measured with fresh scratch HOMEs, dummy keys and a localhost fake model: **2, 10, 200 lines;
1, 16, 100 KiB single lines; tabs; CRLF; final LF**. Each shape is sent plain and with a
strict Podium frame: **18 inputs per method**. The frame adds 144 UTF-8 bytes; 100 KiB is
102,400 B plain / 102,544 B framed. [Exact corpus, hashes, methods and bounded observations](expanded-input/README.md).
Codex here is **0.159.0**, separate from the 0.155.0 timing baseline. Claude terminal's row
belongs to POD-4982 and is not changed by this issue.

| Program · path | Native prompt records | Length, wrappers and splitting | Control bytes | Our id / frame | Results |
|---|---|---|---|---|---|
| Codex app-server 0.159.0 | 18/18, one `UserMessage` each | Every input byte-exact through 100 KiB; no wrapper, truncation or split | Tabs, CRLF, final LF exact | `client_id` = ours; 9/9 frames | [Codex](codex-0.159.0/results.md), [API bytes](expanded-input/codex-app-server/results.md) |
| OpenCode HTTP v1 1.18.33 | 18/18, one user text part each | Every input byte-exact through 100 KiB; no wrapper, truncation or split | All exact | Message and part ids survive; 9/9 frames | [v1 bytes](expanded-input/opencode-v1/results.md) |
| OpenCode HTTP v2 1.18.33 | 18/18, admission plus one delivered user row | Every input byte-exact through 100 KiB; no wrapper, truncation or split | All exact | Our id survives; 9/9 frames | [v2 bytes](expanded-input/opencode-v2/results.md) |
| OpenCode HTTP v2 beta-18866 | 18/18, one delivered user row | Every input byte-exact through 100 KiB; inbox consumed, no wrapper, truncation or split | All exact | Our id survives; 9/9 frames | [beta bytes](expanded-input/opencode2-v2/results.md) |
| Grok ACP 1.0.44 | 18/18, one `updates.jsonl` user chunk | Full native bytes, no wrapper/split. Model history uses `user_query`; 100 KiB spills full text to file and sends an excerpt | All native bytes exact | Our `promptId` on turn record; 9/9 frames | [Grok ACP / offload](grok-acp-1.0.44/results.md) |
| Codex terminal 0.159.0 | Paste 18/18; final unbracketed buffer 12/18 | Full paste through 100 KiB, one record, no wrapper/split. 200 lines and 16/100 KiB unbracketed: no record within bound | Paste CRLF → LF, final LF trim. Unbracketed CRLF → two LFs; key-chunk tab case drops tabs | TUI id; every stored frame valid (paste 9/9, buffer 6/6) | [Codex](codex-0.159.0/results.md), [final buffer](expanded-input/codex-terminal-raw/results.md) |
| OpenCode terminal 1.18.33 | Paste 18/18; final key chunks 12/18 | Full paste through 100 KiB, one text part, no conversation wrapper/split. Edit history has paste placeholders. Larger key-input cases: no record within bound | Most pastes +SP; CRLF → LF; key-input tabs removed. Plain final LF kept | CLI id; every stored frame valid (paste 9/9, key chunks 6/6) | [Both-build report](opencode-1.18.33/results.md#expanded-input-storage-2026-09-30-pod-4984), [paste](expanded-input/opencode-terminal/results.md), [key chunks](expanded-input/opencode-terminal-paced/results.md) |
| OpenCode terminal beta-18866 | Paste 18/18; final key chunks 12/18 | Same measured full native text and auxiliary placeholder distinction; larger key-input cases: no record within bound | Same measured forms as stable | CLI id; every stored frame valid (paste 9/9, key chunks 6/6) | [Paste](expanded-input/opencode2-terminal/results.md), [key chunks](expanded-input/opencode2-terminal-paced/results.md) |
| Grok terminal 1.0.44 | Paste 18/18; final key chunks 18/18 | One full native chunk through 100 KiB, no native wrapper/split. Same model-history offload as ACP | Paste TAB → four SP, CRLF/final LF kept; key-input TAB removed, CRLF → LF, final LF kept | Grok id; 9/9 frames in both methods | [Grok terminal](grok-tui-1.0.44/results.md#expanded-input-storage-2026-09-30-pod-4984), [key chunks](expanded-input/grok-terminal-paced/results.md) |

Byte counts and all control variants are in the [control-byte table](expanded-input/README.md#results-across-programs)
and linked per-case reports. “No record within bound” has **no** frame or matching verdict;
it is not persisted truncation. The final 100 KiB unbracketed windows were 512–539 s without
a visible editor tail for Codex/OpenCode; two subsequent Enter attempts produced no prompt.
Grok reached its plain/framed tail at 196/250 s and stored all bytes. **POD-5011 — Long terminal
input drain** is an unclaimed top-level Proposed discovery for Podium's injection/pacing boundary.
Earlier short-window and tmux command-limit diagnostics are retained separately.

Literal startup-argument storage probes bypass keyboard ingestion. Codex and beta OpenCode
record 18/18 complete prompts (CRLF → LF; other bytes retained); beta needs Enter after its
prefill. Stable OpenCode records 16/18 byte-exact; its two CRLF inputs stay prefilled with no
record within 48 s. These do not replace the terminal keyboard observations.

At 100 KiB, Grok's `updates.jsonl` stores 102,400/102,544 B; the spill file stores the full
`<user_query>` wrapper, 102,427/102,571 B. Its model history and main model request instead
contain a **99,095 B** excerpt plus offload note. The strict frame is reliable in the full
native chunk; proof must keep reading that chunk. [Exact offload evidence](grok-acp-1.0.44/results.md#model-history-and-100-kib-offload).

Reader/matching changes are filed as unclaimed sub-issues under POD-4819:

- **POD-5003 — Codex terminal text matching:** one/two-LF CRLF forms and the measured tab-removal form.
- **POD-5004 — OpenCode terminal text matching:** CRLF normalization and unbracketed tab removal in both builds.
- **POD-5005 — Grok terminal text matching:** pasted tab expansion, unbracketed tab removal and CRLF normalization.

This issue changes only measurement files. The full decoded bytes, native record objects,
file positions/rowids, protocol ids, model inputs and per-case SHA-256 comparisons are saved.
No production reader or driver is fixed here; no runtime test gate was run for this docs-only work.
POD-4720 receives the tip for operator-approved ff-only landing onto `dev/mw`.
