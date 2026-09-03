# Pi headless driver — design

Issue: POD-3220. Adds the Pi coding agent (`pi`, `@earendil-works/pi-coding-agent`) as a Podium
harness kind so its headless driver sits behind the same `HarnessHeadless` interface every other
driver uses. Reference: `docs/agent-harness-reference/pi.md`.

## Verified facts (Pi 0.84.4, run against a fake OpenAI-compatible provider)

- `pi -p --mode json --session-id <uuid>` creates the session under that exact id on the first
  turn (stderr warns "creating a new session with that id") and resumes it on later turns; the
  conversation carries across turns.
- The first stdout line is always the session header
  `{"type":"session","version":3,"id":"<uuid>","timestamp":"…","cwd":"…"}`, even before a
  provider call.
- Piped stdin becomes the user message verbatim (with an argv prompt it is concatenated), so the
  prompt rides stdin — no argv length limit.
- Event stream: `message_update` carries `assistantMessageEvent.type: 'text_delta'` with `delta`;
  `message_end` carries the final `message` (`role`, `content[]`, `stopReason`, `errorMessage?`);
  `tool_execution_start` carries `toolName`; `agent_settled` ends the run.
- `--no-tools` makes Pi refuse tool execution ("Tool bash not found", `isError: true`) even when
  the model emits a tool call.
- A provider failure exits **0**. The only signal is an assistant `message_end` with
  `stopReason: 'error'` and `errorMessage`, retried up to three times, then
  `auto_retry_end { success: false, finalError }`.
- Session file: `<PI_CODING_AGENT_DIR>/sessions/--<cwd slug>--/<timestamp>_<uuid>.jsonl`, slug =
  `cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')` (from Pi's `session-manager.js`). Entries:
  `model_change`, `thinking_level_change`, `message` (roles `user`, `assistant`, `toolResult`,
  `bashExecution`, `custom`), `session_info`, `compaction`. Tree via `id`/`parentId`.
- Pi runs cleanly under abduco (the durable runner's PTY): exit 0, full event stream.
- `pi --list-models` prints a whitespace table `provider model context max-out thinking images`
  on stdout.

## Shape

**Kind.** `'pi'` joins `AgentKind` and `HarnessAgent` in `@podium/model`; `BuiltinHarnessKind`
derives from it, so the registry's exhaustive record forces a manifest.

**Manifest** (`packages/harness/src/manifests/pi.ts`):

- `headless`: `driver: 'resume-exec'`, `outputFormat: 'pi-jsonl'` (new),
  `resumeIdAllocation: 'daemon-minted-uuid'` (the server pre-mints; `--session-id` is
  create-or-resume), `noTools: 'enforced'`.
  `buildExec` → `pi -p --mode json --session-id <id> [--model m] [--thinking e]
  [--append-system-prompt sys] [--append-system-prompt ctx] (--approve | --no-approve)
  [--no-tools --no-extensions --no-skills --no-context-files --no-prompt-templates]`, prompt on
  `stdin`. `HarnessHeadless.buildExec` gains an optional `stdin` (the durable runner already
  supports it; the in-process `runChild` learns to write it).
- `launch`: `pi [--session <id> | --session-id <new>] [--model] [--thinking]
  [--append-system-prompt <instructions>] [-- <prompt>]`; `newSessionIdFlag: true`.
- `exec`: `pi -p --no-session [--model] [--thinking] [--append-system-prompt sys]`, prompt on
  stdin, plain text out.
- `inventory`: executable `pi`, `--version`, identity probe `--help` must contain
  `pi - AI coding assistant` (the name is tiny; refuse unrelated `pi` binaries). Login detection
  reads `auth.json` provider entries → `in` (account = provider list) else `unknown` (env-var
  credentials are invisible to a file probe). Login identity = sha256 fingerprint over provider
  names + credential hashes. No native login command (`/login` is in-TUI); no portable credential.
- `transcript`: file chain located by cwd slug + `*_<id>.jsonl` (whole-root fallback), mapper
  `piRecordToItems`, runtime reader `piRuntime` (`model_change` / `thinking_level_change`).
- `state` + `observer`: poll channel (0.7) tailing the session JSONL; assistant `stopReason`
  is the turn boundary (`stop` → done/question, `error` → failed, `aborted` → interrupted,
  `toolUse` → activity).
- `discovery`: provider `pi-sessions`, root `<agent dir>`, files `sessions/**/*.jsonl`, summary
  from header + first user message, resume `{ kind: 'pi-session', value: id }`.
- Unsupported with reasons: `handoffTranscript`, `classifyBrowserOpen`, `loginCommand`,
  `loginCommandProbe`, `portableCredential`.

**Daemon.** One pure reducer (`apps/daemon/src/pi-stream.ts`) folds Pi events into
`{ sessionId, partial text, tool label, final output, error }`; `headless-drivers.ts` uses it in
the pinned-id `resume-exec` path, and `durable-headless.ts` uses it in both `outcomeFromOutput`
and `createDurableProgressParser`. A final assistant `stopReason: 'error'` becomes a
`HeadlessTurnError` carrying the session id.

**Product surface.** Labels ("Pi"), a π glyph icon, new-panel row, issue agent picker, model and
effort catalogs (thinking ladder `off … max`), settings, mobile launch list, server enums, runtime
defaults, model probe (`--list-models`).

## Out of scope

- OSC title / composer scrape / hook install (Pi has no shell-hook surface; an extension-based
  channel is a follow-up).
- Cross-machine handoff, credential propagation.
