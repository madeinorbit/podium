# Concierge/Superagent → Unified Streaming Chat — Design

Date: 2026-07-06
Status: draft, pending user review

## Problem

The sidebar concierge (and BTW/Global superagent threads) has poor UX:

- **No streaming.** A turn is one blocking tRPC mutation. The daemon runs
  `claude -p` / `codex exec` as a one-shot child, buffers the *entire* stdout
  (`daemon.ts` harnessExec, 4MB maxBuffer), and the reply appears all at once
  after the run completes. The only feedback meanwhile is a "Thinking… Ns" pulse.
- **Wrapper-managed context.** Each turn re-folds recent history into the prompt
  (`renderHarnessPrompt`), so the underlying agent has no persistent session:
  context quality degrades, and Podium carries context-management burden the
  harness is built to own.
- **Second-class renderer/composer.** `SuperagentView` has its own flat
  `SuperMessage[]` rendering and a bare textarea, divergent from ChatView's
  tool batching, windowing, image attach, minimap, etc.

State of the art (omnara, happy, vibe-kanban, humanlayer, crystal, conductor,
opencode) is unanimous: the **harness owns the session** (resume by id), and the
wrapper drives it through a structured surface — never by re-sending context,
and never through hidden TUIs.

## Decision summary (approved in brainstorming)

1. **Driver: first-party structured surfaces.**
   - Claude: **Claude Agent SDK** (TypeScript), streaming-input mode.
     Process-per-turn with `resume: <sessionId>` (the battle-tested shape used
     by vibe-kanban/humanlayer/crystal) rather than one eternal process — the
     harness reloads full history from its own JSONL on each turn, so context
     persists with no long-lived process to babysit. `includePartialMessages`
     for token deltas; `canUseTool` callback for permissions; `interrupt()`.
     ToS-clean path for subscription auth.
   - Codex: **`codex app-server`** JSON-RPC over stdio (`thread/start|resume`,
     `turn/start`, token-level `item/agentMessage/delta`, `turn/interrupt`,
     structured approval requests).
   - Grok / Cursor / opencode: keep headless one-shot spawns, but upgraded to
     **persistent sessions** via `--session-id` / `--resume <id>` /
     `opencode run -s <id>` — harness-owned context, message-level only.
   - The old buffered `harnessExec` + API-fallback tool loop is retired from
     the superagent path (harnessExec remains for genuine one-shot chores).
2. **Scope: all superagent thread kinds** — concierge, BTW, Global — move to
   the new driver. No split-brain backends.
3. **UI: unify on ChatView via headless sessions.** Each superagent thread is
   registered as a Podium session of a new kind `headless` (no PTY). The
   harness writes its real transcript JSONL; the existing daemon tailer →
   `transcriptRead` / `transcriptDelta` pipeline serves it unchanged, and
   ChatView renders it natively (tool batching, windowing, cursors, paging,
   offline replica — all free). The sidebar panel embeds ChatView.
4. **Token-delta overlay.** Because we own the driver, headless threads can
   stream token-level partial text (SDK `stream_event`s / app-server deltas) —
   something native PTY sessions can never cleanly have (their transcripts are
   complete-message-level; nobody in the field scrapes tokens from PTY bytes).
   ChatView gains an *overlay row*: in-progress assistant text pushed over a
   lightweight WS frame, replaced when the real item lands via transcript tail.
   Native sessions simply never emit it.
5. **Terminal escape hatch.** All five harnesses share one session store across
   headless/interactive, both directions. "Open in terminal" spawns a normal
   Podium PTY session with the harness's resume argv (`claude --resume <id>`,
   `codex resume <id> --include-non-interactive`, `grok --resume <id>`,
   `cursor-agent --resume <chatId>`, `opencode --session <id>`). Hard rule:
   **one writer at a time** — the thread is locked (composer disabled, banner
   shown) while a terminal attachment is live, and vice versa.

## Architecture

### Backend

- **`HeadlessDriver` interface** (daemon side), one implementation per surface:
  - `ClaudeSdkDriver` — `query({ prompt, options: { resume, cwd, mcpServers,
    allowedTools, permissionMode, includePartialMessages } })` per turn.
  - `CodexAppServerDriver` — supervises `codex app-server` (spawn on demand),
    JSON-RPC client, `thread/resume` + `turn/start` per turn.
  - `ResumeExecDriver` — grok/cursor/opencode one-shot with session pinning.
  - Common surface: `startTurn(threadId, text) → events`, `interrupt(threadId)`,
    `sessionId(threadId)`, plus a permission callback hook.
- Drivers run **in the daemon** (same placement as harnessExec today: repo cwd,
  CLI auth, machine-local). Server↔daemon gets a small set of new relay frames:
  `headlessTurnStart`, `headlessTurnEvent` (status/partial-text/permission),
  `headlessInterrupt`, `headlessTurnResult`.
