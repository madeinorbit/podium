# cursor-agent 2026.07.23-e383d2b — what can be seen without a model (run 2026-09-29, POD-4865)

Everything below is **run** unless marked *read*. No real credentials were used and no login was
copied. Cursor cannot be pointed at a fake model, so **no scenario here reaches a model**: every
fact is about what the CLI does locally around a submit, up to the moment its agent run fails.

## Why there is no fake model

- The agent talks to Cursor's own backend (Connect/protobuf, `aiserver.v1.*` / `agent.v1.*`), not
  to an OpenAI or Anthropic wire. `--endpoint` / `CURSOR_API_ENDPOINT` moves that backend; a local
  server would have to implement Cursor's private protocol to run a turn.
- The bundle has a local-model mode (`--base-url`, `CURSOR_LOCAL_AGENT_BASE_URL`, OpenAI-compatible
  or Anthropic Messages — *read*), but this build refuses it: `cursor-agent --base-url
  http://127.0.0.1:47361/v1 -p …` exits 1 with `Error: --base-url can only be used with
  agent-cli-local`, and `CURSOR_LOCAL_AGENT_BASE_URL` is ignored (the run still goes to the
  endpoint). `agent-cli-local` ("Cursor Private Inference", binaries `agent-local` /
  `cursor-agent-local`) is a separate package that is not installed here (*read* for the name).

## Setup

- Scratch `HOME` holding `~/.cursor/hooks.json` with **all 20 hook event names found in the bundle** (*read*) (`sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `preToolUse`, `postToolUse`,
  `postToolUseFailure`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`,
  `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `afterAgentResponse`,
  `afterAgentThought`, `stop`, `subagentStart`, `subagentStop`, `preCompact`, `beforeTabFileRead`, `afterTabFileEdit`) — each running `hooklog.sh`.
- `CURSOR_API_KEY=dummy-not-a-key`, `CURSOR_API_ENDPOINT=http://127.0.0.1:47362`, `--trust`; TUI
  in a 180×45 tmux pane.
- `capture-server.ts` on 47362 logs every request (secrets redacted) and answers: a made-up
  unsigned token pair for `/auth/exchange_user_api_key`, one made-up model `fake-model` for
  `GetUsableModels` / `GetDefaultModelForCli` (field numbers read from the bundle), empty protobuf
  for everything else. That is enough for the TUI to reach its prompt. The agent run itself fails:
  it needs HTTP/2, the capture server speaks HTTP/1.1, and Cursor reports `[internal] Protocol
  error` after about 16 s of retries.
- The Grok `file-watch.ts` watched the scratch `~/.cursor` (20 ms poll).
- Outbound traffic: all Connect calls went to the capture server, but the CLI also opened TLS
  connections to Cloudflare addresses, one of them `api3.cursor.sh`, which the bundle hard-codes for
  its CLI metrics with its own built-in key (*read*). Their content is not visible (TLS).

Evidence: `raw/` (`marks.jsonl`, `hooks.jsonl`, `files.jsonl`, `requests.jsonl` — paths, sizes, and
printable strings only for `NameAgent`; `print-mode-transcript-1b74af65.jsonl`), `timelines/C1.txt`,
`timelines/C2.txt`.

## What was observed (ms after Enter)

| Scenario | Signals, in order | Ids | accepted / confirmed | Evidence |
|---|---|---|---|---|
| C1 idle submit, TUI | chat-scoped `~/.cursor/chats/<hash>/<chatId>/prompt_history.json` gets the text +168; **`beforeSubmitPrompt` hook +282** (`conversation_id` = chat id = `session_id`, a **new `generation_id` per submit**, `model`, `prompt` (exact), `attachments`, `transcript_path: null`); `NameAgent` request with the prompt text +696; the agent run never connects; after ~16 s: `agent-transcripts/<chatId>/<chatId>.jsonl` gets **only** `{"type":"turn_ended","status":"error","error":"[internal] Protocol error"}` (no user record), `meta.json` `hasConversation: true`, `stop` hook +15 894 with the same `generation_id`, `status: error`, `transcript_path` set. The chat's `store.db` root blob stays the hash of empty data. The text is on disk only in `prompt_history.json`. | `conversation_id`, `generation_id` (Cursor's own) | the hook = accepted at most; nothing confirmed | `timelines/C1.txt` |
| C2 a second prompt while the first is still retrying | first prompt as C1 (its hook +422). After C1 failed, the TUI had **put C1's text back into the input box**, so the typed text was appended to it and submitted as one prompt (a Phase D matter, POD-4821). The second prompt, sent while busy, goes to an on-screen "follow-ups" queue, **and at that moment** `prompt_history.json` gets it (+3 276) and **`beforeSubmitPrompt` fires with its own new `generation_id`** (+3 287). When the first run fails, the queued follow-up is **not run**; it stays in the on-screen queue. The transcript gained no new line (only its mtime changed). | as C1 | `beforeSubmitPrompt` fired for a prompt that never ran | `timelines/C2.txt` |
| `-p` (print mode), `--output-format stream-json` | `sessionStart` hook; **no `beforeSubmitPrompt`**; the stream reports `{"type":"connection","subtype":"reconnecting",…,"endpoint_url":"http://127.0.0.1:47362"}` and retries; `sessionEnd` hook (`final_status: error`); the transcript holds only the `turn_ended` error line; the prompt text is **nowhere** on disk. | `session_id` = conversation id | nothing | `raw/print-mode-transcript-1b74af65.jsonl`, `raw/hooks.jsonl` |

Hooks seen: `sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `stop`. The rest need a model turn.

## What cannot be measured without real credentials (or `agent-cli-local`)

Every scenario that needs a turn to run: S1–S5 with a model reply, S2/S3 busy in a tool or in text,
S4 interrupt of a running turn, S5 the same text twice reaching the model, S6 resume of a real
conversation, S7 what the model receives, S8 timestamps on real user records, S9 compaction and
other non-typed entries, S10 an error reply from the model and a kill after the prompt reached the
backend. In particular, **when the user record is written to `agent-transcripts` relative to the
model call, and what id it carries**, is unmeasured: here it was never written, because the run
never reached the backend. Whether the backend or the transcript keeps `generation_id` is unknown.

## CONTRADICTS OR EXTENDS THE SPEC

- **§7 row "OpenCode · terminal, Cursor, Pi"**: "Cursor cannot use a fake model server" holds for
  this build (run: `--base-url` refused); the local-model mode exists only in the separate
  `agent-cli-local` product. Measuring Cursor needs either real credentials or that product.
- **§4 `accepted`** candidate for Cursor's terminal: `beforeSubmitPrompt` (+282 ms, own
  `generation_id`, exact text). It also fires for a prompt that only entered the follow-up queue
  and never ran, so it is not `confirmed` and not even proof the prompt will run.
- **§5.2 / §6.1 N4**: when the run fails before the backend, the transcript has no user record at
  all, only `turn_ended` `error` — the prompt is not in Cursor's history. Whether a prompt that did
  reach the backend is in the transcript before the model answers is unmeasured.
- **Phase D (POD-4821), noted only**: after a failed run the TUI restores the failed prompt into the
  input box; the next typed text is appended to it.
