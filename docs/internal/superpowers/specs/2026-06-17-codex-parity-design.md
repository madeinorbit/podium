# Codex parity with Claude Code — design

- **Date:** 2026-06-17
- **Branch / worktree:** `worktree-codex-parity` (`.claude/worktrees/codex-parity`), based on local `main` `95ba619`
- **Status:** design approved; spec under review

## Goal

Bring Podium's support for **Codex** sessions up to the same standard as **Claude Code**. Concretely, a running Codex agent should get:

1. A structured **chat view** (not just the raw PTY).
2. **BTW / superagent** seeding from its transcript — for **live and parked** (hibernated/exited) sessions, and `read_session_transcript` parity.
3. **Automatic session titles** derived from the first prompt (instead of a UUID).
4. A **phase/state badge** (working / idle / ended), best-effort attention sub-states.
5. The panel controls that are currently hidden for Codex: the **BTW (✨) button**, the **hibernate (🌙) button**, and the **chat ↔ live switcher**.

The user explicitly chose **full parity** and **best-effort** state depth, and confirmed the **parked** transcript path must be fixed (not just live).

## Background: how the codebase is shaped

- `AgentKind = 'claude-code' | 'codex' | 'grok' | 'shell'` (`packages/protocol/src/messages.ts`). Codex **is** a first-class foreground PTY agent: `packages/agent-bridge/src/launch.ts` spawns `codex [resume <value>] [--model …]`. (The settings migration that turned `harnessAgent:'codex'` into an API backend only affects the *superagent LLM backend*, not the foreground session.)
- Two instrumentation styles already exist:
  - **Hook-based** (Claude Code): `instrumentation()` injects `--settings hooks.json`; hooks POST events to the daemon.
  - **Filesystem-observer** (Grok): `instrumentation()` returns `{ args: [] }`; the daemon polls/tails the agent's own session files for both transcript items and state. **This is the template for Codex** — Codex has no hook system either.
- `agentStateProviderFor(kind)` (`packages/agent-bridge/src/agent-state/claude-code.ts`) returns a provider for `claude-code` and `grok`, `undefined` otherwise. Codex currently has none → its badge reads a generic "working".
- The chat pipeline: a daemon **tailer** (`packages/agent-bridge/src/transcript/tailer.ts`) reads a JSONL file, runs a per-record `recordToItems` converter into `TranscriptItem[]`, and `send({type:'transcriptAppend', …})`. Converters exist for Claude (`transcript/claude.ts`) and Grok (`transcript/grok.ts`). **None for Codex.**
- The daemon's `readParkedTranscript` (`apps/daemon/src/daemon.ts`) branches grok-vs-claude only; Codex falls into the Claude path and finds nothing.

### The key insight

Codex writes **one JSONL rollout per session** at `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl`. That single file contains **both** the conversation **and** clean state signals. So **one file-tailer feeds chat, BTW, and the phase badge** — we clone Grok's observer→tail pattern rather than invent anything. The discovery layer (`packages/agent-bridge/src/discovery/providers/codex.ts`) already parses these files; we reuse its helpers.

### Why the panel controls light up "for free"

Verified in `apps/server/src/session.ts` / `apps/server/src/relay.ts`:

- `transcriptAvailable` flips `true` the moment transcript items arrive (`session.ts:242`). → chat/live switcher **and** the ✨ BTW button (both gated on `chatCapable`) appear once `tailCodexTranscript` sends a frame.
- `resumable` is `true` whenever the session has a resume ref (`session.ts:489`), set by the `sessionResumeRef` handler (`relay.ts:901`). → the 🌙 hibernate button (gated on `resumable`) appears once the observer emits a Codex resume ref.

So the three "missing controls" the user noticed are downstream consequences of the data-layer work. The only deliberate UI edit is adding `codex` to the `chatCapable` *fallback* list (`AgentPanel.tsx:71`) so the controls show **immediately** on spawn (like Grok), not just after the first frame.

