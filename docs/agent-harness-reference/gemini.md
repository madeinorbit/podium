# Gemini CLI — orchestrator integration reference

Target agent: Google's **Gemini CLI** — npm package `@google/gemini-cli`, binary `gemini`, source `https://github.com/google-gemini/gemini-cli`. Open-source Ink/React terminal coding agent.

This document is the authoritative integration reference for hosting Gemini CLI inside the multi-agent orchestrator. Each section answers the corresponding taxonomy category; methods are tagged **[established]** (proven integration path, the preferred way), **[fallback]** (works but secondary / generic), or **[not supported]**. Items not confirmable against a primary doc/flag are tagged **[unverified]**.

Primary CLI doc references (all under `https://github.com/google-gemini/gemini-cli/blob/main/`):
`docs/cli/cli-reference.md`, `docs/cli/headless.md`, `docs/cli/session-management.md`, `docs/cli/checkpointing.md`, `docs/cli/rewind.md`, `docs/cli/acp-mode.md`, `docs/cli/notifications.md`, `docs/cli/model.md`, `docs/cli/model-routing.md`, `docs/cli/telemetry.md`, `docs/cli/sandbox.md`, `docs/hooks/reference.md`, `docs/reference/keyboard-shortcuts.md`, `docs/reference/configuration.md`, `docs/reference/trusted-folders.md`, `docs/resources/quota-and-pricing.md`, `docs/get-started/authentication.md`.

---

## 1. Discovery & identity

- **Binary detection / "installed?"** — Binary name is `gemini` (npm `@google/gemini-cli`; also `brew install gemini-cli`, `npx @google/gemini-cli`). Decide "installed?" by PATH lookup of `gemini`. **[established]** No documented rename/remap or alias. For robustness against PATH gaps, resolve via `which gemini` / `where gemini`, then OS fallbacks `/usr/local/bin/gemini`, `/opt/homebrew/bin/gemini`, `~/.local/bin/gemini`, `~/bin/gemini`, with `realpath()` symlink resolution. **[fallback]** When node-pty reports the wrapper as `node`, recognize it by the entrypoint substring `node_modules/@google/gemini-cli/`. **[established]**
- **Version detection / gating** — `gemini --version` / `gemini -v`. **[established]** Behavior *does* gate on version, so the orchestrator should parse it to choose flags:
  - `--checkpointing` CLI flag was **removed in 0.11.0** (now `settings.json general.checkpointing.enabled` only).
  - `--yolo/-y` is **deprecated** in favor of `--approval-mode=yolo`.
  - Newer hook events (`BeforeToolSelection`, `PreCompress`) may be absent on old versions.
  Note: an integration that never calls `--version` can fail-open instead (hooks fail-open; resume tolerates missing sessions) — but version-aware flag selection is the safer path. **[established]**
- **Existing-session discovery (on-disk)** — Sessions live under a per-project temp dir keyed by a project hash:
  - `~/.gemini/tmp/<project_hash>/chats/<timestamped>.json` — auto-saved chat sessions, one file per session.
  - `~/.gemini/tmp/<project_hash>/checkpoints/<ts>-<file>-<tool>.json` — checkpoint (conversation + pending tool call), e.g. `2025-06-22T10-00-00_000Z-my-file.txt-write_file`.
  - `~/.gemini/tmp/<project_hash>/logs.json` — append-only log of user prompts (no model responses). **[unverified — community-sourced]**
  - `<project_hash>` is derived from the project-root abspath; exact algorithm (likely sha256 of cwd) is **[unverified]**.
  Scan glob: `~/.gemini/tmp/**` for `.json` and `.jsonl`. Both a legacy single-object `.json` form and a newer line-delimited `.jsonl` rollout form exist and must both be parsed (see §10). **[established]** Programmatic listing: `gemini --list-sessions`. **[established]**
- **Stable session identity** — Each session has a **UUID** (e.g. `a1b2c3d4-e5f6-7890-abcd-ef1234567890`), usable directly with `--resume <uuid>`. **[established]**
  - At launch / runtime: the id is emitted in `--output-format stream-json` `init` event (session id + model), in telemetry as `session.id`, and is delivered as the `session_id` field on every hook payload (see §8). **[established]**
  - For a pre-existing session: read the UUID from the on-disk chat `.json` (`sessionId` field, falling back to the filename), or via `--list-sessions` / the in-app `/resume` browser. **[established]**
  - There is **no documented OSC sequence** that emits the session id. **[not supported]**
- **Session ↔ repo/cwd mapping** — Implicit and 1:N via `<project_hash>` = hash of cwd/project root; `cd` switches which project's history is visible. **[established]** A `--worktree` flag and git-worktree support exist (`docs/cli/git-worktrees.md`). For orchestrator correlation, launch in the worktree dir and carry your own pane/workspace key in the hook callback env (see §8) rather than relying on the hash.

**Conflicts / open questions:** The on-disk layout is described two ways — a flat `~/.gemini/tmp/**` of `.json`/`.jsonl` files keyed by `sessionId`/filename, and a per-project `~/.gemini/tmp/<project_hash>/chats|checkpoints|logs` tree. Both are real; the `<project_hash>` subtree is the current documented structure, while the flat-scan + dual-format parser is the resilient discovery path that tolerates either. Scan recursively and key on the in-file `sessionId`. Exact hash algorithm and `logs.json` schema are unverified.

## 2. Launch & process model

