# Grok CLI — orchestrator integration reference

Subject: **Grok CLI** — xAI's coding-agent TUI ("Grok Build TUI"), binary `grok` (here `grok 0.2.56 (4d4448c98) [stable]` at `~/.local/bin/grok`). It is a Rust TUI that is unusually integration-friendly: beyond the interactive terminal it offers a **headless one-shot** (`grok -p`), a **structured ACP agent over stdio** (`grok agent stdio`, JSON-RPC), a **WebSocket agent server** (`grok agent serve`), a **headless-over-relay** mode (`grok agent headless`), and a **leader/shared-backend** model (`~/.grok/leader.sock`). It is **resumable**, persists rich well-structured state on disk under `~/.grok/`, and **honors Claude-Code-style hooks** (it reads `~/.claude/settings*.json` with `vendor:"claude"`), so a Claude-style HTTP-callback hook install is the established instrumentation path.

Citation conventions used below: **[help]** = `grok --help` / subcommand help; **[on-disk]** = files under `~/.grok`; **[README]** = the bundled official docs `~/.grok/README.md` (v0.2.56, line numbers where useful).

---

## 1. Discovery & identity

- **Binary detection / "installed?":** binary name `grok` on PATH (`which grok`). Decide installed by PATH lookup + a successful `grok --version` (alias `grok -v`, also `grok version` / `v`) which prints `grok 0.2.56 (4d4448c98) [stable]` = semver + git short hash + release channel. No known alias/rename. Process recognition: exact match on `grok`, plus a prefix rule treating `grok-*` (e.g. packaged `grok-x64`) as `grok`. Terminal-title identity: token-match (not substring) of `grok` → label "Grok". `faviconDomain: x.ai`, homepage `https://x.ai/cli`. *(established)*
- **Version detection / gating:** `grok --version` / `grok version`; channel (`[stable]`) also exposed. On disk `~/.grok/version.json` = `{version, stable_version, checked_at}` and `~/.grok/.metadata_version` (`0.2.56`). Gating is rarely needed (flags are stable), but resume / headless-session / `--output-format` / leader features should be gated on a recent version (≥0.2.x). *(established)*
- **Existing-session discovery (paths/globs):**
  - Sessions: `~/.grok/sessions/<URL-encoded-cwd>/<session-id>/` where cwd is **percent-encoded** (`/`→`%2F`), e.g. `~/.grok/sessions/%2Fhome%2Fuser%2Fsrc%2Fother%2Fpodium/019ec80e-…/`. Root overridable via `GROK_HOME` (default `~/.grok`).
  - Discovery glob: enumerate session dirs by their `summary.json` (`<sessions-root>/*/*/summary.json`); each dir also holds a sibling `chat_history.jsonl`. *(established)*
  - **Currently-open sessions (cleanest live signal):** `~/.grok/active_sessions.json` = array of `{session_id, pid, cwd, opened_at}`. *(established — independently confirmed)*
  - Per-cwd `prompt_history.jsonl` (one level up from session dirs): `{timestamp, session_id, prompt, is_bash}`.
  - Global FTS index `~/.grok/sessions/session_search.sqlite`, table `session_docs(session_id, cwd, updated_at, title, content, content_hash, last_indexed_offset)` + FTS5 mirror — fast search/listing. *(established)*
  - Programmatic enumeration: `grok sessions list` / `grok sessions search <q>` (human table: SESSION ID / CREATED / UPDATED / STATUS / SUMMARY; STATUS shows `remote` for relay-created sessions), `grok import --list --json` (NDJSON), `grok sessions delete <id>`. *(established)*
  - `~/.grok/projects/<dashed-cwd>/terminals/` and `…/agent-tools/` hold per-project scratch keyed by a **dashed** cwd slug — note this is a *different* encoding than `sessions/` (percent-encoded); do not conflate. *(quirk)*
- **Stable session identity:** a **UUIDv7-style session id** (e.g. `019eca0a-7df5-7130-a325-3244ee3f04b8`) — time-ordered, so lexical sort ≈ chronological. Appears as the directory name, `summary.json.info.id`, `active_sessions.json.session_id`, `updates.jsonl` `params.sessionId`, and headless JSON output `sessionId`. At launch you can **force the id yourself** in headless mode via `-s/--session-id <ID>` (create-or-resume); for the interactive TUI the id is generated and discovered via `active_sessions.json` (match `pid`+`cwd`+`opened_at`). No OSC-emitted id. *(established)*
- **Session → repo/worktree/cwd mapping:** the session dir name encodes the cwd (percent-decode to recover it). `summary.json` records `cwd`, `git_root_dir`, `git_remotes[]`, `head_commit`, `head_branch`. First-class git-worktree support: `grok --worktree[=name]`, `grok worktree list|show|rm|gc|db`, tracking DB `~/.grok/worktrees.db`. `grok inspect --json` reports the current dir's `cwd`, `projectRoot`, `projectTrusted`, instructions, permissions, and hooks. *(established)*

---

## 2. Launch & process model

- **Spawn mechanism — multiple options (all viable):**
  1. **PTY + interactive TUI** (established): spawn `grok [PROMPT]` in a PTY; default uses the terminal alternate screen — pass `--no-alt-screen` to run inline (better for web-terminal scrollback).
  2. **`grok agent stdio`** (established structured path): ACP agent over stdin/stdout (JSON-RPC), no PTY — best for non-terminal structured control. **[README 728-742]**
  3. **`grok agent serve --bind 127.0.0.1:2419 --secret <tok>`** (established): agent as a **WebSocket server** (auth `--secret` / `GROK_AGENT_SECRET`; `--remote <url>` proxy mode).
  4. **`grok agent headless`** (established): headless over xAI's WS relay (`--grok-ws-url`, `--grok-ws-origin`).
  5. **`grok -p/--single`** (established): one-shot headless — see §12.
  6. **Leader model** (fallback / advanced): `grok agent leader` / `grok agent --leader` runs/uses a shared backend over `~/.grok/leader.sock` so multiple front-ends share one agent process. `grok leader list|info|kill|profile`; override path `--leader-socket`.