## Verified Codex rollout format

Confirmed against a real file on this host (`~/.codex/sessions/2026/06/16/rollout-…019ed0c5….jsonl`, 570 lines). Envelope: `{ timestamp, type, payload }`.

| top-level `type` | role | notes |
|---|---|---|
| `session_meta` | header (1, first line) | `payload.id` (uuid == filename uuid), `cwd`, `git`, `cli_version`, `originator`, `timestamp` |
| `response_item` | **conversation** | OpenAI Responses item format — see below |
| `event_msg` | **state + clean user text** | TUI/telemetry events — see below |
| `turn_context` | turn config | ignored |

`response_item` `payload.type` values seen: `message` (user/assistant; `content[]` of `{type:input_text|output_text, text}`), `function_call` (`name`, `call_id`, `arguments` JSON string), `function_call_output` (`call_id`, `output` string|object), `custom_tool_call` / `custom_tool_call_output` (same shape), `reasoning` (`encrypted_content`, `summary` — no usable plaintext).

`event_msg` `payload.type` values seen: `user_message` (`message`, `text_elements`, `images` — the clean typed prompt), `agent_message` (assistant echo), `task_started` (`turn_id`, `started_at`, `model_context_window`), `task_complete` (`turn_id`, `duration_ms`, `last_agent_message`), `turn_aborted`, `token_count`, `patch_apply_end`.

**Note:** the first `response_item` messages are injected (`role:"developer"` permissions block, `role:"user"` AGENTS.md). These must be filtered out of the chat view.

## Design

Six touch-points, mirroring Grok's checklist.

### 1. `packages/agent-bridge/src/transcript/codex.ts` — `codexRecordToItems(record): TranscriptItem[]`

Pure per-record converter (same signature the tailer expects). Reuses `isRecord`, `stringField`, `contentToText`, `mapConversationRole` from `discovery/jsonl.ts` and `codexPayload` logic.

Mapping (one source per turn-kind to avoid duplication — `event_msg.user_message` and `response_item.message(user)` both exist):

| record | → TranscriptItem |
|---|---|
| `event_msg` `user_message` | `{role:'user', text: text from text_elements/message}` |
| `response_item` `message` role `assistant` | `{role:'assistant', text: contentToText(content)}` |
| `response_item` `message` role `user`/`developer` | **skip** (injected/duplicated) |
| `response_item` `function_call` / `custom_tool_call` | `{role:'tool', toolName:name, toolInput: preview(arguments), toolUseId: call_id}` |
| `response_item` `function_call_output` / `custom_tool_call_output` | `{role:'tool', toolResult: output (≤2000 chars), toolUseId: call_id}` |
| `response_item` `reasoning` | **skip** (encrypted) |
| `session_meta`, `turn_context`, other `event_msg` | **skip** |