- **Spawn mechanism** — **[established]** shell-PTY-with-typed-command: build a shell command string and run it in a PTY hosted by the orchestrator's local PTY provider, a daemon subprocess, or SSH. Direct exec also works for headless one-shots (§12).
- **Launch command + relevant flags** (`docs/cli/cli-reference.md`) — base `gemini [flags]`, no positional prompt for interactive. Notable flags: `--model/-m`, `--prompt/-p` (headless one-shot), `--prompt-interactive/-i` (seed a turn, stay interactive), `--sandbox/-s` (+ `--sandbox-image`), `--approval-mode <default|auto_edit|yolo>`, `--yolo/-y` (deprecated alias), `--include-directories`, `--all-files/-a`, `--extensions/-e`, `--list-extensions/-l`, `--resume/-r`, `--list-sessions`, `--delete-session`, `--skip-trust`, `--worktree`, `--screen-reader`, `--debug/-d`, `--output-format/-o <text|json|stream-json>`, `--proxy`, `--allowed-tools`, `--allowed-mcp-server-names`, `--experimental-acp` (a.k.a. `--acp`), `--experimental-zed-integration`, `--version/-v`, `--help/-h`.
- **Env injected** — orchestrator instrumentation: a per-pane workspace key, a hook callback endpoint, plus a port/token/version for the hook callback server (see §8). These are generic to the hook framework, not Gemini-specific. Config dir defaults to `~/.gemini` (the env var that overrides it is **[unverified]** — effectively `$HOME/.gemini`). The CLI also auto-loads `.gemini/.env` (cwd-upward, then `~/.gemini/.env`).
- **Env stripped** — Gemini reads these auth/config env vars: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS`, `GEMINI_DEFAULT_AUTH_TYPE`, `GEMINI_MODEL`. To force the CLI's own Google OAuth login, **strip inherited `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_GENAI_USE_VERTEXAI`** from the child env — they take precedence over the cached OAuth creds. **[established]**
- **Durable backing** — No built-in multiplexer. Survival across orchestrator restarts comes from (a) a daemon subprocess keeping the PTY alive + scrollback snapshot replay (generic), and/or (b) relaunch + `--resume <uuid>` since sessions auto-persist to disk (preferred for true state recovery — see §3/§14). **[established]** A tmux/abduco-style multiplexer can wrap the PTY if the orchestrator already uses one. **[fallback]**
- **Initial-prompt injection** — multiple supported modes:
  - **flag-interactive (preferred for interactive launch):** `gemini -i '<prompt>'` / `--prompt-interactive '<prompt>'` — runs the prompt then **drops into the live TUI**, keeping the session alive. **[established]** Quote the prompt for the target shell (POSIX `'…'` with `'\''` escaping; PowerShell `''` doubling; cmd `^`-escaping).
  - **flag-prompt (headless one-shot):** `gemini -p '<prompt>'` — non-interactive, exits after the turn (use for §12 background work, not for live sessions). **[established]**
  - **stdin:** `echo '<prompt>' | gemini` or `cat file | gemini -p '<prompt>'` (headless). **[established]**
  - **type-after-ready:** type into the composer + Enter once the TUI is ready (generic). **[fallback]**
- **First-run / trust handling** — First run shows theme/auth onboarding and a **folder-trust** prompt. Pre-seed to avoid the first prompt being eaten: write `~/.gemini/settings.json` (theme, `security.auth.selectedType`) and the trust file `~/.gemini/trustedFolders.json`; **or** pass `--skip-trust` to bypass the trust dialog at launch. **[established]**
- **Permission / YOLO / sandbox** — Modern control is `--approval-mode <default|auto_edit|yolo>`; `--yolo/-y` is the deprecated yolo alias. `--sandbox/-s` (+ `--sandbox-image`) runs tool execution sandboxed (Docker/Podman/macOS seatbelt; `docs/cli/sandbox.md`). Default is interactive approval; settings expose `tools.sandbox` and a policy engine (`docs/reference/policy-engine.md`). For unattended orchestration, launch with `--approval-mode=yolo` (preferred) or `--yolo` on older versions. **[established]** Note: user-supplied args are not sanitized by the launch path, so the orchestrator should choose the approval flag explicitly per version.
- **Model / reasoning / fast-mode at launch** — Model via `--model/-m <name>` or `GEMINI_MODEL` env or `model.name` in settings. **[established]** "Fast mode" closest analog: **Auto model routing** (`docs/cli/model-routing.md`) picks Pro vs Flash by task complexity; force Flash with `-m gemini-2.5-flash`. Reasoning/thinking-budget via generation settings (`docs/cli/generation-settings.md`; exact `model.thinkingBudget` key **[unverified]**).

**Conflicts / open questions:** Env-stripping is a documented necessity (the key-precedence behavior is real and follows from the auth flags), even though a thinner integration may skip it. The config-dir override env var is unconfirmed. Whether to inject instrumentation env vs. rely purely on `--resume` for durability is an integration choice — both are supported.

## 3. Resume & reattach

- **Resume support** — **[established]** first-class. `--resume` (alias `-r`) with three forms: `gemini --resume` (most recent), `gemini --resume <index>` (1-based; pair with `--list-sessions`), `gemini --resume <uuid>`. In-app: `/resume` opens a Session Browser (browse/preview/search by id or content; Enter to select); `/chat` is a compatibility alias. The orchestrator's proven resume argv is `gemini --resume <session_id>`.
- **Id source** — the session UUID/`session_id` (from the live hook payload, the on-disk `sessionId`, `--list-sessions`, or stream-json `init`). See §1. Sanitize before reuse: reject empty, >512 chars, leading `-` (arg-injection guard), or control chars. **[established]**
- **State restored on resume** — prompts + model responses, all tool executions (inputs/outputs), token-usage stats, and assistant thoughts/reasoning summaries (when available). **[established]** cwd is implied by the launch dir (resume is scoped to the project hash). Whether the prior model selection is restored is **[unverified]**; approval-mode/permissions are re-evaluated from current settings/flags, not restored. The orchestrator must re-establish its own per-pane hook env on relaunch and re-tail the transcript.
- **Manual checkpoints / tags** — `/chat save <tag>`, `/chat list`, `/chat resume <tag>` (docs also show `/resume save|list|resume <tag>`) — named save points distinct from the auto-saved session. **[established]**
- **Reattach to a still-running PTY** — Not a Gemini feature; handled by the orchestrator. **[established]** The daemon subprocess keeps the PTY alive; on reconnect, replay a serialized scrollback snapshot and issue a SIGWINCH/resize redraw nudge (the Ink alt-screen TUI repaints on resize). Alternative on daemon restart: relaunch + `--resume <uuid>` to recover full state from disk rather than reattaching a dead PTY. **[established]**
- **Idempotency / race hazards** — (a) Never `--resume` the same UUID into two live PTYs (double writers to the same chat json). (b) Auto-save writes to `chats/` continuously, so on-disk files are "live" — read as eventually-consistent. (c) `sessionRetention` (default 30d / maxCount 50) can GC a stored UUID out from under you. (d) Validate/sanitize the id (above) before it reaches argv. **[established]**

## 4. Auth & subscription

- **Credential locations** — OAuth ("Login with Google") tokens at **`~/.gemini/oauth_creds.json`** (`{access_token, refresh_token, expiry_date}`). Account identity in `~/.gemini/google_accounts.json`, `~/.gemini/user_id`, `~/.gemini/google_account_id`; install id at `~/.gemini/installation_id`. **[established]** API-key/Vertex creds come from env (no file) or a `GOOGLE_APPLICATION_CREDENTIALS` service-account JSON.
- **Auth methods** — (1) Google OAuth login (Gemini Code Assist / personal account); (2) `GEMINI_API_KEY` (AI Studio); (3) Vertex AI via `GOOGLE_API_KEY` + `GOOGLE_GENAI_USE_VERTEXAI=true` (+ `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION`); (4) service account via `GOOGLE_APPLICATION_CREDENTIALS`. `GEMINI_DEFAULT_AUTH_TYPE` / settings `security.auth.selectedType` pin the default; in-app `/auth` switches. **[established]**
- **Reuse model** — **[established]** preferred: **spawn-and-let-CLI-auth** for the interactive TUI (do not inject creds into the launched PTY; the CLI reuses `~/.gemini/oauth_creds.json`). For orchestrator-side *quota reading only*, the stored creds can be read and Google APIs called directly (a read path, not account materialization; see §5). For unattended/CI headless, an API key in env is most robust.
- **Token refresh** — The CLI itself refreshes its OAuth token (refresh token in `oauth_creds.json`, write-back to the same file) when it owns the session. If the orchestrator drives quota reads directly, it refreshes against `https://oauth2.googleapis.com/token` (`grant_type=refresh_token`, client id/secret obtained from the installed CLI package) and atomically rewrites `oauth_creds.json` (tmp+rename) with the new access_token/expiry; a 401 triggers one refresh+retry. **[established]**
- **Env hygiene** — strip inherited `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_GENAI_USE_VERTEXAI` to force the OAuth login path (these override the cached account). **[established]**
- **Multi-account** — **[not supported]** as a first-class CLI feature beyond `/auth`. Single ambient `~/.gemini` identity. Isolate accounts by per-account config dir (separate `HOME` so `~/.gemini` differs) or by swapping the cred files (`oauth_creds.json` + `google_accounts.json` + `user_id`/`google_account_id`). **[fallback]** Note: any orchestrator-side reading of `~/.gemini/oauth_creds.json` should be behind an explicit opt-in (those folders may belong to other apps), and refuse to touch them when off.