- **Thread ↔ session binding.** `SuperagentService` keeps thread rows (SQLite)
  but drops message storage for new turns; each thread stores
  `{ agentKind, harnessSessionId, podiumSessionId, cwd }`. The Podium session
  row (kind `headless`) points the existing transcript machinery at the
  harness's transcript file (Claude: `~/.claude/projects/<cwd>/<id>.jsonl`;
  Codex rollout; grok/cursor/opencode analogs — the codex-parity FS observer
  pattern generalizes).
  - Claude sessionIds are minted by us via `--session-id <uuid>` on first turn
    so binding is deterministic; others captured from first-turn output.
  - Codex caveat: resume may mint a new rollout file — re-resolve the tailed
    path after each turn.
- **Context seeding stays, management goes.** `buildConciergeSeed`/`Delta`
  (tracker digests) remain as *first-message content* on a fresh thread /
  re-entry delta as a prepended block on the next user turn — but no more
  re-folding of chat history; the harness owns history.
- **Permissions.** Headless threads run with the same posture as today
  (pre-answered: permission mode + allowedTools). The SDK `canUseTool` /
  app-server approval RPC is wired to auto-respond from that policy now;
  surfacing interactive approvals in the UI is a follow-on (issue to file).
- **Migration.** Old `SuperMessage[]` history is retained read-only: a thread
  opened with legacy messages shows them as a collapsed "earlier conversation"
  block above the new transcript. No conversion into harness sessions.

### Web

- **`SuperagentView` is replaced** by a thin panel shell: thread switcher header
  (kept), then an embedded **ChatView** bound to the thread's `podiumSessionId`,
  with ChatView's own composer (image attach, voice, drafts, optimistic echo).
  `SpawnedAgentCard`/follow behavior is preserved via the same tool-result
  rendering path ChatView already has (start_agent tool results get the card).
- **ChatView additions** (all gated on session kind `headless`):
  - partial-text overlay row driven by `headlessTurnEvent` frames;
  - Stop button → `headlessInterrupt`;
  - "Open in terminal" action → creates the PTY session with resume argv and
    locks the thread;
  - send routes to `superagent.sendTurn` (new mutation, returns immediately;
    output arrives via transcript deltas) instead of `sessions.sendText`.
- Machine-authored context blocks (`[CONCIERGE CONTEXT]` etc.) keep their
  collapsed rendering — ChatView already collapses system-ish rows; add the
  matcher.

### Data flow (new)

user text → `superagent.sendTurn` (returns ack) → relay `headlessTurnStart` →
daemon driver spawns/resumes harness turn → (a) token/status events →
`headlessTurnEvent` WS frames → ChatView overlay; (b) harness appends its own
transcript JSONL → daemon tailer → `transcriptDelta` → ChatView items (overlay
row replaced as items land) → turn ends → `headlessTurnResult` clears busy state.

## Error handling

- Driver crash / nonzero exit mid-turn → `headlessTurnResult{error}`; thread
  shows an inline error row; next send retries with `resume` (harness transcript
  has everything up to the crash).
- Double-attach guard: sendTurn refuses while a terminal attachment is live for
  the thread (and vice versa: "Open in terminal" refuses mid-turn).
- SDK/app-server unavailable (old CLI, missing binary) → per-agent capability
  probe at driver init; fall back to `ResumeExecDriver` with an honest notice
  (same pattern as today's persisted flip/fallback notices).
- Transcript file not found after first turn (path resolution failure) →
  surfaced as thread error, not silent; turn output still recoverable from
  driver result.

## Testing

- Driver unit tests with fake harness processes (argv shape + protocol frames).
- **Real-binary smoke tests (skip-if-absent) are mandatory** for every
  constructed CLI invocation — the variadic `--allowedTools` incident applies
  doubly here (SDK spawn options, app-server RPC, resume argvs).
- Transcript-binding integration test: run a real 2-turn claude SDK session in
  a temp cwd, assert the headless Podium session tails it and turn 2 retains
  turn-1 context.
- Web: ChatView headless-mode tests (overlay row lifecycle, stop button,
  locked-thread composer) via existing vitest setup; one Playwright pass on the
  live UI for the embedded panel (per project rule: interactive UI needs
  real-click verification).
- Rollout: worktree → bun install in main checkout on merge (new dep:
  `@anthropic-ai/claude-agent-sdk`) + canary watch, per standing incidents.

## Explicitly out of scope (file as issues)

- Interactive permission prompts surfaced in the panel UI.
- Token overlay for grok/cursor/opencode (message-level only).
- Multi-writer concurrent attach (opencode supports it; we enforce one writer).
- Converting legacy SuperMessage history into harness sessions.
- ACP as a unifying layer (revisit if claude/codex ship stable ACP).