`function_call` and `function_call_output` are **separate** records (unlike Claude's nested blocks); each maps to its own item and the web ChatView pairs them by `toolUseId` (it already does this for Claude). Timestamps from the envelope `timestamp`. A stable `id` per item (e.g. `call_id` for tools, else envelope ts + index).

### 2. `packages/agent-bridge/src/agent-state/codex.ts` — `codexStateProvider`

Observer-style provider, exactly like Grok's:

- `instrumentation()` → `{ args: [] }` (no CLI/file injection).
- `translate(payload)` maps an `event_msg` record → `AgentStateEvent[]`:

| `event_msg.type` | event |
|---|---|
| `user_message` | `prompt_submitted` |
| `task_started` | `prompt_submitted` (→ working) |
| `agent_message`, `token_count`, `patch_apply_end` | `activity` |
| `task_complete` | `turn_completed` with verdict classified from `last_agent_message` |
| `turn_aborted` | `turn_completed` (idle) |

- `bootEvents({cwd, resumeValue})` — on resume, read the rollout tail and classify the last turn (mirror `grokBootEvents` / `classifyGrokIdleTranscript`); else emit `session_started` (idle).
- `observeCodexState({cwd, resumeValue, startedAtMs, onSession, onEvents})` — polls `~/.codex/sessions` for the live rollout (see §4), reads `event_msg` records via the same tail, and emits events. Registered in `agentStateProviderFor` and exported from `agent-state/index.ts`.

**Verdict classification (best-effort):** `task_complete.last_agent_message` ending in a question mark → `idle.question` ("needs answer"); otherwise plain `idle` (done). Approval/plan-ready states are **not** reliably present in the rollout (approvals happen interactively in the TUI before any record is written) — we do not fake them. Documented limitation.

### 3. `packages/agent-bridge/src/discovery/providers/codex.ts` — first-prompt title

Add `firstCodexPrompt(records)` (parallels `firstUserPrompt` in the Claude provider): first `event_msg.user_message` (or `response_item.message` user that isn't an injected `<…>`/`# AGENTS.md` preamble), trimmed to ≤100 chars. Use it as the title fallback:

```
title: metadata?.title ?? promptTitle ?? fallbackTitle(file)
titleSource: metadata?.title ? 'native' : promptTitle ? 'heuristic' : 'filename'
```

(An equivalent fix exists unmerged on `worktree-audit-followup-fixes` `95220f9`; re-implemented clean here. Whichever lands second resolves a trivial conflict.)

### 4. `apps/daemon/src/daemon.ts` — wiring

- `startCodexStateObserver(sessionId, cwd, resumeValue, startedAt)` mirroring `startGrokStateObserver`: runs `observeCodexState`; on `onSession(rolloutId)` → `send({type:'sessionResumeRef', sessionId, resume:{kind:'codex-thread', value: rolloutId}})` then `tailCodexTranscript(...)`; `onEvents` → `applyAgentStateEvents`.
- `tailCodexTranscript(sessionId, rolloutPath)` → `ensureTranscriptTail(sessionId, rolloutPath, codexRecordToItems)`.
- `initSessionObservers`: add a `msg.agentKind === 'codex'` branch alongside the grok branch.
- `readParkedTranscript`: add `isCodex = msg.agentKind === 'codex' || msg.resume.kind === 'codex-thread'`; resolve the rollout path via the Codex state DB (`readCodexStateMetadata().byThreadId.get(value)?.rolloutPath`, reusing `codex-state.ts`), falling back to a glob `~/.codex/sessions/**/rollout-*-<value>.jsonl`; read with `codexRecordToItems`.

**Live-file identification (the #1 risk).** Mirror Grok's observer: poll `~/.codex/sessions/**/*.jsonl` for the newest file with `mtime ≥ startedAt` whose first-line `session_meta.cwd` equals the session cwd; take `session_meta.id` as the rollout id and emit the resume ref. The id must equal what the discovery provider produces so that `codex resume <id>` (already wired in `launch.ts`) actually resumes the same thread — **pinned by a test against a real rollout and a real resume**, not assumed.

### 5. `apps/web` — UI

- `AgentPanel.tsx:71`: add `'codex'` to the `chatCapable` fallback (`agentKind === 'claude-code' || 'grok' || 'codex'`) so controls show immediately.
- **Draft-sync (required).** Add `extractCodexPromptDraft(lines)` in `@podium/terminal-client` alongside `extractClaudePromptDraft`, parsing Codex's TUI input box off the rendered screen. `AgentPanel.tsx:112` selects the extractor by `agentKind` (`extractDraftFor(kind)`), so the in-progress native Codex prompt mirrors into the shared chat composer just like Claude's. First spike against a live Codex TUI to learn its prompt-box framing (border glyphs / prompt marker), then test the extractor with happy-dom screen fixtures like the Claude one. Screen-scraping a TUI is inherently fragile (redraws, wrapping) — the extractor must return `null` (never a partial/garbled string) when it can't confidently isolate the prompt, so a bad parse degrades to "no pre-fill" rather than clobbering the draft.
- `ChatView.tsx:304`: drop/adjust the "Codex sessions have no structured transcript (yet)" copy.
- No change needed to `panelLabel`/icons (already cover codex).

### 6. Registration & protocol

- `agentStateProviderFor`: return `codexStateProvider` for `'codex'`.
- Reuse the existing `codex-thread` resume kind — **no protocol change** expected. Confirm `ControlMessage.transcriptReadRequest` already carries `agentKind` + `resume` (it does, per `relay.ts:998`).

## Testing strategy (TDD)

The converter and the state `translate`/verdict logic are **pure functions over records** — ideal for tests-first. Plan:

1. Commit a small **fixture** rollout (a trimmed real `*.jsonl`: session_meta + injected preamble + a user_message + assistant message + a function_call/output pair + task_started/task_complete) under the agent-bridge test fixtures.
2. `transcript/codex.test.ts`: assert `codexRecordToItems` skips preamble/reasoning, pulls the clean user prompt, pairs tool call+output by `call_id`, orders correctly.
3. `agent-state/codex.test.ts`: assert `translate` mapping and `task_complete` verdict classification; `bootEvents` on a resumed fixture.
4. `discovery/providers/codex.test.ts`: extend existing test for `firstCodexPrompt` title (`heuristic` source).
5. Daemon: a unit test for the `readParkedTranscript` codex branch (rollout-path resolution) using a temp `~/.codex` layout, mirroring existing grok daemon tests.
6. **Live verification** (manual/e2e, gated by memory's browser caveats): spawn a real Codex session via the host, confirm chat renders, switcher/BTW/hibernate appear, hibernate→resume round-trips, parked BTW seeds. Run web tests via the package config (`apps/web` cwd), not the root aggregate.

## Out of scope

- Codex compaction phase (no compaction event observed) and approval/plan-ready attention states (not in the rollout) — best-effort only.
- Subagent-model env injection (Claude-only; N/A for Codex).
- Refactoring the scattered `agentKind ===` conditionals into a capability registry (tempting, but not required for this goal; would broaden the diff).
- The 4 pre-existing `shell.structure.test.ts` failures (stale `conn-tooltip`/`ms ping` source assertions from the Base-UI refactor) — unrelated; fix only if asked.

## Risks & open questions

1. **Live rollout-file identification / resume-id contract** (highest). Resolved empirically: test that the observer's `session_meta.id` is accepted by `codex resume` and matches discovery's id. Fallback: glob by uuid.
2. **User-text source.** Prefer `event_msg.user_message`; confirm every user turn emits one (sample had 7) and there's no double-count with `response_item.message(user)`. Pin with the fixture.
3. **Tool output size/shape.** `function_call_output.output` is sometimes a string, sometimes an object — normalize via `contentToText`/`stringField`, truncate to 2000 like Claude.
4. **Reasoning.** Encrypted; skipped. (Could later surface `summary` text if present.)
5. **Memory/host pressure.** This host has OOM history; observer polling must be as cheap as Grok's (700 ms) and stop on dispose.

## File touch list

- `packages/agent-bridge/src/transcript/codex.ts` (new) + test + fixture
- `packages/agent-bridge/src/agent-state/codex.ts` (new) + test
- `packages/agent-bridge/src/agent-state/index.ts` (export), `agent-state/claude-code.ts` (`agentStateProviderFor`)
- `packages/agent-bridge/src/discovery/providers/codex.ts` (`firstCodexPrompt`) + test
- `apps/daemon/src/daemon.ts` (observer, tail, parked-read branch)
- `packages/terminal-client/src/…` (`extractCodexPromptDraft` + `extractDraftFor(kind)`) + test
- `apps/web/src/AgentPanel.tsx` (chatCapable fallback, draft-sync extractor selection), `apps/web/src/ChatView.tsx` (copy)