**Conflicts / open questions:** Direct orchestrator-managed token refresh against `oauth2.googleapis.com` (with client-secret scraped from the installed package) is a quota-reading convenience, not the auth path for the live agent — for the live session, let the CLI manage its own refresh. The scrape relies on the package's internal `oauth2.js`/bundle layout, which shifts across versions (>=0.38 ships hash-named bundle chunks; fall back to scanning the `bundle/` dir).

## 5. Models, usage & accounting

- **Model listing for a settings UI** — **[not supported]** as a subcommand: there is no `gemini models list`. `/model` opens an interactive picker only. Enumerate by: hard-coding the known set from `docs/cli/model.md` (`gemini-3-pro-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, plus `Auto` routing), or querying the underlying Generative Language / Vertex models API with the user's key. Freshness: static. **[fallback]**
- **Runtime model / fast-mode switching mid-session** — `/model` mid-session applies to subsequent turns; Auto routing switches per-turn. **[established]** Reasoning/thinking-budget via generation settings (runtime reload **[unverified]**).
- **Usage windows / quota / rate-limits** — Two paths:
  - In-app **`/stats model`** prints current-session token usage + quota-limit info for the current quota; a usage summary also prints on exit. **[established]** (Human-facing, not machine-readable from the orchestrator directly.)
  - Machine-readable quota read path (orchestrator-side): with an access token (refresh if expired), resolve the cloud project id via `POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` (`{metadata:{ideType:'GEMINI_CLI',pluginType:'GEMINI'}}`), then `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` (`{project}`), `Authorization: Bearer <access_token>`. Per-bucket fields: `remainingFraction`, `resetTime`, `modelId`. Result has a session summary + buckets; no weekly window. 401 → one refresh+retry. **[established]** Gate this behind an explicit opt-in (see §4) and note it reads *local* `~/.gemini` creds (so a purely-remote install has no quota readout — §15).
- **Token accounting for analytics** — Rich and machine-readable:
  - **Headless JSON** (`--output-format json`): `stats.models.<model>.tokens = {prompt, candidates, total, cached, thoughts, tool}`; `stats.models.<model>.api = {totalRequests, totalErrors, totalLatencyMs}`; `stats.tools` (counts/success/fail/durationMs/decisions accept|reject|modify|auto_accept/byName); `stats.files = {totalLinesAdded, totalLinesRemoved}`. **[established]**
  - **stream-json** `result` event carries aggregated stats + per-model token breakdown. **[established]**
  - **Telemetry/OTLP** metrics `gemini_cli.token.usage` (type ∈ input|output|thought|cache|tool, attr `model`), `gen_ai.client.token.usage`, `gemini_cli.api.request.latency`, `gemini_cli.tool.call.count|latency`; common attrs `session.id`, `installation.id`, `active_approval_mode`, `user.email`. Export to OTLP (`telemetry.otlpEndpoint`, default `http://localhost:4317`) or a local file (`telemetry.outfile`). **[established]**
  - **Transcript** (coarse): per-session token totals can be summed from `tokens` on assistant (`type:'gemini'`) records, with `model` from `record.model`. This is a per-session total, not per-turn input/output/cache/reasoning splits — use the headless JSON / OTLP paths for splits. Hooks do **not** carry token counts. **[fallback]**
- **Pricing / cost** — **[not supported]** by the CLI (no dollar computation). Free-tier limits in `docs/resources/quota-and-pricing.md`; per-token rates via Gemini API / Vertex pricing pages. The orchestrator must apply its own rate table to the token counts above.

## 6. Driving & input — two-way control

- **Send a new user message mid-session** — generic PTY write. **Enter (`\r`) submits.** For review-before-send drafts and large/multi-line content, use bracketed paste: `\x1b[200~` … `\x1b[201~`, then a separate `\r` after a short delay so the TUI processes paste-termination before Enter. **[established]** No documented programmatic "inject message" API outside ACP mode (§12/§15).
- **Read current input-box contents (composer → chat draft sync)** — **[not supported]**: no OSC/API exposure; only screen-scrape of the composer line. The composer shows a dim placeholder when empty (exact string **[unverified]**), so a `{dropDim}`-style screen reader is needed to distinguish empty from drafted.
- **Pre-fill / set the input box (chat → composer draft sync)** — **[not supported]** via flag/env: there is no flag to pre-fill the *editable* interactive composer. Closest is `--prompt-interactive`/`-i`, which **submits** a seed turn rather than leaving it editable (§2). Otherwise fall back to post-launch bracketed-paste-after-ready: wait for the composer ready signal (DECSET 2004, `\x1b[?2004h`, plus a quiet render window), then paste. **[fallback]**
- **Answer interactive prompts / approval menus** — Approval dialogs (tool calls, trust) are arrow-key + Enter menus; `Esc` cancels/dismisses; `Ctrl+Y` toggles YOLO (auto-approve); `Shift+Tab` cycles approval/plan mode. Number-key selection is **[unverified]**. The orchestrator forwards raw keystrokes into the PTY. Detect the prompt's presence via the **Notification hook** (`notification_type` = approval/intervention) and/or the **OSC 9** notification (§7); reading the actual *option set* requires screen-scrape. **[established for forwarding; partial for detection]**
- **Interrupt / cancel / escape** — `Esc` (or `Ctrl+[`) cancels/dismisses the current action; **`Ctrl+C`** interrupts the running turn; `Ctrl+C` again / `Ctrl+D` exits; `Esc Esc` (double) triggers `/rewind`. **[established]** Orchestrator note: because Gemini has no cancellation hook, treat a plain-Escape or Ctrl+C as an *immediate* interrupt (synthesize the `done`/interrupted transition from the keypress rather than waiting on a hook). **[established]**
- **Slash commands the orchestrator may issue** — `/help`, `/auth`, `/model`, `/stats` (`/stats model`), `/chat save|list|resume`, `/resume`, `/restore`, `/rewind`, `/compress`, `/memory`, `/tools`, `/mcp`, `/theme`, `/settings`, `/copy`, `/editor`, `/bug`, `/quit`, `/clear`, `/vim`. `@<path>` injects file context; leading `!` runs a shell command / toggles shell mode. **[established]**
- **Attachments / large paste** — `@file`/`@dir` for file context (plus `--include-directories`, `--all-files`); image/file paste via bracketed paste / drag (the model is multimodal). Exact pasted-image on-disk representation **[unverified]**. A large-inline-draft cap (~24,000 chars on Win32) applies generically.
- **Important keyboard shortcuts (mobile soft-keyboard surfacing)** (`docs/reference/keyboard-shortcuts.md`):
  - Submit: **Enter** (`\r`)
  - Newline (no submit): **Ctrl+Enter, Cmd/Win+Enter, Alt+Enter, Shift+Enter, Ctrl+J** — multiple bindings; **`Ctrl+J` is the terminal-safe choice** (`Alt+Enter` needs Alt/Option fidelity).
  - Cancel/dismiss: **Esc**, `Ctrl+[`
  - Interrupt: **Ctrl+C**; Exit: **Ctrl+D**
  - History: **Ctrl+P / Up**, **Ctrl+N / Down**; reverse search **Ctrl+R**
  - Autocomplete: **Tab** / Enter accept; move with Up/Down or Ctrl+P/N
  - Clear screen **Ctrl+L**; clear input **Ctrl+U** (to start) / **Ctrl+K** (to end)
  - Approval/plan-mode toggle: **Shift+Tab**; YOLO toggle: **Ctrl+Y**
  - Shell mode: **`!`** on empty prompt; shortcuts panel: **`?`** on empty prompt
  - External editor: **Ctrl+G** / **Ctrl+Shift+G**; copy mode: **F9**; rewind: **Esc Esc**
  - Slash trigger: **`/`**; file context: **`@`**

**Conflicts / open questions:** Draft-out-sync (reading the composer) and editable draft-in-prefill are both unsupported without screen-scrape — there is no flag or OSC for either. Number-key option selection in approval menus is unverified (arrow+Enter is confirmed). Whether to forward newline as `Alt+Enter` vs `Ctrl+J` is an orchestrator choice; prefer `Ctrl+J`.

## 7. Agent-state classification

- **State vocabulary** — map to `working | waiting(on-user) | blocked | done | error` (+ interrupted). Note: the hook events confirmed below cover `working` and `done` cleanly; `waiting` and `blocked` are reachable via the Notification hook / OSC 9 / hook `decision`, which is the discriminator that lifts Gemini above a working/done-only classifier.
- **Signal sources & authority rank** (highest → lowest):
  1. **Hooks** (most authoritative, structured): `BeforeTool`/`AfterTool` → working; `BeforeModel`/`AfterModel`/`BeforeToolSelection` → working; `BeforeAgent`/`AfterAgent` → turn start/end; `Notification` (`notification_type`) → waiting/intervention; `SessionStart`/`SessionEnd`; `PreCompress`. **[established]**
  2. **OSC 9 notification** — emitted on "user intervention needed" (waiting) and "task completion" (done); a coarse but reliable cross-process signal, with BEL fallback if OSC 9 unsupported. **[established]**
  3. **stream-json events** (headless): `tool_use`/`tool_result` → working; `result` → done; `error` → error. **[established]**
  4. **OSC title glyphs** (secondary UI hint, *not* authoritative state): Gemini emits per-keystroke OSC titles with status glyphs — `✦`/`⏲` working, `◇` idle, `✋` permission. Use only for labels/attention indicators, never for the canonical state; collapse the high-frequency churn to a stable `✦/◇/✋ Gemini CLI` label to avoid render thrash. **[fallback]**
  5. **Transcript/chat-json growth** under `chats/` → coarse activity. **[fallback]**
  6. **Process exit code** (§14) → done/error. **[fallback]**
  7. **PTY output activity / foreground child** → coarse working signal. **[fallback]**
- **Event → state mapping:**
  - `BeforeAgent` → working (also the new-turn boundary; reset tool/prompt state here)
  - `BeforeModel` / `AfterModel` / `BeforeTool` / `AfterTool` / `BeforeToolSelection` → working
  - `Notification` (approval/intervention) + approval dialog on screen → **waiting**
  - hook `decision:"deny"|"block"` (exit 2) → **blocked**
  - `AfterAgent` / stream-json `result` / OSC 9 completion → **done**
  - nonzero exit / stream-json `error` → **error**
  - `Ctrl+C` / Esc keypress → **interrupted** (synthesized; no cancel hook)
  - anything else → ignored
  Tool fields to extract from hook payloads: `tool_name`/`name`, `tool_input`/`args`/`input` (preview); `prompt_response` → last-assistant-message preview on `AfterAgent`. (Legacy `PreToolUse`/`PostToolUse` aliases may still arrive and should map to working — see §8.)
- **"Stopped but needs user" vs "done"** — distinguishable via the **Notification** hook/OSC 9 firing a *distinct* "intervention needed" vs "completion" signal, plus an approval dialog being on screen (waiting) vs the bare composer (done). **[established]** Caveat: if hooks for the Notification event are not installed (or the running version predates it), inline approvals are **not** surfaced as `waiting` and the agent will read `working` until `AfterAgent` flips it to `done` — design for this degraded mode. Default `--approval-mode=yolo` largely avoids the prompts entirely.
- **Reconciliation** — prefer hooks over scrape; reset tool/prompt state on `BeforeAgent` (new turn); debounce OSC 9 + output-activity with a quiet window; sticky `waiting` until a hook/keystroke clears it; flatten OSC-title churn (above).
- **Sub-agents / nested tasks** — Gemini supports subagents (`docs/core/subagents.md`); `BeforeAgent`/`AfterAgent` fire per agent invocation, so nested state can be tracked via those events. Identity-inheritance details **[unverified]**.
- **Latency** — hooks fire synchronously around the event (sub-second); OSC 9 at boundaries; output-activity immediate. Cap hook callback timeouts tightly (e.g. connect 0.5s / total 1.5s) so a slow callback never stalls the agent.

**Conflicts / open questions:** The cleanest waiting/blocked detection (Notification hook + OSC 9) depends on those events existing in the running version and on the orchestrator installing the Notification hook. A minimal hook install covering only `BeforeAgent`/`AfterAgent`/`BeforeTool`/`AfterTool` yields working/done only — add `Notification` (and `BeforeModel`/`AfterModel`) to recover waiting. OSC titles are explicitly *not* a source of canonical state.

## 8. Hooks & instrumentation install

- **Mechanism** — **[established]** native shell-command hooks configured in `settings.json` under a `hooks` object. `type` is currently `"command"` only (a managed shell-hook script). (Extensions, MCP servers, and a skills system also exist, but hooks are the right path for state instrumentation.)
- **Install location & trust** — `~/.gemini/settings.json` (user), `.gemini/settings.json` (project), or system settings (`/etc/gemini-cli/settings.json` on Linux; `C:\ProgramData\gemini-cli\settings.json`; `/Library/Application Support/GeminiCli/settings.json`). Project-scoped hooks require the folder to be **trusted** (`~/.gemini/trustedFolders.json` / trust dialog / `--skip-trust`). No config-hash trust entry is required for user-level hooks (unlike some other agents). **[established]**
- **Hook config schema** — per event, an array of `{matcher?, sequential?, hooks:[{type:"command", command, name?, timeout?(ms, default 60000), description?}]}`. `matcher` = regex (for tool events) or exact string (lifecycle). **[established]**
- **Event taxonomy + payload fields** — Events: `BeforeTool, AfterTool, BeforeAgent, AfterAgent, BeforeModel, AfterModel, BeforeToolSelection, SessionStart, SessionEnd, Notification, PreCompress`. The hook receives **JSON on stdin** with base fields `{session_id, transcript_path, cwd, hook_event_name, timestamp}` plus per-event fields:
  - `BeforeTool`/`AfterTool` → `tool_name, tool_input, mcp_context, original_request_name`
  - `BeforeAgent`/`AfterAgent` → `prompt, prompt_response, stop_hook_active`
  - `BeforeModel`/`AfterModel` → `llm_request, llm_response`
  - `SessionStart` → `source`; `SessionEnd` → `reason`; `Notification` → `notification_type`; `PreCompress` → `trigger`
  **`transcript_path` is a direct pointer to the session transcript** — capture it (§10). **[established]**
- **Hook return / transport** — Hook returns **JSON on stdout**: `{systemMessage?, suppressOutput?, continue?, stopReason?, decision?("allow"|"deny"|"block"), reason?, hookSpecificOutput?}`. Exit `0` = ok (stdout must be JSON only), `2` = block (stderr = reason), other = non-fatal warning (CLI continues = fail-open). **Constraint: the hook script must print only the final JSON to stdout.** Transport to the orchestrator: the command is a managed script that POSTs to an injected `http://127.0.0.1:<port>/<route>` callback with a token header (or appends to a file/socket). Established hardening for the script: print `{}` to stdout first so the CLI never stalls parsing hook output; exit 0 if port/token/workspace-key/payload are missing; end the curl with `|| true`; cap timeouts (e.g. `--connect-timeout 0.5 --max-time 1.5`); and source an endpoint-handoff file (refreshing port/token/version) so a surviving PTY keeps reporting to the *current* orchestrator after a restart. **[established]**
- **Lifecycle** — install/update/uninstall = edit the `hooks` block (idempotent by `name`/matcher; match managed entries by **script filename**, not exact path, so repeated installs sweep stale entries from old builds/userData paths). Version-skew: the event set is stable but newer events may be absent on old versions — gate on `--version`. **Migration note:** older configs may carry Claude/Codex-style `PreToolUse`/`PostToolUse` buckets; current Gemini uses `BeforeTool`/`AfterTool` and warns on the legacy bucket, so install/remove should actively sweep the stale `PreToolUse`/`PostToolUse` entries. Status can be reported as `installed`/`partial`/`not_installed`/`error`; `remove()` should fail open on malformed configs. **[established]**

**Conflicts / open questions:** The native event names are `BeforeTool`/`AfterTool`/`BeforeAgent`/`AfterAgent` (current). The `PreToolUse`/`PostToolUse` names are legacy/foreign aliases that the CLI accepts-but-warns-on and that an integration should migrate away from. A minimal install registers `BeforeAgent`/`AfterAgent`/`BeforeTool`/`AfterTool`; add `Notification` (+ `BeforeModel`/`AfterModel`) for full state coverage (§7).

## 9. Session titles

- **Source of truth** — **[established]** there is no agent-generated session "title" field; the Session Browser previews a session by **date, message count, and first user prompt**. The natural title is the **first user prompt** (truncated) — matching the CLI's own preview.
- **Read** — first user prompt from the chat `.json` (or the first-turn `BeforeAgent` hook's `prompt` field). For named save points, `/chat save <tag>` provides a user-given name. **[established]**
- **OSC title** — the CLI emits OSC titles only as status-glyph labels (notifications use OSC 9, not OSC 0/2). Do **not** use the OSC title as the tab name; collapse its churn to a stable `Gemini CLI` label. Whether any meaningful OSC 2 title is set is **[unverified]**. **[fallback / not authoritative]**
- **Fallback** — synthetic title via first-prompt truncation (strip leading "please/can you", take the first clause, truncate ~40 chars), else session UUID/timestamp.

## 10. Transcript & history

- **Storage** — per-project under `~/.gemini/tmp/<project_hash>/`:
  - `chats/<timestamped>.json` — full auto-saved session (prompts, responses, tool I/O, token stats, thoughts). One file per session.
  - `checkpoints/<ts>-<file>-<tool>.json` — conversation + pending tool call at a checkpoint.
  - `logs.json` — append-only user-prompt log (no model responses). **[unverified — community]**
  - Every hook event also exposes `transcript_path` (abspath) — the most reliable pointer. **[established]**
  Both a legacy single-object `.json` and a newer line-delimited `.jsonl` rollout form exist; scan `~/.gemini/tmp/**` for both and branch on extension. **[established]**
- **Parsing / schema mapping** — content includes user prompts, model responses, tool executions (inputs + outputs), token-usage stats, and assistant thoughts/reasoning summaries. Observed/usable fields:
  - `type:'user'` → user message (increments count, seeds title, preview content).
  - `type:'gemini'` → assistant message (preview; capture `model`; sum `tokens` for the per-session token total).
  - JSONL `$set` lines → timeline-only metadata mutations (e.g. `lastUpdated`).
  - timeline from `startTime` / `lastUpdated` / `timestamp`.
  Exact full JSON schema of the chat file is **[unverified]** (community visualizer scripts imply a stable parseable shape). Map roles user/model(`gemini`)/tool; tool-call objects; thoughts → thinking blocks; file diffs via tool outputs. Beyond plain user/assistant text + token + model, finer per-type modeling (separate thinking/diff/error records) is not consumed by a minimal integration.
- **Live tail vs historical** — auto-save writes continuously, so tail via fs-watch on `chats/` (new file = new session; growth = new turns); historical = read the file directly (mtime-sorted; stream JSONL line-by-line). For real-time *structured* events without scraping, prefer **stream-json** (headless) or **hooks**; live status in an interactive session comes from the hook channel, not transcript tailing. **[established]**
- **Consumers** — chat-view (parse `chats/*.json` or stream-json `message` events); last-message/preview (last entry / first prompt / `AfterAgent` `prompt_response`); clickable items (tool-call objects, `stats.files` lines added/removed, `@file` refs); state classification (hooks/stream-json, §7); resume picker (builds `gemini --resume <id>`).
- **Transcript ↔ terminal reconciliation** — two independent surfaces (the alt-screen TUI render vs the JSON). Treat JSON/stream-json/hooks as the structured source and the PTY as the visual; do not reconcile per-record.
- **Special content types / quirks** — thoughts/reasoning summaries are stored explicitly; tool outputs stored with inputs; token stats per turn. Image/pasted-content on-disk representation **[unverified]**. Compression: `/compress` collapses history; **rewind reconstructs across compression points** from stored session data. The notable Gemini quirk is the **dual `.json` + `.jsonl` format plus `$set` mutation lines**. **[established]**

**Conflicts / open questions:** As in §1, the storage layout is documented as a `<project_hash>/chats|checkpoints|logs` tree, while the resilient parser keys on in-file `sessionId` and tolerates both flat and dual formats. Exact chat-file JSON schema and `logs.json` schema are unverified — `transcript_path` from hooks is the safest pointer; `--output-format stream-json`/`json` is the safest structured read.

## 11. Terminal rendering & display fidelity

Largely generic; Gemini is an **Ink (React-for-CLI) TUI** on the alt-screen.
- **PTY → xterm** — capture PTY bytes → batched IPC → xterm.js. Intercept/strip OSC status sequences generically; extract OSC titles for labels (§9). **[established]**
- **Resize/reflow** — send SIGWINCH on cols/rows change; the Ink TUI repaints on resize, so a resize nudge is the standard redraw trigger after reattach. Mobile↔desktop breakpoint remount needs a forced redraw. **[established]**
- **Scrollback model** — native TUI **alt-screen**: the agent owns its own history rendering and re-renders on resize. Orchestrator-owned xterm scrollback is secondary (serialized snapshots for reattach). A `--screen-reader` accessibility mode and a copy mode (**F9**) exist. **[established]**
- **Mouse forwarding** — forward scroll/click into the TUI (Ink supports mouse for menus) while attached; disable when scrolling orchestrator scrollback. Exact mouse-mode bytes **[unverified]**. **[fallback]**
- **Snapshot/serialize for reattach** — persist a serialized xterm buffer (sha256-keyed per tab/leaf) and replay on reconnect; prefer relaunch + `--resume` for true state recovery. **[established]**
- **Local cache for instant render then live reconnect** — persist the last serialized scrollback snapshot, show it instantly on return, then reconnect the live PTY and SIGWINCH-nudge to repaint/reconcile (generic cached→live handoff; no Gemini-specific support). **[established]**
- **Composer/cursor specifics** — dim-placeholder composer when empty; ready-for-paste signal = DECSET 2004 (`\x1b[?2004h`) + a quiet render window (no dedicated composer-ready OSC). Use bracketed paste for large content. **[fallback]**
- **Color/theme/OSC** — theme via `ui.theme` / `/theme`; OSC 9 for notifications; standard ANSI/SGR otherwise. The one Gemini-aware quirk is **title-churn flattening** (§7/§9). **[established]**

## 12. Background / headless invocation

- **Non-interactive** — **[established]** robust. `gemini -p '<prompt>'` (or stdin: `echo '<prompt>' | gemini`, `cat f | gemini -p '<prompt>'`). Triggered by `-p` or a non-TTY environment.
- **Output formats** — `--output-format text` (default), `json` (single object `{response, stats, error?}`), `stream-json` (NDJSON events: `init, message, tool_use, tool_result, error, result`). **[established]**
- **Exit codes** — `0` success; `1` general error / API failure; `42` input error (bad prompt/args); `53` turn-limit exceeded. **[established]**
- **Uses for the orchestrator's own LLM work** — commit messages, PR title/body, branch names, summaries, session-summary, classification — all good fits via `gemini -p '…' --output-format json` (parse `.response`). Limit tool use via `--allowed-tools` + approval mode; combine with `--approval-mode=yolo` for unattended runs and `--include-directories` for context. **[established]**
- **Auth for headless** — inherits the same creds (`~/.gemini/oauth_creds.json` or `GEMINI_API_KEY`/Vertex env). For unattended/CI, an **API key** is most robust (no browser). **[established]**
- **Cost/latency/timeout caps** — `model.maxSessionTurns` + `--output-format json` `stats` give per-call token usage; turn-limit returns exit 53. **No built-in wall-clock timeout flag** — the orchestrator must impose its own. **[established]**
- **Programmatic embedding (richer than one-shot)** — **ACP mode** (`gemini --experimental-acp` / `--acp`): JSON-RPC 2.0 over stdio (Agent Client Protocol) for full two-way control — prompts as requests + streamed responses/notifications + bidirectional MCP — the cleanest path for a long-lived embedded agent vs. scraping a PTY. **[established]**

**Conflicts / open questions:** For *interactive* orchestrator sessions, do not use headless `-p` (it exits after one turn) — use `--prompt-interactive` (§2). Headless `-p`/`--output-format json` is reserved for the orchestrator's own one-shot LLM tasks. ACP is the recommended evolution path for programmatic control but is flagged experimental.

## 13. Capabilities & quirks matrix

| Capability | Gemini CLI |
|---|---|
| Resumable | **Yes** — `--resume`/`-r` (latest / 1-based index / uuid), `/resume`, `/chat save\|list\|resume` |
| Hooks | **Yes** — native `settings.json` shell-command hooks; 11 events (`BeforeTool/AfterTool/BeforeAgent/AfterAgent/BeforeModel/AfterModel/BeforeToolSelection/SessionStart/SessionEnd/Notification/PreCompress`) |
| Draft prefill (flag/env/none) | **None editable** — `-i/--prompt-interactive` seeds a submitted first turn; no editable-composer prefill → bracketed-paste-after-ready fallback |
| Draft read-out (composer→chat) | **No** — screen-scrape only (dim placeholder when empty) |
| Trust preset | **Yes** — `~/.gemini/trustedFolders.json` / settings, or `--skip-trust` |
| Interactive-prompt selection | Arrow+Enter menus; `Ctrl+Y` YOLO, `Shift+Tab` mode; number-key select **unverified** |
| Title source | First-user-prompt (preview) / `/chat save <tag>`; OSC title = label only, not authoritative |
| Transcript format | JSON (+ `.jsonl` rollout w/ `$set` lines) under `~/.gemini/tmp/<hash>/chats/`; also stream-json + hook `transcript_path` |
| Headless | **Yes** — `-p` / stdin; `--output-format text\|json\|stream-json`; exit `0/1/42/53` |
| Model listing | **No subcommand** — `/model` picker (interactive); enumerate from known set / provider API |
| Usage/quota | `/stats model` (session tokens + quota) + on-exit summary; OTLP token metrics; orchestrator quota read via cloudcode-pa `retrieveUserQuota` |
| Token accounting | **Yes (rich)** — headless JSON `stats.models.<m>.tokens {prompt,candidates,total,cached,thoughts,tool}`; stream-json `result`; OTLP `gemini_cli.token.usage` |
| Pricing/cost | **No** — external rate table required |
| Fast mode | **Auto model routing** (Pro↔Flash); force Flash via `-m gemini-2.5-flash` |
| Sandbox/YOLO | `--sandbox/-s` (+`--sandbox-image`); `--approval-mode default\|auto_edit\|yolo`; `--yolo` (deprecated) |
| Programmatic protocol | **ACP** (JSON-RPC/stdio) via `--experimental-acp`/`--acp`; Zed integration flag |
| Notifications | **OSC 9** (intervention/completion) + BEL fallback |
| Checkpoint/rewind | **Yes** — shadow git repo, `/restore`, `/rewind` (Esc Esc), `checkpoints/` files |
| Multi-account | **No** first-class switch beyond `/auth`; isolate via per-account `HOME`/cred-file swap |
| Default permission arg (unattended) | `--approval-mode=yolo` (preferred) / `--yolo` (legacy) |
| Initial-prompt injection | `--prompt-interactive '<p>'` (interactive) / `-p '<p>'` / stdin (headless) |

**Quirks / workarounds:**
- `--checkpointing` CLI flag **removed in 0.11.0** → enable via `settings.json general.checkpointing.enabled`.
- `--yolo` **deprecated** → use `--approval-mode=yolo`; gate on `--version`.
- Newline has **5 bindings** incl. `Alt+Enter` (needs Alt/Option fidelity); prefer `Ctrl+J`.
- `--resume <index>` requires a prior `--list-sessions` (index unstable across new sessions); prefer uuid.
- `sessionRetention` (default 30d / 50) can GC a stored UUID.
- Hook scripts must emit **only** JSON on stdout; print `{}` first and `|| true` the curl to fail-open.
- Sweep legacy `PreToolUse`/`PostToolUse` hook buckets (CLI warns); native names are `BeforeTool`/`AfterTool`.
- No cancellation hook → synthesize interrupt from Esc/Ctrl+C keypress.
- OSC titles update per-keystroke → flatten churn to a stable label.
- Inherited `GEMINI_API_KEY`/`GOOGLE_API_KEY`/`GOOGLE_GENAI_USE_VERTEXAI` override OAuth login → strip for OAuth isolation.
- Orchestrator quota read uses client-secret scraped from the installed package (`oauth2.js`; >=0.38 bundle-dir fallback) and reads *local* `~/.gemini` creds only.

## 14. Failure, exit & recovery

- **Crash/exit detection** — headless exit codes distinguish cleanly: `0` done; `1` general/API error; `42` bad input; `53` turn-limit. **[established]** Interactive: nonzero exit / unexpected PTY EOF = crash; clean `/quit` or `Ctrl+D` = intentional. The authoritative interactive "done" is the `AfterAgent` hook / stream-json `result`; process exit is the fallback. `error` stream-json events and the `error` JSON field carry `{type, message, code}`.
- **Reattach-after-restart healing** — sessions persist to `~/.gemini/tmp/<hash>/chats/`, so recover an "exited-but-should-be-alive" row by relaunching `gemini --resume <uuid>` rather than reaping a dead PTY. The daemon keeps the PTY alive across server restarts; the managed hook re-sources its endpoint-handoff file to keep reporting to the new orchestrator. Generic orphan/zombie reaping otherwise. **[established]**
- **Error surfacing** — signals: nonzero exit code; stream-json `error` event / JSON `error` field (`type/message/code`); hook `decision:"block"` / `stopReason` / exit 2; OSC 9 intervention notification; on-screen TUI error. Quota-read errors (orchestrator-side) surface as `error`/`unavailable` with a message (e.g. "Token refresh failed", "Gemini project ID not found", "Quota fetch failed (<status>)"). Note: an interactive run that *errors mid-turn* without exiting may only surface via the on-screen TUI and stream-json/`error`-hook paths — there is no dedicated `error` agent-state from the basic `BeforeAgent`/`AfterAgent` hooks alone. **[established / partial]**

## 15. Remote / transport

- **Transports** — Local PTY, daemon subprocess, and **SSH (remote worktree)** all apply; Gemini is a plain Node CLI with no networked control surface of its own (state = local files + env), so the orchestrator's existing transports work unchanged. **[established]**
- **SSH instrumentation** — install the managed hook on the remote host: write `~/.gemini/settings.json` + the managed hook script (under the orchestrator's per-user agent-hooks dir, e.g. `gemini-hook.sh`) over SFTP, **always POSIX `.sh` syntax** even when the orchestrator runs on Windows, writing the script *before* settings.json so an interrupted install never points at a missing script, and performing the same legacy-bucket sweep remotely. **[established]**
- **Forwarding** — hook callbacks run **on the host where `gemini` runs**, so point them at a relay-local callback (`http://127.0.0.1:<port>/<route>` tunneled, or a file the daemon tails). PTY bytes go over the relay; `transcript_path` / `chats/*.json` live on the agent host and must be read there. **[established]**
- **Programmatic remote control** — **ACP mode** (JSON-RPC over stdio) is the cleanest daemon-subprocess transport: speak JSON-RPC to the child's stdin/stdout instead of scraping a PTY. **[established]**
- **Agent-specific remote limitation** — the orchestrator-side **quota read** (§5) reads the *local* `~/.gemini` creds in the orchestrator's own process; a purely-remote install (creds on the remote host) has **no local quota readout**. `~/.gemini` (creds + sessions) is per-host. There is a `docs/core/remote-agents.md` for hosted remote-agent execution — details **[unverified]**.

---

## Open questions / unverified

- Exact `<project_hash>` algorithm (likely sha256 of the project-root abspath) and the `logs.json` schema — community-sourced, not in primary docs.
- Full JSON schema of `chats/*.json` (field names beyond `type` / `sessionId` / `model` / `tokens` / timestamps); the dual `.json`/`.jsonl` + `$set`-line shape is confirmed in practice but not formally documented. Prefer hook `transcript_path` and `--output-format stream-json|json` for structured reads.
- Env var (if any) that overrides the `~/.gemini` config dir.
- Whether the prior **model selection** is restored on `--resume` (history/tools/tokens/thoughts are restored; model is unconfirmed).
- Number-key selection in approval/permission menus (arrow+Enter confirmed; number-keys unverified).
- Composer dim-placeholder exact string (needed for reliable empty-vs-drafted screen-scrape).
- On-disk representation of pasted images / multimodal attachments.
- Exact mouse-mode byte sequences for forwarding scroll/click into the Ink TUI.
- Whether any meaningful OSC 0/2 window title is emitted (notifications use OSC 9; status glyphs appear in titles but are label-only).
- Runtime reload of reasoning/thinking-budget generation settings, and the exact `model.thinkingBudget`-style key.
- ACP-mode and `docs/core/remote-agents.md` operational details (both flagged experimental/unverified).
- Sub-agent identity inheritance across `BeforeAgent`/`AfterAgent` for nested tasks.
- Orchestrator quota-read client-secret scraping depends on the installed package's internal bundle layout, which shifts across versions (>=0.38 hash-named chunks) — fragile, version-sensitive.