- **Launch command / default args / env:** minimal `grok` (TUI in cwd); common `grok --cwd <dir> -m <model> --permission-mode <mode> "<prompt>"`. Honored env: `GROK_HOME` (config dir, default `~/.grok`), `XAI_API_KEY` (custom-endpoint/API-key auth — see §4 hygiene), `GROK_CLI_CHAT_PROXY_BASE_URL`, `GROK_MODELS_BASE_URL`/`GROK_MODELS_LIST_URL`, `GROK_SANDBOX`, `GROK_AGENT`, `GROK_SUBAGENTS`, `GROK_MEMORY`, `GROK_WEB_FETCH`, `GROK_AGENT_SECRET`, `GROK_COMPACTION_MODE`/`GROK_COMPACTION_DETAIL`, `GROK_AUTH_PROVIDER_COMMAND`, `GROK_DEBUG_LOG`/`GROK_LOG_FILE`/`RUST_LOG`. **[README 2384-2410]** For instrumentation, inject your hook-callback coordinates as env that your hook script reads (port/token/pane-id), e.g. an `HARNESS_TERMINAL_ID` plus a local HTTP endpoint+token — see §8. Grok strips nothing itself.
- **Durable backing for survival:** no built-in multiplexer; `grok` is an ordinary process. For PTY survival across orchestrator restarts wrap in an external tmux/abduco master (generic). Native alternatives: the **leader** + **`agent serve`** backend can outlive a front-end client, and `active_sessions.json` + on-disk state make a fresh `--resume` cheap. *(established + fallback)*
- **Initial-prompt injection mode — preferred is argv:**
  - **argv positional** (established, preferred): `grok "fix the bug"` / `grok --worktree=feat "create this feature"` — no bracketed-paste timing concerns.
  - **Headless:** `-p/--single <PROMPT>`, `--prompt-file <PATH>`, `--prompt-json <JSON content blocks>`, or **stdin pipe**.
  - **`--verbatim`** sends the prompt exactly as given (skips Grok's prompt-wrapping; use when you supply a fully-formed prompt).
  - **For an already-running TUI:** type-after-ready into the PTY — send prompt text then a *separate* CR to submit (standard TUI pattern); for large/multi-line content use bracketed paste (`ESC[200~ … ESC[201~`) then a separate `\r`. A workable readiness gate: wait for grok to own the PTY foreground (poll the foreground process up to ~30×150ms, accepting grok-foreground or a non-shell foreground with child processes), then send. *(established)*
  - **Conflicts / open questions:** one source treats the initial prompt as `stdin-after-start` (plain text + `\r` after foreground detection); the CLI's own surface makes **argv the first-class path** at launch and reserves typing for mid-session. Prefer argv at launch; reserve type-after-ready for mid-session injection.
- **First-run / trust handling — two surfaces:**
  - **Project trust (for hooks/plugins):** projects must be explicitly trusted before `.grok/hooks/` run (`/hooks-trust`, `/plugins … trust`); `grok inspect --json` reports `projectTrusted`. Pre-seed by trusting ahead of time, or for unattended runs don't rely on *project* hooks (user-level Claude hooks under `~/.claude/settings*.json` are honored without project trust — see §8).
  - **Login/welcome screen:** first launch shows a login/welcome screen if `~/.grok/auth.json` is absent. Pre-seed by writing a valid `auth.json`, running `grok login` / `grok login --device-auth` headlessly, or configuring `GROK_AUTH_PROVIDER_COMMAND`. `--oauth` forces OAuth at the welcome screen. With creds present, the prompt is not eaten. *(established)*
- **Permission / YOLO / sandbox modes:**
  - `--permission-mode <default|acceptEdits|auto|dontAsk|bypassPermissions|plan>`. *(established — `bypassPermissions` is the YOLO-equivalent)*
  - `--always-approve` (alias "yolo"; also `/always-approve [on|off]`, `/yolo`, `Ctrl+O` to toggle live). Config `[ui] permission_mode = "always-approve"` / `yolo = false`.
  - `--allow <RULE>` / `--deny <RULE>` (repeatable; deny wins; map to Claude's `--allowedTools`/`--disallowedTools`). `--tools` / `--disallowed-tools` (built-in tool sets; **headless-only**).
  - `--sandbox <off|workspace|read-only|strict|custom>` (Landlock on Linux / Seatbelt on macOS; also `GROK_SANDBOX`; custom profiles `~/.grok/sandbox.toml`). Default `off`. *(established)*
- **Model / reasoning-effort / fast-mode at launch:** `-m/--model <MODEL_ID>`; `--effort <low|medium|high|xhigh|max>`; `--reasoning-effort <EFFORT>` (reasoning models). Default model from `~/.grok/config.toml [models] default` (observed `grok-composer-2.5-fast`). **Fast mode is a model choice, not a flag:** the catalog has a distinct `grok-composer-2.5-fast` ("Composer 2.5 Fast") vs `grok-build`. `[ui] fork_secondary_model` selects the model for fork/secondary work. *(established)* **Quirk:** `--effort`/`--reasoning-effort` are **headless-only** (ignored with a warning in the TUI). **[README 585]**
  - **Conflicts / open questions:** one source reports no agent-specific model/effort/fast-mode flags at all (free-form CLI-args only). The CLI in fact exposes `-m`, `--effort`, `--reasoning-effort` directly; use them.

---

## 3. Resume & reattach

- **Resume support — strong:** `-r/--resume [<SESSION_ID>]` (omit id ⇒ most recent for this cwd); `-c/--continue` (most recent session for cwd). `--restore-code` additionally checks out the original session's HEAD commit on resume. TUI also has `/load`. Headless: `--resume <id>` (errors if missing) **or** `-s/--session-id <id>` (create-or-resume, never errors). Established resume argv used by orchestrators: `grok --resume <session_id>`. The id comes from the session dir name / `summary.json.info.id` / `active_sessions.json` / headless JSON `sessionId`. *(established)*
- **State restored vs lost:** `summary.json` + `updates.jsonl` (authoritative conversation log) drive restore; chat history, model id, cwd, git context (`head_commit`/`head_branch`), todo/plan (`plan.json`), rewind points, and signals are persisted and restored. `summary.json.parent_session_id` links a restored session to its parent. **Permissions are re-applied from flags/config at relaunch**, not from the old session. Live PTY scrollback is **not** part of resume — a resumed TUI re-renders from state. *(established)*
- **Reattach to a still-running PTY after a daemon/server restart:** Grok has **no native PTY-reattach**. Two options:
  - **Generic multiplexer (fallback):** hold the PTY in tmux/abduco, re-attach the byte stream, then send a redraw nudge (SIGWINCH or `Ctrl+L`) so the alt-screen TUI repaints.
  - **Don't reattach the PTY at all (preferred where possible):** keep the **leader/`agent serve`** backend alive and have a new client connect to it; or simply `grok --resume <id>` to spin a fresh front-end over persisted state.
- **Idempotency / race hazards:**
  - Validate/sanitize the session id before use: reject control chars, leading `-`, ids >512 chars; for chat-history path reconstruction additionally require `^[A-Za-z0-9_-]+$` and ≤128 chars (cwd ≤4096). *(established)*
  - `active_sessions.json` PIDs can be **stale** (process died without cleanup) — confirm the PID is alive before treating a session as "running". *(established)*
  - With `-s/--session-id`, two concurrent processes on the same id can race on the session dir (locks observed: `active_sessions.lock`, `auth.json.lock`); serialize writers. With a multiplexer, guard against double-attach (two clients on one master garble input).

---

## 4. Auth & subscription

- **Credential location:** `~/.grok/auth.json` (plain file; `~/.grok/auth.json.lock` guards writes; no OS-Keychain use observed on Linux). Observed schema: keyed by `"<oidc_issuer>::<oidc_client_id>"` → `{key (access token), auth_mode:"oidc", create_time, user_id, email, name, team_id, refresh_token, expires_at (ISO, ~6h lifetime), oidc_issuer (https://auth.x.ai), oidc_client_id}`. Env-key auth path uses `XAI_API_KEY` instead of `auth.json`. *(established)*
  - **Conflicts / open questions:** one source found no agent-specific credential handling at all (no `~/.grok/auth.json` reference). The file *does* exist and is the real credential store; treat it as authoritative.
- **Reuse model:** **spawn-and-let-CLI-auth** (shared `~/.grok/auth.json`) is the native model. There is no built-in account switcher within one home dir (single `auth.json` entry observed). For orchestrator-managed multi-account, the supported lever is **per-account `GROK_HOME`** (point each spawned `grok` at a distinct config dir with its own `auth.json`, sessions, config). *(established for spawn-and-let-CLI-auth; per-`GROK_HOME` is the multi-account method)*
- **Token refresh:** Grok refreshes automatically. OIDC path uses `refresh_token` against `oidc_issuer` (`https://auth.x.ai`) with `oidc_client_id`, silently before `expires_at` (default buffer 300s, `GROK_AUTH_EARLY_INVALIDATION_SECS`) and on 401/403 retry-once; updated tokens are rewritten to `auth.json` (new `create_time`/`expires_at`). External providers refresh via `GROK_AUTH_PROVIDER_COMMAND`. **Treat `auth.json` as live-mutated — do not cache its contents.** *(established)*
- **Env hygiene:** to force the CLI's own OIDC session creds, **omit `XAI_API_KEY`** from the spawned env — its presence flips auth to API-key/custom-endpoint mode. For full isolation set a per-account `GROK_HOME`. No other key-stripping needed. *(established)*
- **Multi-account isolation/selection:** separate `GROK_HOME` dirs per account. Enterprise SSO via OIDC (`GROK_OIDC_ISSUER`/`GROK_OIDC_CLIENT_ID`) or external `auth_provider_command`/`GROK_AUTH_PROVIDER_COMMAND` (+`auth_provider_label`, `GROK_AUTH_TOKEN_TTL`). `grok login [--oauth|--device-auth]` / `grok logout`. *(established)*

---

## 5. Models, usage & accounting

- **Model listing for a settings UI:** `grok models` (human-readable: lists ids, marks default). No documented `--json` on `models`, but the canonical machine-readable source is **`~/.grok/models_cache.json`**: `{fetched_at, grok_version, auth_method, etag, models:{<id>:{info:{id, model, name, description, base_url, context_window, api_backend, auth_scheme, supports_reasoning_effort, supports_backend_search, auto_compact_threshold_percent, hidden, …}}}}`. Refreshed from `{base_url}/v1/models` (override `GROK_MODELS_BASE_URL`/`GROK_MODELS_LIST_URL`), cached with an `etag`. Observed catalog: `grok-build` (ctx 512000), `grok-composer-2.5-fast` (ctx 200000, default). **Prefer reading `models_cache.json`; fall back to parsing `grok models`.** *(established)*
  - **Conflicts / open questions:** one source reports model listing as not supported (no enumeration in code, model read only passively from a saved session via `current_model_id`). The CLI *does* support enumeration via `grok models` + `models_cache.json`; that is the correct method.
- **Runtime model / effort / fast-mode switching mid-session:** TUI has a model picker (slash/menu) and `Ctrl+O` toggles always-approve. `summary.json.current_model_id` reflects the active model; `signals.json.modelsUsed[]`/`primaryModelId` track per-session usage (implying mid-session switches occur). `--effort`/`--reasoning-effort` are launch/headless-time only. The orchestrator cannot drive the in-TUI picker programmatically beyond typing keys. *(partial — established for read-back via `current_model_id`; mid-session keybinding UNVERIFIED)*
- **Usage windows / quota / rate-limits:** **no known local file or subcommand** exposes remaining quota / reset windows / rate-limit status. `grok models` shows "logged in with grok.com" but no quota; `signals.json` has rate-of-work counters but not account quota. Quota would come from grok.com response headers (which headers UNVERIFIED). *(not supported locally)*
- **Token accounting for analytics:** **rich at session level** — per-session `~/.grok/sessions/.../<id>/signals.json` includes `contextTokensUsed`, `contextWindowTokens`, `contextWindowUsage` (percent), `totalTokensBeforeCompaction`, `turnCount`, `toolCallCount`, latency stats (`avgTimeToFirstTokenMs`, `itlP50/P99/Max`, `avgResponseTimeMs`), `agentLinesAdded/Removed`, `humanLines…`, `peakRssBytes`, `compactionCount`, error counters. Session-level totals = yes. **Per-turn input/output/cache/reasoning split = not in plain files** (`contextTokensUsed` is cumulative; `assistant` messages carry `model_id`/`model_fingerprint` but not token counts). *(established for session totals; per-turn split UNVERIFIED/likely absent)*
  - **Conflicts / open questions:** one source reports no token accounting at all (no token fields read from hooks). The on-disk `signals.json` is the real source for session-level accounting.
- **Pricing / cost:** **not supported** — no pricing data or computed cost in any local file/output. Compute externally from token counts × your own rate table. *(not supported)*

---

## 6. Driving & input — two-way control

- **Send a new user message mid-session — two paths:**
  - **Structured (preferred):** `grok agent stdio` (ACP JSON-RPC, `session/prompt`-style) or `grok agent serve` (WS) — send a prompt as a protocol message, no terminal typing. *(established, preferred)*
  - **PTY typing (established fallback):** type text into the running TUI, then submit. Default submit = **Enter**; **`Ctrl+M` toggles multiline mode** (so single Enter inserts a newline instead of submitting). For multi-line/large content, bracketed paste is supported (`ESC[200~ … ESC[201~`, `Ctrl+V` from clipboard, OSC-52 paste). CR timing: send the prompt text, wait a short beat (~50ms), then send a *separate* `\r` to submit (don't combine paste-end and Enter into one write).
- **Read the agent's current input-box contents (draft sync out):** **not exposed** via API/OSC. Only via **screen scrape** of the PTY composer line; dim-placeholder detection would be needed to distinguish empty vs typed (exact placeholder glyph UNVERIFIED). *(not supported cleanly; screen-scrape fallback)*
- **Pre-fill / set the input box (draft sync in):** **no flag/env** to pre-populate the composer without submitting. You can inject the full prompt as initial argv/`-p`/stdin (which *submits*), or type bytes into the PTY without a trailing CR (leaves them in the composer). *(not supported as a clean "set draft" op; both inputs agree)*
- **Answer interactive prompts / permission menus:**
  - **Clean (preferred):** over ACP (`agent stdio`/`serve`), permission requests arrive as structured protocol messages (ACP defines permission UIs) — read the option set and answer programmatically. *(established, preferred)*
  - **Detect presence:** the `permission_prompt` phase in `events.jsonl` (`phase_changed{phase:"permission_prompt"}`) or the `permission_requested` event (authoritative). The on-disk stream shows `permission_requested` → `permission_resolved {decision:"allow"|…, wait_ms}`. *(established)*
  - **PTY fallback:** send arrow keys / digit / Enter into the live PTY (reading the option set = screen scrape); or pre-empt entirely with `--always-approve` / `--permission-mode bypassPermissions` so prompts never appear. *(fallback)*
- **Interrupt / cancel / escape:** `Ctrl+C` or `Esc` = cancel current operation. `Ctrl+D` / `Ctrl+Q` = quit (with confirm). `Ctrl+G` = move foreground task to background. **[README 426-433]** *(established)*
- **Slash commands the orchestrator may issue (TUI):** `/new`, `/load`, `/always-approve [on|off]` (`/yolo`), `/plugins [list|reload|trust]` (`/plugin`), `/hooks-list`, `/hooks-trust`, `/hooks-add <path>`, `/compact`, `/flush`, `/rewind`. The `updates.jsonl` `available_commands_update` event enumerates the live command list. *(established)*
- **Attachments (files/images) & large paste:** **`@` file references** in the prompt — `@path`, `@path:10-50` (line range), `@!.env` (`!` bypasses ignore rules); typing `@` opens a fuzzy file picker (Tab/Enter to select). Image gen/edit tools exist (`imagine` skill); `--prompt-json` accepts content blocks (multimodal input possible). Large paste via `Ctrl+V` / bracketed paste. *(established)* **UNVERIFIED:** whether pasted images are stored as files in the session dir.
- **Important keyboard shortcuts (for a mobile soft-keyboard bar):** **[README 419-433]**
  - **Enter** = submit (single-line). **Ctrl+M** = toggle multiline (then Enter = newline).
  - **Ctrl+C** / **Esc** = cancel current operation. **Ctrl+D** / **Ctrl+Q** = quit (confirm).
  - **Ctrl+O** = toggle always-approve (YOLO). **Ctrl+T** = toggle TODO/task panel. **Ctrl+R** = search prompt history. **Ctrl+V** = paste. **Ctrl+U** = undo last input change. **Ctrl+G** = foreground→background. **Ctrl+P** = toggle debug panel.
  - **`/`** opens slash menu; **`@`** opens file picker. Menu navigation = arrow keys + Enter.
  - **All shortcuts are Ctrl-based — no Alt/Option/Meta fidelity required** (friendly for a mobile key bar). *(established)*

---

## 7. Agent-state classification

- **State vocabulary:** map into `working | waiting | done` (+ `error`/`interrupted`). Grok's own **phase** machine (`events.jsonl` `phase_changed.phase`) has observed values `waiting_for_model`, `streaming_reasoning`, `streaming_text`, `tool_execution`, `permission_prompt`. (Grok never emits a `blocked` state.)
- **Signal sources, by authority:**
  1. **`events.jsonl` lifecycle events (highest authority, append-only JSONL → cheap to tail):** `turn_started`, `loop_started`, `first_token`, `tool_started{tool_name}`, `permission_requested{tool_name}`, `permission_resolved{tool_name,decision,wait_ms}`, `tool_completed{tool_name,duration_ms,outcome}`, `turn_ended{outcome:"completed"|…}`, plus very-frequent `phase_changed{phase}`. MCP lifecycle: `mcp_server_starting/failed`, `mcp_init_completed`.
  2. **`updates.jsonl` (ACP stream, equally authoritative if you consume ACP):** `params.update.sessionUpdate` ∈ `tool_call`, `tool_call_update`, `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`, `available_commands_update`, `hook_execution`. Over `agent stdio`/`serve` these arrive live as JSON-RPC `session/update` — the cleanest realtime source.
  3. **Hook callbacks** (see §8): Claude-compatible `SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`Stop`/`SessionEnd`/`Notification` events POSTed to a local collector — the established push-based path when you don't want to tail files. An established hook→state mapping: `SessionStart` → reset per-turn cache, emit no visible row; `UserPromptSubmit`/`PreToolUse`/`PostToolUse`/tool-failure → **working**; `Stop`/`SessionEnd` → **done**; `Notification` whose message matches permission/approval text → **waiting**, whose message matches idle/"type your message" text → **done**.
  4. **`active_sessions.json` PID + process liveness:** running vs exited.
  5. **`signals.json`** (derived counters: `errorCount`, `toolFailureCount`, `cancellationCount`, `consecutiveCancellations`, `regenerationCount`, doom-loop counters) — blocked/error heuristics, not realtime.
  6. **OSC title / PTY output-activity** (generic fallback: output bytes ⇒ working). **No OSC JSON status channel** is emitted by Grok.
- **Event→state mapping (file-based, suggested):** `turn_started`/`loop_started`/`first_token`/`streaming_*`/`tool_execution`/`tool_started` → **working**; `permission_requested` / `phase=permission_prompt` → **waiting (needs user)**; `tool_completed{outcome:"success"}` → still working until `turn_ended`; `turn_ended{outcome:"completed"}` → **done/idle**; `turn_ended` non-completed outcome or rising `errorCount`/`cancellationCount` → **error/interrupted**.
- **"Stopped but needs the user" vs "done":**
  - **Clean (preferred):** `permission_requested` / `phase_changed{phase:"permission_prompt"}` (and ACP permission-request messages) = waiting-on-user; `turn_ended{outcome:"completed"}` = done.
  - **Hook-only fallback:** Grok exposes no structured permission event *to the Claude hook channel*, so when relying solely on `Notification` hooks, distinguish by **message-text heuristics** — substrings `permission`/`approval`/`approve`/`allow`/`confirm`/`needs your`/`requires your`/`feedback`/`clarify`/`question` → waiting; `type your message`/`enter send`/`shift-tab normal`/`ask a side question` → done. Prefer the `events.jsonl`/ACP signals over text-matching when available.
- **Reconciliation:** `phase_changed` fires sub-second (thousands per session) — debounce/quiet-window it; use the coarse lifecycle events (`turn_started`/`tool_started`/`permission_*`/`turn_ended`) as the state spine and phase only for sub-state. Hold `waiting` until `permission_resolved`. On a new turn (`user_prompt_submit`) reset per-turn caches; on a `notification` event do **not** overwrite the cached user prompt with the notification copy. Grok wraps submitted prompts in `<user_query>…</user_query>` — strip that envelope before display.
- **Sub-agent / nested-task state:** subagents get child session dirs under `…/<id>/subagents/`; `turn_started.session_relationship` = `"primary"` (vs child). Child identity nests under the parent id. *(established)*
- **Latency:** `events.jsonl`/`updates.jsonl` fire in real time (ms timestamps; `first_token`/`tool_*` immediate); `signals.json` is recomputed periodically/at turn end. Hook POSTs are best-effort with tight timeouts (e.g. `curl --connect-timeout 0.5 --max-time 1.5 || true`).
  - **Conflicts / open questions:** one source treats the Claude-style **hook channel** as the sole authoritative state source (it lacks structured permission/phase events, hence the Notification text-heuristics). The CLI additionally writes `events.jsonl` (with explicit `permission_requested`/`phase_changed`) and the ACP `updates.jsonl`/live stream, which are strictly richer and avoid text-matching. Use file/ACP signals as primary; keep the hook channel as a push fallback.

---

## 8. Hooks & instrumentation install

- **Mechanism — Claude-Code-compatible shell hooks (established):** Grok discovers hooks from `<repo>/.grok/hooks/` **and reads Claude Code's hook config** — `grok inspect --json` reports hooks sourced from `~/.claude/settings.json`/`settings.local.json` with `vendor:"claude"` and events `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, etc. So an orchestrator that already installs Claude-style `command` hooks gets them honored by Grok. Hook execution also appears in the ACP stream as `hook_execution` updates. Grok also supports plugins/skills/MCP (`grok plugin`, `~/.grok/skills/`, `grok mcp add`); managed/enterprise config via `grok setup` and `/etc/claude-code/managed-settings.json`.
  - **Established managed-install pattern:** write a *dedicated* managed hooks file plus a managed POSIX shell script (and a `.cmd` variant on Windows), referenced as `command` hooks across the event set. Keeping it in a dedicated file leaves user-authored hook files untouched and the install idempotent (sweep stale managed commands on update; count present managed commands for `installed | partial | not_installed | error` status). Remote hosts get the same files mirrored over SFTP (see §15).
- **Install location & trust steps:** project hooks `<repo>/.grok/hooks/` — **projects must be trusted** before they run (`/hooks-trust`, or `inspect`'s `projectTrusted`). **User-level Claude hooks** in `~/.claude/settings*.json` are honored without per-project trust — the cleanest place for an unattended orchestrator. Add ad-hoc: `/hooks-add <path>`; inspect: `/hooks-list` / `grok inspect --json`. *(established)*
- **Hook event taxonomy + payload:** Claude-format events observed: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` (and lifecycle pre/post-tool-use, session start/end per README); a managed install typically registers `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`, `PreToolUse` (`*`), `PostToolUse` (`*`), `PostToolUseFailure` (`*`), `Notification`. Payload = Claude-hook JSON on stdin. Fields worth extracting: event name, tool name/args (`toolName`/`tool_name`/`name`, `toolInput`/`tool_input`/`input`/`arguments`), session id (`sessionId`/`session_id`), cwd (`cwd`/`workspaceRoot`/`workspace_root`), `toolResponse`/`toolOutput`/`error`, `lastAssistantMessage`, `transcriptPath`, Notification `message`, and the `<user_query>`-wrapped prompt (strip the envelope).
- **Transport back to orchestrator:** hook `command` scripts run by Grok (same pattern as Claude): write to a file / append NDJSON / POST to a local HTTP callback with an injected port+token. Established push form: HTTP `POST http://127.0.0.1:${HOOK_PORT}/hook/grok`, form-urlencoded, an auth header (e.g. `X-…-Hook-Token`), body fields `paneKey/tabId/worktreeId/env/version/payload`; a route map `'/hook/grok' → 'grok'` on the listener. **Fail-open:** script exits 0 if endpoint/port/token/pane-id/payload is missing, and the curl is `|| true` with tight timeouts so a stalled listener never blocks Grok. An observed file-based example writes `{event, ts, payload}` NDJSON to `/tmp/harness-status/$HARNESS_TERMINAL_ID.ndjson`.
- **Lifecycle:** config-driven and idempotent (edit `.grok/hooks/` or `~/.claude/settings*.json`); trust is per-project and persists. Event names match Claude's; gate on Grok ≥0.2.x; carry a hook-protocol version for skew handling (warn-once on mismatch).
  - **Conflicts / open questions:** whether Grok emits `SessionStart` at *interactive* boot is **UNVERIFIED** (Claude historically did not). Whether Grok enforces Claude's PreToolUse-deny exit-code semantics identically is **UNVERIFIED**.

---

## 9. Session titles

- **Source of truth (preferred):** **LLM-generated session summary** stored in `summary.json.session_summary` (e.g. `"Automatic Sidebar and Tabs Names: LLM Prompt or Harness?"`). Empty immediately after the first turn, filled in shortly after. Mirrored into `session_search.sqlite.session_docs.title`, shown in `grok sessions list` (SUMMARY column) and the Dashboard. *(established — independently confirmed; also surfaced as `generated_title` in session metadata)*
- **How/when read & updated:** read `summary.json.session_summary` (poll on `updated_at` change) or query the sqlite `title`. No OSC-title channel. Updated by the LLM once enough conversation exists.
- **Fallback / synthetic title:** if `session_summary` is empty, fall back to the first user prompt — from `prompt_history.jsonl` (`prompt`) for that `session_id`, or the first `user` message in `chat_history.jsonl` (strip the `<user_query>` envelope), truncated. For live working-state tabs, a generic synthetic-title spinner applies. *(established)*

---

## 10. Transcript & history

- **Storage:** per-session dir `~/.grok/sessions/<percent-encoded-cwd>/<id>/` with multiple complementary files:
  - **`chat_history.jsonl`** — raw model-facing messages, one JSON object per line. Line `type` ∈ `system`, `user`, `assistant`, `reasoning`, `tool_result`. (Simpler consumers may treat it as `{type, content, timestamp}`.)
  - **`updates.jsonl`** — the **authoritative ACP `session/update` stream** (JSON-RPC), same events an `agent stdio`/`serve` client receives; drives `/load`/restore.
  - **`events.jsonl`** — lifecycle/phase/tool/permission/MCP events (state machine; §7).
  - `signals.json` (accounting; §5), `prompt_context.json`, `system_prompt.txt`, `rewind_points.jsonl`, `hunk_records.jsonl` (file-edit hunks), `plan.json` (todos), `terminal/` (per-tool-call terminal logs), `resources_state.json`, `summary.json` (`info.id`, `info.cwd`, `generated_title`, `session_summary`, `current_model_id`, `head_branch`, `num_chat_messages`/`num_messages`, `created_at`/`updated_at`/`last_active_at`, `parent_session_id`, `git_*`).
- **Parsing / schema mapping:**
  - `user`/`assistant`: `content` is text or an array of blocks (`{type:"text",text}` or `{content}`); `assistant` also has `tool_calls`, `model_id`, `model_fingerprint`. **Strip the `<user_query>…</user_query>` envelope** (case-insensitive) from user content for display.
  - `reasoning`: `{id, summary, encrypted_content, status}` — thinking is **encrypted at rest** (`encrypted_content`); only `summary` is plain. Live thoughts come via ACP `agent_thought_chunk`.
  - `tool_result`: `{tool_call_id, content}`. Tool calls themselves live in `assistant.tool_calls` and `updates.jsonl` `tool_call`/`tool_call_update`.
  - Diffs/edits: `hunk_records.jsonl`; lines added/removed in `signals.json`.
- **Live tail vs historical:** historical = read the JSONL files (full stream). Live = either tail `events.jsonl`/`updates.jsonl` (append/mtime detection) **or** consume the live ACP stream from `agent stdio`/`agent serve` (`session/update`). For status-only consumers, a bounded tail-read of `chat_history.jsonl` on `Stop`/`SessionEnd` (resolving the last assistant message) is a lightweight established path; the chat-history path is reconstructed from hook `sessionId`+`cwd`. Dedup by `tool_call_id` / event `ts`; order by file order / `timestamp`.
  - **Conflicts / open questions:** one source observes no continuous filesystem watcher (live read only triggered by a `Stop`/`SessionEnd` hook). The richer path (tail `events.jsonl`/`updates.jsonl` or subscribe to the ACP stream) gives true realtime; choose per consumer.
- **Consumers:** chat-view = `updates.jsonl` (or `chat_history.jsonl`); last-message/preview = last `assistant` chunk or `summary.session_summary`; clickable file refs/tool calls/diffs = `tool_call`/`tool_call_update` args + `hunk_records.jsonl`; state classification = `events.jsonl`/`updates.jsonl` (§7); resume id, title (§3, §9).
- **Transcript ↔ terminal mapping:** the `terminal/` dir holds per-tool-call terminal output logs (named `call-<uuid>-composer_call_<id>.log`); the model is told a `terminals/` folder mirrors live terminal state (header `pid/cwd/last_command/last_exit_code`). `~/.grok/projects/<slug>/terminals/N.txt` holds running terminal snapshots (note: these are *tool* terminal snapshots, not the TUI screen).
- **Special content types / quirks:**
  - **`<user_query>` envelope** around submitted prompts — strip in both display and title paths.
  - **Reasoning encrypted at rest** (`reasoning.encrypted_content`) — only `summary` is human-readable; handle redaction.
  - **Hooks** appear in the stream as `hook_execution` updates.
  - File references stored as `@`-expanded content in the user message.
  - **Images:** image gen/edit tools exist; whether pasted images are stored in the session dir is UNVERIFIED.
  - **Export:** `grok export <SESSION_ID> [OUTPUT]` renders a Markdown transcript (`-c/--clipboard` to clipboard) — good for a "copy transcript" feature.

---

## 11. Terminal rendering & display fidelity

- **PTY capture → xterm.js:** spawn `grok` in a PTY, stream bytes to xterm.js. Default uses the **alternate screen** (full-screen TUI); pass **`--no-alt-screen`** to run inline (often better for embedding/scrollback). Generic alt-screen-chrome handling applies. **Alternative:** skip PTY rendering entirely and drive via ACP (`agent stdio`/`serve`), rendering the structured stream yourself. No grok-specific OSC status interception (OSC 9999-style channels are not emitted). *(established)*
- **Resize/reflow:** send SIGWINCH on cols/rows change; the Rust TUI repaints on resize. A redraw nudge (SIGWINCH or `Ctrl+L`) helps after reattach. Mobile↔desktop breakpoint remounts are an orchestrator concern (generic).
- **Scrollback model:** native TUI alt-screen (agent owns rendering, re-renders on resize) unless `--no-alt-screen`. With alt-screen, scroll = forward mouse to the TUI; with `--no-alt-screen`, xterm scrollback is orchestrator-owned. *(established)*
- **Mouse forwarding:** forward scroll/click into the alt-screen TUI (mouse mode enabled by the TUI); disable when showing your own scrollback. Exact mouse-mode bytes Grok requests are UNVERIFIED.
- **Snapshot/serialize for reattach:** headless xterm + serialize-addon to persist the last screen, replay on reconnect, then SIGWINCH-nudge (generic — Grok has no native screen snapshot; `~/.grok/projects/<slug>/terminals/N.txt` are *tool* terminal snapshots, not the TUI screen).
- **Local cache → instant render then live reconnect:** cache the serialized xterm buffer (and/or the last N `updates.jsonl` lines) so a returning user sees content instantly, then reconnect the live PTY/ACP and reconcile (dedup by event ts / `tool_call_id`). For the structured path, prime from `updates.jsonl` then subscribe to live `session/update`. Generic mechanism; Grok cleanly supports the structured variant.
- **Composer/cursor / ready-signal for paste:** composer is a prompt line; `Ctrl+M` toggles multiline. Dim-placeholder glyph UNVERIFIED. Established ready-signal for bracketed paste: wait for DECSET 2004 (`ESC[?2004h`) on the PTY then ~1500ms of post-handshake render silence (with a process/title fallback and an ~8s hard timeout); or simply wait for the TUI's first full paint. *(established fallback)*
- **Color/theme/OSC:** standard ANSI/truecolor TUI. **OSC-52 clipboard** is used (`grok ssh` exists specifically to intercept OSC-52 on terminals lacking native support; `Ctrl+V` paste). No custom OSC status channel.

---

## 12. Background / headless invocation

- **Non-interactive invocation — first-class (established):** `grok -p/--single "<PROMPT>"` prints the response and exits. Prompt delivery: `-p` argv, `--prompt-file <PATH>`, `--prompt-json <JSON content blocks>`, or **stdin pipe** (`git diff | grok -p "write a commit message"`). Output via `--output-format plain|json|streaming-json`:
  - **json:** `{"text","stopReason","sessionId","requestId"}`.
  - **streaming-json:** NDJSON `{"type":"text"|"thought","data":…}` then `{"type":"end","stopReason","sessionId","requestId"}`.
  - Other headless-only flags: `-s/--session-id` (create-or-resume), `--max-turns N`, `--tools`/`--disallowed-tools`, `--effort`, `--permission-mode`, `--always-approve`, `--check` (append self-verify loop), `--best-of-n N` (run N ways, pick best).
  - **Conflicts / open questions:** one source reports headless one-shot as not supported / not wired (the orchestrator never invoked `grok` for its own LLM work and defaulted such work to a different agent). The CLI fully supports headless one-shot; it is a viable and recommended path for the orchestrator's own LLM tasks.
- **Uses for the orchestrator's own LLM work:** commit messages (`git diff | grok -p …`), PR title/body, branch names, session/tab summaries, code review (`--output-format json | jq -r .text`), model discovery (`grok models` / `models_cache.json`).
- **Auth path for headless:** inherits `~/.grok/auth.json` (or `XAI_API_KEY`, or `auth_provider_command`); `grok login --device-auth` for headless/CI; `grok agent --reauth` to force auth first.
- **Cost/latency/timeout/output caps:** `--max-turns` caps turns; **no built-in wall-clock timeout flag** (wrap with your own); `streaming-json` lets you stream/abort early. Default model `grok-composer-2.5-fast` is the "fast" path. Local exec, or remote via `agent headless`/relay. No per-call cost output (§5).

---

## 13. Capabilities & quirks matrix

| Capability | Grok CLI |
| --- | --- |
| Resumable | **Yes** — `-r/--resume [id]`, `-c/--continue`, headless `-s/--session-id` (create-or-resume), `/load`, `--restore-code` |
| Hooks | **Yes** — `.grok/hooks/` + **reads Claude `~/.claude/settings*.json` hooks** (`vendor:"claude"`); `/hooks-trust` for project hooks (user Claude hooks need no project trust); also plugins/skills/MCP |
| Structured control protocol | **Yes** — ACP over `agent stdio` (JSON-RPC) + `agent serve` (WS, `--secret`) + `agent headless` (relay) |
| Leader / shared backend | **Yes** — `~/.grok/leader.sock`, `grok leader …`, `agent --leader` |
| Draft prefill (flag/env/none) | **None** — only initial argv/`-p`/stdin (which submit); PTY typing without CR leaves uncommitted text |
| Trust preset | Project trust for hooks/plugins (`projectTrusted`); auth via pre-seeded `auth.json` / `grok login` / `auth_provider_command` |
| Interactive-prompt selection | **Yes via ACP** permission messages (preferred); else detect via `events.jsonl` `permission_requested`/`phase=permission_prompt`; PTY arrow/number keys, or pre-empt with `--permission-mode`/`--always-approve` |
| Title source | **LLM-generated** `summary.json.session_summary`/`generated_title` (mirrored to sqlite `title`); fallback = first prompt |
| Transcript format | Per-session JSONL set: `updates.jsonl` (ACP, authoritative), `chat_history.jsonl`, `events.jsonl`, `signals.json` + `summary.json`; `grok export` → Markdown |
| Headless / one-shot | **Yes** — `grok -p`, `--output-format plain\|json\|streaming-json`, stdin/`--prompt-file`/`--prompt-json` |
| Model listing | **Yes** — `grok models` + `~/.grok/models_cache.json` (ctx window, backend, flags) |
| Usage / quota | Account quota **No**; **rich session token/latency accounting** in `signals.json` |
| Pricing / cost | **No** — compute externally |
| Fast mode | **Yes as a model** (`grok-composer-2.5-fast` vs `grok-build`), plus `--effort`/`--reasoning-effort` (headless) |
| Sandbox | **Yes** — `--sandbox off\|workspace\|read-only\|strict\|custom` + `~/.grok/sandbox.toml` (Landlock/Seatbelt) |
| Worktrees | **Yes** — `--worktree[=name]`, `grok worktree …`, `~/.grok/worktrees.db` |
| Sub-agents | **Yes** — `--agents`/`--agent`/`--no-subagents`/`GROK_SUBAGENTS`; child dirs under `subagents/`; `--best-of-n` |
| Prompt injection | **argv positional** (preferred) / headless `-p` / type-after-ready (mid-session); plain text + separate `\r` |
| YOLO flag | `--always-approve` (`/yolo`, `Ctrl+O`) or `--permission-mode bypassPermissions` |
| Auth managed | Spawn-and-let-CLI-auth (`~/.grok/auth.json`, OIDC); multi-account via per-`GROK_HOME`; omit `XAI_API_KEY` to keep OIDC session |

**Known special-cases / workarounds:**
- Session-dir naming = **percent-encoded cwd** (`/`→`%2F`); the `projects/` dir uses a **dashed slug** — two different encodings, don't conflate.
- `--effort`, `--reasoning-effort`, `--tools`, `--disallowed-tools`, `--max-turns`, `--permission-mode` are **headless-only**; in the TUI they print a warning and are ignored.
- `--verbatim` skips Grok's prompt-wrapping (use when you supply a fully-formed prompt).
- Submitted prompts are wrapped in `<user_query>…</user_query>` — strip the envelope for display/title.
- `XAI_API_KEY` presence flips auth to API-key/custom-endpoint mode — keep it out of the env for OIDC session reuse.
- `active_sessions.json` PIDs can be stale — validate liveness before assuming "running".
- Reasoning content is **encrypted at rest** (`reasoning.encrypted_content`).
- `grok ssh` exists to handle OSC-52 clipboard for remote terminals.
- Sanitize session ids before path reconstruction (`^[A-Za-z0-9_-]+$`, ≤128 chars; cwd ≤4096).
- `grok-*` process names should be recognized as `grok` (packaged platform binaries).

---

## 14. Failure, exit & recovery

- **Crash/exit detection:** process exit code (non-zero ⇒ crash; clean headless `-p` ⇒ 0). Headless stop reason is explicit — `stopReason` (`"EndTurn"`, etc.) in json/streaming-json output distinguishes clean turn end from interruption. On disk, `turn_ended.outcome` (`"completed"` vs other) distinguishes clean completion from cancellation/error; `signals.json` has `errorCount`, `toolFailureCount`, `cancellationCount`, `consecutiveCancellations`, plus doom-loop counters. A `Stop`/`SessionEnd` hook (when used) signals clean completion → `done`; a process exit without a hook is handled by the generic exited-pane path. *(established)*
- **Reattach-after-restart healing:** cross-reference `active_sessions.json` PIDs with live processes to find exited-but-listed (zombie/orphan) rows and reap/mark-exited; for survivors, reconnect via the multiplexer or simply `--resume`. With the leader/`agent serve` backend, the backend can outlive a client restart so the new client reconnects rather than relaunches. A `SessionStart` cache-reset avoids stale "working" rows after reattach. *(established)*
- **Error surfacing to user:** `turn_ended` non-completed outcome, MCP `mcp_server_failed` events (e.g. an observed `handshake_failed` "Auth required"), rising `errorCount`/`toolFailureCount`, headless `stopReason`/non-zero exit, and (external) auth-provider stderr. Grok never maps to a `blocked` state; treat tool failures as still-working-with-error-text and Notification "needs user" copy as `waiting`. *(established)*

---

## 15. Remote / transport

- **Transports supported:**
  - **Local:** PTY TUI, `agent stdio`, `agent serve`, headless `-p` — all local. *(established)*
  - **SSH (remote worktree):** run `grok` over SSH on the remote host (generic PTY/git/fs provider dispatch). `grok ssh` is a thin SSH wrapper adding local OSC-52 clipboard interception (for Apple-Terminal-class terminals); IDE/relay integrations use ACP. *(established)*
  - **Daemon-subprocess:** native via the **leader** model (`~/.grok/leader.sock`, `grok leader …`, `agent --leader`/`agent leader`) and **`grok agent serve --bind <addr> --secret <tok>`** (WebSocket server, optional `--remote` proxy). *(established)*
  - **xAI WS relay:** `grok agent headless --grok-ws-url wss://…/ws --grok-ws-origin …` runs the agent over a WebSocket relay (this is the path producing STATUS=`remote` sessions in `grok sessions list`). *(established)*
- **Forwarding PTY/git/fs/instrumentation over the relay:** for PTY sessions, forward bytes + SIGWINCH over the relay as usual (generic). For the structured path, forward the ACP `session/update`/prompt JSON over the relay (`agent serve`/`agent headless` are purpose-built for this — auth with `--secret`/`GROK_AGENT_SECRET`). Hook callbacks (HTTP/file/NDJSON) must reach a collector **on the host where `grok` runs** (the remote), then be relayed back — same pattern as Claude-style hooks; an established remote hook installer mirrors the dedicated hooks file + managed script over SFTP and the listener shares the same `'/hook/grok' → 'grok'` route on both local server and relay. Git/fs ops run in the remote cwd; map sessions back via `summary.json.cwd`/`git_root_dir`.
- **Agent-specific limitations:** `agent serve` binds `127.0.0.1:2419` by default (localhost — bind/tunnel deliberately for remote). Local-only files (`auth.json`, `leader.sock`, sessions) live under `GROK_HOME` on whichever host runs `grok`; multi-account remote = per-account `GROK_HOME`. Account quota is not locally readable anywhere (§5).

---

## 16. Filesystem watcher & inotify footprint

Grok's `@` file picker is backed by a workspace file index (`session/fs_watch.rs`,
`xai-grok-workspace/src/fs_notify.rs`) that keeps an inotify watch on **every directory**
under the session cwd. inotify has no recursive mode, so one watch is consumed per
directory. Measured on grok 0.2.93. *(established)*

- **The watcher is lazy.** It spawns on first use of the `@` picker (`fs-notify: skipped
  (no consumers)` until a consumer appears), not at session boot. A grok session that never
  opens the picker holds ~0 watches — which is why idle sessions look harmless. *(established)*
- **`.gitignore` is applied only to the repo's immediate children.** Surviving top-level
  directories are then watched **recursively, unfiltered**. So `node_modules/` at the repo
  root is skipped, but `apps/web/node_modules/` — matching the same pattern — is fully
  watched. This is a grok bug, not a config mistake. *(established)*
- `GROK_RESPECT_GITIGNORE=0` does **not** affect the watcher; it only gates `.gitignore`
  filtering inside *tools*. There is no config key or env var that bounds the watcher.
  `[features] codebase_indexing` gates a *different* subsystem (code-nav, web clients only —
  it logs `client_not_web` and skips under the CLI). *(established)*

**Consequence.** A monorepo whose root has an un-ignored directory containing vendored trees
costs ~one watch per directory, per session, and multiplies by concurrent sessions. In this
repo `.claude/*` ignored `.claude`'s *children* but left `.claude` itself un-ignored, so grok
descended into `.claude/worktrees` (28 stale worktrees × `node_modules` ≈ 196K dirs):
**157,252 watches for a single session**. Nine sessions pinned the 1,048,576 system ceiling,
after which `inotify_add_watch` fails with `ENOSPC` — surfacing as `No space left on device`
in unrelated consumers. That is what broke `podium-redeploy.path` (issue #203).

**Mitigation.** Ignore heavy trees as whole directories at the repo root, so they lose the
depth-1 filter. `.gitignore: .claude/` (not `.claude/*`) drops a fresh session from
**157,252 → 801 watches**. A tracked file inside an ignored directory stays tracked, since
ignore rules never apply to paths already in the index. `.git/info/exclude` works identically
and is per-clone if a committed change is unwanted. Neither can prune below depth 1.

**Measuring a session's watches:**

```sh
grep -h '^inotify' /proc/<pid>/fdinfo/* | wc -l          # count
cat /proc/sys/fs/inotify/max_user_watches                # ceiling
# which dirs: fdinfo lines carry hex `ino:`; join against `find <root> -printf '%i %p\n'`
```

Watches are held for the process's lifetime, so **long-lived sessions keep the old footprint
until restarted** — fixing the ignore rules only helps sessions started afterwards.

---

## Open questions / unverified

- Exact CLI version each flag was introduced (resume/headless-session/`--output-format`/leader/sandbox) — gate broadly on ≥0.2.x.
- Whether Grok emits `SessionStart` at *interactive* boot (Claude historically did not).
- Whether Grok enforces Claude's PreToolUse-deny exit-code semantics identically.
- Mid-session model-switch keybinding in the TUI (model picker exists; exact key UNVERIFIED).
- Account quota / reset-window / rate-limit reading — no known local file or subcommand; which grok.com response headers carry it is UNVERIFIED.
- Per-turn input/output/cache/reasoning token split — `signals.json` is session-cumulative; finer per-message token data appears absent.
- Composer dim-placeholder glyph (for empty-vs-typed draft detection) — UNVERIFIED.
- Exact mouse-mode bytes the alt-screen TUI requests.
- Whether pasted images are persisted as files in the session dir.
- Canonical public source-repo URL (config references the marketplace `https://github.com/xai-org/plugin-marketplace.git`; the CLI's own repo path is unconfirmed from bundled docs).
