# Pi — orchestrator integration reference

> Agent CLI: **Pi**, the AI coding-agent CLI from **earendil-works/pi** (a.k.a. `pi-mono`, by Mario Zechner / badlogic). Binary name is **`pi`**.
> - npm: `@earendil-works/pi-coding-agent` (also published as `@mariozechner/pi-coding-agent`); installable via `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` or `curl -fsSL https://pi.dev/install.sh | sh`; standalone binaries on GitHub Releases ship with `SHA256SUMS`.
> - Docs: https://pi.dev/docs/latest (per-page mirror under `packages/coding-agent/docs/` in the repo). Repo: https://github.com/earendil-works/pi. Latest version seen: **v0.79.8** (2026-06-19).
>
> **Architecture facts that drive everything below:**
> - **Pi is a full-screen Node/TUI process** with its own renderer (`@earendil-works/pi-tui`). PTY-host it like any TUI; bring your own multiplexer (tmux/abduco) for survival.
> - **Pi has TWO programmatic control surfaces beyond the raw PTY**, and which one you use changes nearly every answer below:
>   - **(A) Structured I/O modes (preferred where a choice exists):** `--mode rpc` (long-lived JSONL-over-stdin/stdout request/response + event protocol) and `--mode json` (one-shot, emits the full event stream as JSON lines). These give send/abort/state/title/usage/transcript without screen-scraping. Documented in `rpc.md` / `json.md`.
>   - **(B) In-process TypeScript extensions:** loaded via jiti (no build step), with `pi.on(<event>)` lifecycle hooks and a `ctx.ui.*` API for the live TUI (set/read editor text, dialogs, title). This is the only way to drive the *interactive* TUI from inside the process. Documented in `extensions.md`.
> - **There is no settings.json shell-hook surface** (no Claude-Code-style hook scripts). Instrumentation is either an extension that opens its own side-channel, or consuming `--mode rpc`/`--mode json` directly.
> - Note on a sibling: a closely related `omp` agent shares Pi's `PI_CODING_AGENT_DIR` env contract and the same extension API. This document covers **Pi only**; `omp` is out of scope.
>
> Where a fact below could not be confirmed against the CLI's docs/source it is tagged **UNVERIFIED** and repeated in the Open-questions list. Several on-disk/`--help` details could not be confirmed by *running* the tool (it was not installed on the research host); those are sourced from `README.md` and the docs tree (`rpc.md`, `json.md`, `session-format.md`, `extensions.md`, `providers.md`, `models.md`, `keybindings.md`).

---

## 1. Discovery & identity

- **Binary detection / "installed?"** — Command name is `pi`, no known aliases or rename/remap. Resolve `pi` on `PATH` first (`which pi`); confirm with `pi --version` / `pi -v`. Because `pi` is a tiny string, any launch-command classifier must use a word boundary so `pip`, `mpi`, `python`, `comp`, `pomp` do **not** match; a bare/empty command should default to `pi`.
  - Established method: PATH lookup + `pi --version`. Fallback: probe the standalone-binary install location.
- **Version detection / gating** — `pi --version` / `-v`. Self-update via `pi update --self`; `PI_SKIP_VERSION_CHECK` env disables the update check. No documented feature/flag that is version-gated, and no per-agent version gating is required by the orchestrator today.
  - Established method: parse `--version`. **Not supported / not needed:** behavior gating on version (no evidence any flag is version-conditional — UNVERIFIED if any is).
- **Existing-session discovery (paths/globs)** — Sessions are **JSONL files, one per session**, under `~/.pi/agent/sessions/`, *organized by working directory*. Verified layout:
  `~/.pi/agent/sessions/--<cwd-with-slashes-as-dashes>--/<timestamp>_<uuid>.jsonl`.
  Enumerate with the glob `~/.pi/agent/sessions/**/*.jsonl`.
  - Roots are relocatable: `PI_CODING_AGENT_DIR` (whole config dir, default `~/.pi/agent/`), `PI_CODING_AGENT_SESSION_DIR` (sessions only), or `--session-dir <dir>` per run.
  - Established method: glob the sessions tree. (For a live session, prefer the RPC `get_state.sessionFile` over guessing.)
- **Stable session identity** — A `uuid` in the **SessionHeader** (first JSONL line): `{"type":"session","version":3,"id":"<uuid>","timestamp":"<ISO-8601>","cwd":"<path>"}`. The id is obtained:
  - **At launch (structured modes):** RPC `get_state` returns `sessionId` (plus `sessionFile`, `sessionName`); `--mode json` emits the `session` header line first.
  - **For a pre-existing session:** read `id` from the header line, or use the file path itself as identity. Partial-id matching is accepted by `--session`/`--fork`/the resume picker.
  - **Quirk:** Pi does **not** emit a session id over an OSC sequence at launch in the bare TUI; without `--mode json/rpc` or an extension, identity is only recoverable by reading the on-disk transcript after the fact (not usable for a live-launch handshake unless you run a structured mode).
- **Session ↔ repo/worktree/cwd mapping** — `cwd` is encoded **twice**: in the header `"cwd"` field and in the directory name (`--<path-dashed>--`), so mapping is bidirectional from the on-disk layout. New sessions auto-file under the cwd's directory. For a live pane, you can additionally tie pane↔session via the orchestrator's own pane/cwd bookkeeping.

**Conflicts / open questions:** none material. The on-disk directory-name encoding (`--<cwd>--`) is confirmed in `session-format.md`; the live-launch identity handshake requires a structured mode (it is not emitted over OSC).

## 2. Launch & process model

- **Spawn mechanism / PTY host** — `pi` is a full-screen TUI; host it in a PTY (node-pty in a local daemon subprocess, or over SSH for a remote worktree). The launch command is typed into a ready shell (or exec'd directly). Same path as any TUI agent. Pi explicitly supports running inside tmux (`tmux.md`).
- **Launch command + args + env** —
  - Interactive: `pi` (optionally with an initial prompt as argv; `@file` args attach files/images).
  - Headless one-shot: `pi -p "<prompt>"` / `pi --print "<prompt>"`; JSON stream `pi --mode json "<prompt>"`; programmatic `pi --mode rpc`.
  - **Env honored:** `PI_CODING_AGENT_DIR` (config/session/auth root, default `~/.pi/agent/`), `PI_CODING_AGENT_SESSION_DIR`, `PI_PACKAGE_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, `PI_CACHE_RETENTION`, `VISUAL`/`EDITOR`, and provider API-key vars (`ANTHROPIC_API_KEY`, etc. — see §4).
  - **Env to inject for instrumentation:** none required by Pi itself; an extension-based status channel needs whatever coordinates *you* pass (e.g. a pane key, a callback port/token, a hook-endpoint file path) and reads them via `process.env` inside the extension. There is no Pi-defined instrumentation env contract.
  - **Env stripping:** Pi does **not** auto-strip inherited provider keys. Precedence is `--api-key` > `auth.json` > env vars > `models.json` keys, i.e. *auth-file credentials beat env vars*. To force the CLI's own OAuth/stored creds, **unset** the provider env var yourself before spawn (see §4).
- **Durable backing for survival** — **No built-in daemon/multiplexer.** Survival is the orchestrator's job: keep the PTY master alive via tmux/abduco (or a long-lived daemon subprocess), or just resume the JSONL with `--session <id>` after a restart. Pi-in-tmux is documented but needs `set -g extended-keys on` + `extended-keys-format csi-u` (tmux 3.5+) so `Shift+Enter`/`Ctrl+Enter` survive (see §6/§11).
- **Initial-prompt injection** — Multiple first-class modes:
  - **argv (established):** `pi "<prompt>"`, `pi -p "<prompt>"`, `pi --mode json "<prompt>"`. Normal shell quoting. Auto-runs the turn (not a reviewable draft).
  - **stdin merge (established):** piped stdin is merged into the initial prompt (`echo … | pi -p "…"`).
  - **`@file` (established):** prefix file/image paths to attach (`pi @prompt.md "Answer this"`, `pi -p @screenshot.png "…"`).
  - **RPC (established):** send `{"type":"prompt","message":"…"}` after start.
  - **type-after-ready (fallback):** type into the TUI editor; Enter submits when idle, Shift+Enter inserts a newline.
  - **Reviewable draft (no auto-submit):** there is **no CLI flag/env to pre-seed the editor**. The only programmatic prefill is an extension calling `ctx.ui.setEditorText()` on `session_start` (see §6). Without an extension, the only way to stage a non-submitted draft is to paste into the PTY without sending CR.
- **First-run / trust handling** — **Project trust is a real gate.** Non-interactive runs use `defaultProjectTrust` from global `settings.json` (`ask` default | `always` | `never`); override per-run with `-a`/`--approve` or `-na`/`--no-approve`. `/trust` saves a decision to `~/.pi/agent/trust.json`. There is also a `project_trust` extension event for programmatic decisions. To prevent the first prompt being eaten by a trust dialog, **pre-seed** by writing `trust.json` and/or setting `defaultProjectTrust:"always"` in `settings.json`, or pass `--approve` on launch. Theme is auto-detected (terminal background → dark/light) on first run.
  - Established method: `--approve` flag or `defaultProjectTrust:"always"`. Fallback: pre-write `trust.json`.
- **Permission / YOLO / sandbox** — No single "YOLO" flag. The model is:
  - **Project trust** (above) controls whether project-local extensions/skills and edits run.
  - **Tool gating:** `--tools/-t <allowlist>`, `--exclude-tools/-xt`, `--no-builtin-tools/-nbt`, `--no-tools/-nt`.
  - **Sandboxing:** stronger isolation via documented containerization (Gondolin extension, Docker, OpenShell — `security.md`/`containerization.md`).
  - Closest to "YOLO" = `--approve` + a broad `--tools` allowlist.
- **Model / reasoning-effort / fast-mode at launch** — `--provider <name>`; `--model <pattern>` accepting `provider/id` plus a `:<thinking>` suffix; `--thinking <off|minimal|low|medium|high|xhigh>`; `--models <patterns>` to define the `Ctrl+P` cycle set; `--api-key <key>`. **No distinct "fast mode"** — speed is a function of model + thinking level (`off`/`minimal` ≈ fast).

**Conflicts / open questions:** none. (The headless commit-message path historically passed `--no-tools`/`--no-session`/`--no-extensions`/`--no-skills`/`--no-context-files` — that is the §12 non-interactive path, not the interactive launch.)

## 3. Resume & reattach

- **Resume support** — **Yes, native and rich.** Flags: `-c`/`--continue` (most-recent session), `-r`/`--resume` (interactive browse picker), `--session <path|id>` (specific; partial id ok), `--fork <path|id>` (branch a copy into the *same* file as a divergent child), `--no-session` (ephemeral), `--session-dir <dir>`. In-session slash commands: `/resume`, `/new`, `/session`, `/tree`, `/fork`, `/clone`. The resume id is the JSONL header `id` (uuid) or the file path.
  - Established method: `--session <id>` for a specific session; `-c` for "the last one."
- **State restored vs lost on resume** — The JSONL **tree** restores the full conversation history (messages, tool calls/results, thinking, bash executions), model/thinking-level changes (replayed via `model_change`/`thinking_level_change` entries), session name, labels, and compaction summaries. So **history + model + name persist**; **cwd** comes from the header; **permission/trust is re-resolved** against `trust.json` at start (not carried in the session).
- **Reattach to a still-running PTY (after daemon/server restart)** — **No agent-native reattach** — this is the orchestrator's job via the multiplexer (tmux/abduco) or by re-acquiring the daemon's node-pty handle and replaying the serialized buffer. Because Pi is a full-screen alt-screen TUI, after reattach you typically need a **redraw nudge** (SIGWINCH / resize) for it to repaint; tmux is documented to work.
  - Established method: re-attach the multiplexer/PTY handle + send a resize to force repaint. Fallback (if the process died): resume the JSONL with `--session <id>`.
- **Idempotency / race hazards** — **Do not run two writers against the same session JSONL** (a TUI and an RPC process, or two TUIs) — concurrent appends to the tree risk corruption. Use `--fork`/`--no-session` to avoid contention. Whether Pi takes a file lock is **UNVERIFIED**. RPC mode is single-process and safe on its own. An extension-based status channel should be **fail-open** (a failed callback during an orchestrator restart must never break the Pi run).

**Conflicts / open questions:** whether Pi takes a session-file lock to prevent concurrent-writer corruption is unverified — treat "one writer per session id" as a hard invariant regardless.

## 4. Auth & subscription

- **Credential locations** — `~/.pi/agent/auth.json` (relocated with `PI_CODING_AGENT_DIR`). API-key entry shape: `{"<provider>":{"type":"api_key","key":"sk-…","env":{"PROVIDER_VAR":"value"}}}`. OAuth entries store access token + refresh token + expiry (ms) and auto-refresh (exact OAuth field names beyond access/refresh/expiry are **UNVERIFIED**). Provider env vars are also read. An SDK `AuthStorage` can point at a custom `auth.json` path.
- **Reuse model** — **Spawn-and-let-CLI-auth** is the primary path (`/login` interactive, `/logout`). Pi commonly authenticates through GitHub Copilot locally as well as direct provider OAuth (Anthropic Claude Pro/Max, OpenAI ChatGPT/Codex). Orchestrator-managed multi-account is **feasible but not built-in**: write per-account `auth.json` files and point each spawned `pi` at a distinct `PI_CODING_AGENT_DIR` (or a custom `AuthStorage` path).
  - Established method: spawn-and-let-CLI-auth (rely on the user's `~/.pi/agent/auth.json`). Fallback: per-account `PI_CODING_AGENT_DIR` for isolation.
- **Token refresh** — Pi refreshes OAuth tokens itself when expired and writes back to `auth.json` ("auto-refresh when expired"). Refresh endpoints/client-ids are provider-specific and **not enumerated** in the docs (UNVERIFIED). The orchestrator does **not** need to (and should not) drive refresh.
- **Env hygiene** — Precedence: `--api-key` > `auth.json` > env vars > `models.json` keys; *auth-file credentials take priority over environment variables.* Pi does **not** auto-strip inherited keys. To force OAuth/stored creds over an inherited key, the orchestrator must **unset** the provider env var before spawn.
  - Established method: unset provider env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) at spawn when you want the stored OAuth account. **Not supported:** auto-strip by Pi.
- **Multi-account support** — Per-entry providers in `auth.json` (with per-credential `env`). Stronger isolation = a separate `PI_CODING_AGENT_DIR`/`auth.json` per account, selected by env at spawn. No built-in "account switch" UI.

**Conflicts / open questions:** OAuth field names and per-provider refresh endpoints/client-ids are unverified — but they are Pi-internal (auto-refresh), so the orchestrator never touches them.

## 5. Models, usage & accounting

- **Model listing for a settings UI** — `pi --list-models [search]` lists models by `id`; the catalog lives in `~/.pi/agent/models.json` (reloaded whenever `/model` opens). Built-in providers ship a default catalog; custom/override entries are upserted by `id` (a custom id equal to a built-in id replaces it). Programmatic enumeration via the SDK `ModelRegistry`/`modelRegistry`. Each entry: required `id`; optional `name`, `reasoning`, `input` (modalities), `contextWindow`, `maxTokens`, `cost`, `thinkingLevelMap`.
  - **Quirk to handle:** Pi may write the successful `--list-models` table to **stderr** — capture/parse **both** stdout and stderr, preferring whichever is non-empty. The parseable format is a whitespace-columned table (`provider model … thinking`); a model whose `thinking` column is `yes` supports thinking levels `off/low/medium/high/xhigh`.
  - Established method: `pi --list-models` (parse stdout+stderr) or read `~/.pi/agent/models.json` directly. SDK `ModelRegistry` for in-process.
- **Runtime model / reasoning-effort / fast-mode switching mid-session** — **Yes.** Slash: `/model`, `/scoped-models`. Keys: `Ctrl+L` (selector), `Ctrl+P` / `Shift+Ctrl+P` (cycle the `--models` set), `Shift+Tab` (cycle thinking level). RPC: `{"type":"set_model",…}` (errors if not found) and thinking-level setters. SDK/extension: `pi.setModel()`, `pi.setThinkingLevel()`/`getThinkingLevel()`. **No fast-mode toggle** — change model or thinking level instead.
  - Established method: RPC `set_model` (scripted) or `/model` / `Ctrl+L` (PTY).
- **Usage windows / quota / rate-limits** — **Not supported.** No documented command/file for remaining quota, reset windows, or rate-limit status. (`auto_retry_start`/`auto_retry_end` events report transient provider-error backoff, not quota.)
- **Token accounting for analytics** — **Yes, rich.** Assistant messages carry `usage` with `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost` — present in the JSONL (`SessionMessageEntry`) and streamed in RPC/JSON `message_end` events. `/session` shows messages/tokens/cost; the footer shows token/cache usage + cost + context usage + model. A minimal consumer can sum `usage.totalTokens` across assistant messages from the transcript.
  - Established method: read per-message `usage` from RPC/JSON `message_end` (live) or the JSONL (historical).
- **Pricing / cost** — **Computed by Pi** from per-model `cost` rates in `models.json` (`cost:{input,output,cacheRead,cacheWrite}`, per million tokens, default zeros). The computed `cost` appears in each assistant message's `usage`. Source of truth for rates = `models.json` (editable).

**Conflicts / open questions:** the stderr-vs-stdout destination of `--list-models` output is a known quirk — always read both. No quota/rate-limit surface exists.

## 6. Driving & input — two-way control

- **Send a new user message mid-session** —
  - **RPC (authoritative):** `{"type":"prompt","message":"…","images?":[…]}`. While the agent is streaming, add `"streamingBehavior":"steer"` (inject after current tool calls, before the next LLM call) or `"followUp"` (after the agent finishes). Response: `{"type":"response","command":"prompt","success":true}`.
  - **PTY/TUI (fallback):** type into the editor. **Enter** submits when idle; **while the agent is running, Enter QUEUES a steering message** and **Alt+Enter queues a follow-up**. **Shift+Enter** = newline. For PTY injection use bracketed paste for multi-line; send CR (`\r`) to submit.
  - **Critical semantics quirk:** Enter is *contextual* (idle→submit, busy→queue-steer). An orchestrator's "send" must track busy/idle, or prefer RPC `streamingBehavior` over raw Enter when scripting.
- **Read the agent's current input-box contents (composer→chat draft sync)** — **Not exposed as a query.** RPC `get_state` does **not** return editor text. Only an extension can read it (`ctx.ui.getEditorComponent()` / editor-component access). Without an extension the only option is **screen-scrape** the PTY (no clean method).
  - Method: extension `getEditorComponent` (in-process). Fallback: screen-scrape. **Not supported:** an RPC/JSON channel for composer contents.
- **Pre-fill / set the input box (draft sync orchestrator→composer)** — **Extension only:** `ctx.ui.setEditorText()` (replace) and `ctx.ui.pasteToEditor()` (append). The established pattern is an installed extension that, on `session_start` (reason `startup`), reads a coordinate you passed (e.g. an env var) and calls `ctx.ui.setEditorText(prefill)`, then clears it. **No CLI flag/env natively seeds the editor.** Without an extension: paste into the PTY (do not send CR for a reviewable draft).
  - **Why prefer the extension over post-ready paste:** Pi's multi-second startup banner (skills/extensions/context loading) keeps resetting any bracketed-paste readiness quiet-timer, so a post-ready paste frequently never lands. The extension `setEditorText` path is reliable; route drafts through it.
  - Established method: extension `setEditorText` on `session_start`. Fallback: bracketed paste into PTY (unreliable due to the startup banner).
- **Answer interactive prompts / AskUser / permission menus** — In the TUI these are **list overlays** driven by `Up`/`Down`, `PageUp`/`PageDown`, `Enter` (confirm), `Escape`/`Ctrl+C` (cancel) — so an orchestrator selects via arrow + Enter byte sequences. Programmatically, extensions raise dialogs via `ctx.ui.select()/confirm()/input()/editor()`. The **set of options is only readable from the rendered screen** outside of extensions — there is no RPC channel that returns menu contents (UNVERIFIED whether any clean machine-readable option list exists outside extensions).
  - Method: arrow-key + Enter byte sequences into the PTY (selection). **Not supported:** reading the option set over RPC/JSON; use an extension dialog if you need structured options.
- **Interrupt / cancel / escape** —
  - **TUI:** `Escape` cancels the current action; `Ctrl+C` clears/quits; `Escape` twice opens `/tree`.
  - **RPC:** `{"type":"abort"}` (cancel turn), `{"type":"abort_bash"}` (kill running bash), `{"type":"abort_retry"}` (skip retry backoff).
  - Established method: RPC `abort` (scripted) or `Escape` byte (PTY).
- **Slash commands the orchestrator may issue** — `/login`, `/logout`, `/model`, `/scoped-models`, `/settings`, `/resume`, `/new`, `/name <name>`, `/session`, `/tree`, `/trust`, `/fork`, `/clone`, `/compact [prompt]`, `/copy`, `/export [file]`, `/share`, `/reload`, `/hotkeys`, `/changelog`, `/quit`. Prompt-templates/skills appear as slash commands; extensions add their own via `pi.registerCommand`.
- **Attachments / large paste** — Images via `@file` on argv (`pi -p @img.png "…"`), TUI `Ctrl+V` paste-image, and RPC `images:[{type:"image",data:"<base64>",mimeType:"image/png"}]`. Files via `@`-prefix fuzzy include. Large text: bracketed paste into the editor.
- **Important keyboard shortcuts & modifier keys (for mobile soft-keyboard)** —
  - `Enter` = submit / (while busy) **queue steering**.
  - `Shift+Enter` = newline. `Alt+Enter` = queue follow-up.
  - `Escape` = cancel; `Escape Escape` = open `/tree`. `Ctrl+C` = clear/quit.
  - `Ctrl+L` = model selector; `Ctrl+P` / `Shift+Ctrl+P` = cycle models; `Shift+Tab` = cycle thinking level.
  - `Ctrl+O` = collapse output; `Ctrl+T` = collapse thinking.
  - Lists: `Up`/`Down`, `PageUp`/`PageDown`, `Enter`, `Esc`.
  - `@` = file fuzzy-search; `Tab` = path completion; `!cmd`/`!!cmd` = run shell (send / no-send); `Ctrl+V` = paste image.
  - **Modifier-critical keys a soft keyboard must reproduce faithfully:** `Shift+Enter`, `Alt+Enter`, `Shift+Tab`, `Shift+Ctrl+P`. Over tmux these require `extended-keys on` + `csi-u` or they collapse to plain Enter/Tab.

**Conflicts / open questions:** machine-readable menu/option enumeration outside extensions is unverified. Treat RPC `streamingBehavior` as the canonical "send while busy" path; raw-Enter semantics are contextual and easy to get wrong.

## 7. Agent-state classification

- **State vocabulary** — `working` (streaming / tool-exec), `waiting-on-user` (permission/dialog/queued), `idle`/`done` (turn_end / agent_end), `error`, `interrupted/aborted`, plus transient `compacting` and `retrying`.
- **Signal sources & authority (best → worst):**
  1. **RPC/JSON event stream (authoritative):** `agent_start`/`agent_end`, `turn_start`/`turn_end`, `message_start`/`message_update`/`message_end`, `tool_execution_start`/`_update`/`_end`, `tool_call`, `queue_update`, `compaction_start`/`_end`, `auto_retry_start`/`_end`, `done{reason}`. Plus the `get_state` snapshot (`isStreaming`, `isCompacting`, `pendingMessageCount`, …).
  2. **Extension hooks (authoritative, in-process):** the same lifecycle events via `pi.on(...)` (§8), plus `tool_call` (can block) and `project_trust`.
  3. **Transcript JSONL (post-hoc):** `stopReason` + entry types.
  4. **PTY output activity / process foreground:** weak fallback when not in a structured mode.
  5. **Process exit:** terminal (see §14).
  - **Secondary idle/working hint (PTY-only):** an installed titlebar extension can set an OSC terminal title (e.g. a `π - …` idle form vs. a braille-spinner-prefixed working form) that the orchestrator classifies. There is **no native** OSC title/status from Pi itself; this requires the extension (see §9). Pi does **not** emit a generic OSC-9999 JSON status channel.
- **Event → state mapping:**
  - `agent_start` / `turn_start` / `tool_execution_start` / `tool_call` / `tool_execution_end` / `message_*` → **working**.
  - `tool_call` returning `{block:true}` or a pending UI dialog (`ctx.ui.select/confirm`) / outstanding `project_trust` → **waiting-on-user**.
  - `queue_update` with pending steer/followUp → input queued (still **working**).
  - `turn_end` / `agent_end` / `done{reason:"stop"}` (no pending dialog) → **done/idle**.
  - `done{reason:"aborted"}` → **interrupted**.
  - `done{reason:"error"}` / message `stopReason:"error"` → **error**.
  - `compaction_start..end` → **busy (compacting)**; `auto_retry_start..end` → **retrying**.
  - A new-turn boundary is marked by `before_agent_start` (use it to reset per-turn tool/prompt caches).
- **"Stopped but needs the user" vs "done"** — Distinguish by whether a permission/trust signal (`tool_call` block, `project_trust`) or a pending UI dialog is outstanding (→ **waiting**) versus a clean `turn_end`/`agent_end` with `done.reason:"stop"` and no pending dialog (→ **done**). **Pure stdout/exit cannot tell them apart** — you must consume the event stream or an extension hook. (A PTY-only integration that does not run a structured mode or extension therefore *cannot* reliably detect "blocked on user.")
- **Reconciliation** — Use RPC/hook events as truth. Debounce the high-frequency `message_update`/`tool_execution_update` deltas. `get_state` reconciles after a reconnect. Stickiness: hold "working" until an explicit `turn_end`/`done`.
- **Sub-agent / nested-task state** — Pi supports subagents; nested tool/turn events are emitted within the parent stream. Per-subagent identity/channel inheritance is **UNVERIFIED** from the docs.
- **Latency** — Streaming deltas fire continuously; tool start/end fire at boundaries — low latency in RPC/JSON. PTY-scrape and OSC-title fallbacks lag. Mtime-cache any on-disk endpoint coordinate an extension reads, to avoid re-parsing during streaming.

**Conflicts / open questions:** Per-subagent state identity is unverified. The richest mapping (waiting/error/compacting/retrying) is only available via the RPC/JSON event stream or an extension; a bare-PTY integration collapses to `working`/`done` plus the OSC-title idle/working hint.

## 8. Hooks & instrumentation install

- **Mechanism** — **In-process TypeScript extensions** loaded via jiti (no build step). `pi.on(<event>)` lifecycle hooks; can also register tools, commands, shortcuts, flags, providers. **There is no settings.json shell-hook surface and no Claude-Code-style hook scripts.** The alternative to an extension is to consume `--mode rpc`/`--mode json` directly (no install, no trust step).
- **Install location / trust** —
  - Global: `~/.pi/agent/extensions/*.ts` or `~/.pi/agent/extensions/<name>/index.ts` — **always loaded**.
  - Project-local: `.pi/extensions/...` — loaded **only after** `project_trust` resolves "yes."
  - Custom paths via `settings.json` `extensions` array; quick test with `pi -e ./ext.ts`.
  - Packages declared in `settings.json` `packages` (`npm:@org/pkg@version`, `git:github.com/u/repo@tag`) and installed via `pi install <src> [-l]`.
  - **Trust step = project trust** (extensions run with full system permissions — explicit warning in the docs). No config-file *hash* step.
  - **Install pattern for the orchestrator:** drop a managed extension into the extensions dir (auto-loaded — **no `--extension` flag needed**). Mark managed files (e.g. a comment marker) and only overwrite files carrying that marker so user-owned files are never clobbered; sweep them on teardown. `--no-extensions` disables all extensions.
- **Hook event taxonomy + payload fields (extract these)** — `project_trust{cwd}`→`{trusted,remember}`; `session_start{reason,previousSessionFile?}`; `session_shutdown{reason,targetSessionFile?}`; `before_agent_start{prompt,images?,systemPrompt,…}` (can rewrite prompt/system); `agent_start`/`agent_end{messages}`; `turn_start{turnIndex,timestamp}`/`turn_end{turnIndex,message,toolResults}`; `message_start`/`_update`/`_end{message,assistantMessageEvent?}`; `tool_execution_start`/`_update`/`_end{toolCallId,toolName,args/result,isError}`; `tool_call{toolName,toolCallId,input}`→`{block?,reason?}`; `tool_result{...}`→patch; `model_select{model,previousModel?,source}`; `thinking_level_select{level,previousLevel}`; `input{text,images?,source,streamingBehavior?}`→transform/handle; `user_bash{command,…}`; `context{messages}`→rewrite; `before_provider_request{payload}`/`after_provider_response{status,headers}`; compaction/tree events; `extension_error` (load/handler failures).
  - For a status channel, the high-value extracts are: `tool_name`/`tool_input` (tool_* + tool_call), assistant **text** from `message_end` (text parts only — drop `tool_use`/`reasoning`/`tool_result` parts as preview noise), and the prompt from `before_agent_start`.
- **Transport back to the orchestrator** — **No built-in HTTP-callback-with-injected-port/token.** The extension runs in-process and must open its **own** side-channel: `fetch` to a loopback endpoint, `pi.exec`, write a file, or open a socket. The established pattern is an extension that HTTP-POSTs each event to a small loopback listener the orchestrator runs, reading the endpoint coordinate (host/port/token) from `process.env` (or, more robustly, an on-disk endpoint file re-read on each event — because `process.env` is frozen at spawn, re-reading a file lets callbacks survive an orchestrator restart). **Fail-open is your responsibility** inside the handler (swallow fetch errors so a transient orchestrator outage never breaks the Pi run). Alternatively, skip extensions entirely and consume `--mode rpc`/`--mode json`.
- **Lifecycle / idempotency / version-skew** — `pi install/remove/list`, `pi update [source|--all|--extensions|--self]`, `pi config`. Hot-reload via `/reload` or `ctx.reload()`. Extensions import `@earendil-works/pi-coding-agent`'s API — pin via package version to avoid skew; `extension_error` reports load/handler failures. Managed-extension writes should be idempotent (marker-gated) and swept on teardown.

**Conflicts / open questions:** none on mechanism. The transport is entirely orchestrator-built (Pi provides no port/token contract) — design it fail-open and prefer the on-disk-endpoint-file re-read for restart resilience.

## 9. Session titles

- **Source of truth** — A user/agent-set **session name** stored in the JSONL as a `SessionInfoEntry` (`{"type":"session_info","name":"…"}`). Set via `/name <name>`, `-n`/`--name <name>` at launch, RPC `sessionName`, or `pi.setSessionName()`. **There is no native automatic LLM-generated title and no native OSC-title title** — absent a name, fall back to the session id or the first user message.
- **Live-pane title (optional, extension-provided)** — For a live tab/pane indicator you can install a titlebar extension that calls `ctx.ui.setTitle(...)` to emit an OSC title (e.g. `π - <session-name> - <cwd-basename>`, with a braille-spinner prefix while `agent_start..agent_end`), which the orchestrator reads via its generic OSC-title interception. This is **orchestrator-installed**, not a Pi-native title.
- **Read / update / eventing** — Read from the latest `session_info` entry in the JSONL or RPC `get_state.sessionName`; set with `pi.setSessionName()` / `/name` / RPC. No dedicated title-changed event is documented (UNVERIFIED) — observe by re-reading the JSONL or polling `get_state`.
- **Fallback / synthetic title** — No built-in synthetic-title scheme. The orchestrator should synthesize from the **first user message** (truncate) or the uuid when no `session_info.name` exists.
  - Established method: `session_info.name` (read) + `/name`/RPC `sessionName` (write). Fallback: first-user-message truncation. Optional: extension OSC title for the live pane.

**Conflicts / open questions:** no documented title-changed event — poll `get_state` or re-read the JSONL. The OSC-title path is an orchestrator add-on (an installed extension), not a Pi-native title source.

## 10. Transcript & history

- **Storage** — One **JSONL file per session** at `~/.pi/agent/sessions/--<cwd-dashed>--/<timestamp>_<uuid>.jsonl`. **Tree-structured, not linear.** Header line: `{"type":"session","version":3,"id","timestamp","cwd","parentSession?"}`.
- **Schema / parsing** — Every non-header entry extends `SessionEntryBase{type,id(8-hex),parentId(null for the first),timestamp}`. Entry types:
  - `message` (`SessionMessageEntry`): `message.role` ∈ `user|assistant|toolResult|bashExecution|custom`. Content is an **array of parts**: `TextContent`, `ImageContent`, `ThinkingContent`, `ToolCall`. Assistant adds `api`, `provider`, `model`, `usage{input,output,cacheRead,cacheWrite,totalTokens,cost}`, `stopReason(stop|length|toolUse|error|aborted)`. `toolResult`: `toolCallId`, `toolName`, `content`, `isError`. `bashExecution`: `command`, `output`, `exitCode`, `cancelled`, `truncated`.
  - `session_info{name}` (title); `compaction{summary,firstKeptEntryId,tokensBefore}`; `branch_summary{fromId,summary}`; `label{targetId,label}`; `model_change{provider,modelId}`; `thinking_level_change{thinkingLevel}`.
- **Live tail vs historical read** —
  - **Historical:** parse the JSONL tree; walk `parentId` from the active leaf to reconstruct the visible path.
  - **Live (preferred):** consume `--mode json`/`--mode rpc` (structured, ordered, no file-watch races); RPC `get_messages` returns all current `AgentMessage`s; `message_end` carries the final assistant text + `usage`.
  - **Live (fallback):** tail the append-only JSONL.
  - Order/dedup via the `id`/`parentId` tree walk along the active leaf path.
- **Consumers and what each needs** — chat-view ← message entries (text/thinking/toolCall + toolResult); last-message/preview ← latest assistant text from `message_end` (text parts only); clickable items ← tool calls (`read`/`edit`/`write` args carry file paths), bash commands, diffs inside edit/write tool results; state classification ← `stopReason` + event stream (§7); token/cost panel ← `usage`.
- **Transcript ↔ terminal mapping** — The TUI renders the same active-leaf path of the tree; reconcile by walking `parentId` from the current leaf. Branches/forks create divergent children of one parent **in-place (no new file)**. There is no byte-level reconciliation between the JSONL and the live xterm buffer — the terminal is the live view, the JSONL is the structured/historical view, joined by session id + cwd.
- **Special content types / quirks** — Images = `ImageContent` (base64 + mimeType; pasted via Ctrl+V or `@file`, sent via RPC `images`). Thinking/reasoning = `ThinkingContent` (collapsible with Ctrl+T; **drop from previews as noise**). Diffs are **not** a separate type — they live inside `edit`/`write` tool-call args/results. Bash output is its own `bashExecution` role. A `custom` role + `appendEntry(customType,…)` lets extensions persist private state that does **not** enter LLM context. Compaction replaces history with a `compaction.summary` (keep-from `firstKeptEntryId`).

**Conflicts / open questions:** none material — the JSONL tree schema is documented in `session-format.md`. Note the tree (not list) structure: any linear reader must walk the active-leaf path or it will mis-render forks.

## 11. Terminal rendering & display fidelity

- **PTY → stream → xterm** — Pi is a full-screen TUI (`@earendil-works/pi-tui`). Capture PTY bytes and pipe to xterm.js. It very likely uses the **alt-screen** (typical for full TUIs) — this is **UNVERIFIED** in the docs (`terminal-setup.md` covers only keyboard protocols, not OSC/alt-screen/mouse). Treat it as alt-screen and strip client alt-screen chrome as needed. Intercept OSC title sequences for the pane title (only present if a titlebar extension is installed — §9); stream the rest.
- **Resize / reflow (SIGWINCH)** — Forward SIGWINCH on cols/rows change; as with most TUIs a resize triggers a full repaint. After reattach, send a **resize nudge** to force a redraw. Mobile↔desktop breakpoint remount is the orchestrator's generic handling. Pi-specific redraw quirks are **UNVERIFIED**.
- **Scrollback model** — Native TUI with its own history navigation (`/tree`, list overlays, `Ctrl+O`/`Ctrl+T` collapses) — scrolling the agent's history is driven via **Pi's keys**, not xterm scrollback. If alt-screen, mouse scroll is forwarded to the TUI. Exact mouse-mode is **UNVERIFIED**.
- **Mouse forwarding** — Not documented. Assume the TUI may request mouse mode; forward scroll/click when in alt-screen. **UNVERIFIED.**
- **Snapshot/serialize for reattach** — No agent-native snapshot — use headless-xterm serialize on the orchestrator side; reattach + resize nudge to repaint.
- **Local cache for instant render then live reconnect** — Not provided by Pi. The orchestrator caches the last serialized buffer, paints instantly, then reconnects the live PTY and reconciles (standard approach; nothing Pi-specific helps or hinders). For the structured tier, `get_state`/`get_messages` reconciles transcript state after reconnect.
- **Composer/cursor specifics** — The editor supports `@` fuzzy include, `Tab` completion, `Shift+Enter` multiline, `Ctrl+V` image paste. **No documented dim-placeholder/ready-signal** for paste; use bracketed paste. **Critical paste caveat:** Pi's long startup banner (skills/extensions/context) keeps resetting any bracketed-paste readiness quiet-timer, so post-ready paste of an initial draft is unreliable — prefer the extension `setEditorText` path (§6). Extensions can set/read editor text (`setEditorText`/`pasteToEditor`/`getEditorComponent`).
- **Color/theme/OSC quirks** — Auto-detects terminal background (dark/light) on first run; built-in + custom themes (`themes/`, `--theme`). Keyboard-protocol setup is terminal-specific (`terminal-setup.md`, tmux `extended-keys`) so `Shift`/`Ctrl`/`Alt+Enter` survive — critical for fidelity over a relay. The only OSC title/status sequence is the optional one an installed titlebar extension emits (no native OSC title — so §9 titles come from the JSONL, not OSC, by default).

**Conflicts / open questions:** alt-screen usage, exact mouse-mode, and Pi-specific redraw behavior are all **UNVERIFIED** in the docs — confirm against a running instance. Treat Pi as a standard alt-screen TUI (forward SIGWINCH + resize-nudge on reattach) until proven otherwise.

## 12. Background / headless invocation

- **Non-interactive invocation** — **Yes, strong support:**
  - `pi -p "<prompt>"` / `--print` — print the final response and exit (text). stdin is merged into the prompt; `@file` attaches files/images.
  - `pi --mode json "<prompt>"` — one-shot, emits the full event stream as JSON lines (the `session` header line first; final text from the `message_end` AgentMessage), then terminates.
  - `pi --mode rpc` — long-lived JSONL-over-stdin/stdout for continuous programmatic control.
  - `pi --export <in> [out]` — export a session (HTML).
  - A tight one-shot recipe: `pi --print --no-session --no-tools --no-extensions --no-skills --no-context-files --mode text --model <id> [--thinking <level>]` with the prompt on **stdin** — minimal, no side effects, deterministic.
- **Orchestrator uses** — commit messages, PR title/body, branch names, summaries (via `-p`/`--print`), and **model discovery** via `pi --list-models`. `--mode json` + `jq` cleanly extracts the final message (split on `\n`; see the RPC parsing quirk below).
- **Auth path for headless** — Same `auth.json` + env precedence as interactive (§4); resolve `PI_CODING_AGENT_DIR` to the user's real config root so the headless CLI sees the user's auth. Non-interactive trust uses `defaultProjectTrust` — set `always` or pass `--approve` so trust does not block. No key injection.
- **Cost / latency / timeout / output caps** — Pick a cheap/fast model + `--thinking off/minimal`; `--no-session` for throwaway runs; `--no-tools`/`--tools read` to restrict; `PI_OFFLINE`/`PI_SKIP_VERSION_CHECK` to cut network. Token/cost reported in `usage`. Timeouts are the orchestrator's responsibility. Local execution (no remote service). **Quirk:** `--list-models` output may land on **stderr** — re-parse stderr when stdout is empty.

**Conflicts / open questions:** none. The headless path is well-supported; the only gotchas are the stderr `--list-models` quirk and the JSONL `\n`-only parsing rule (§13).

## 13. Capabilities & quirks matrix

| Capability | Pi |
|---|---|
| Resumable | **Yes** — `-c/--continue`, `-r/--resume`, `--session <path\|id>` (partial id ok), `--fork`, `--no-session`; in-session `/resume`, `/fork`, `/clone` |
| Reattach to live PTY | **Orchestrator-owned** — no agent-native reattach; multiplexer + resize-nudge, or resume the JSONL |
| Hooks / instrumentation | **Yes** — in-process **TypeScript extensions** (`pi.on(...)`); **no settings.json shell-hook surface**; or consume `--mode rpc`/`--mode json` directly |
| Hook transport | **Bring-your-own** — extension opens its own side-channel (fetch/file/socket); **no built-in port/token callback**; design fail-open |
| Draft prefill (in) | **Extension only** — `ctx.ui.setEditorText()` / `pasteToEditor()`; **no CLI flag/env**; PTY paste unreliable (startup-banner resets paste-ready timer) |
| Draft read (out) | **Extension or screen-scrape only** — not in RPC `get_state` |
| Trust preset | **Yes** — `trust.json`, `defaultProjectTrust:ask\|always\|never`, `--approve`/`--no-approve`, `project_trust` event |
| Interactive-prompt selection | **Yes** — arrow/Enter overlays (PTY); extension dialogs (`ctx.ui.select/confirm/input`); **option set not readable over RPC** |
| Title source | **JSONL `session_info.name`** (`/name`, `-n`, RPC `sessionName`, `setSessionName`); **no native OSC/LLM auto-title**; optional extension OSC title for live pane |
| Transcript format | **JSONL tree** (`id`/`parentId`), version 3, one file per session, filed by cwd |
| Headless | **Yes** — `-p/--print`, `--mode json`, `--mode rpc`, `--export` |
| Model listing | **Yes** — `pi --list-models` (**may print to stderr**); `~/.pi/agent/models.json`; SDK `ModelRegistry` |
| Usage / quota (rate-limit window) | **No** quota/reset-window surface; **Yes** token + cost accounting (`usage`, `/session`, footer) |
| Fast mode | **No explicit flag** — use `--thinking off/minimal` + a cheaper model |
| Reasoning effort | **Yes** — `--thinking off\|minimal\|low\|medium\|high\|xhigh`, `Shift+Tab`, `:thinking` model suffix |
| Model/reasoning switch mid-session | **Yes** — RPC `set_model`/thinking setters; `/model`, `Ctrl+L`, `Ctrl+P`, `Shift+Tab`; SDK `setModel`/`setThinkingLevel` |
| Multi-provider | **Yes** — many providers; OAuth for Claude Pro/Max, ChatGPT/Codex, GitHub Copilot |
| Images / attachments | **Yes** — `@file`, `Ctrl+V`, RPC `images[]` |
| YOLO / sandbox flag | **None single flag** — `--approve` + broad `--tools`; containerization via extension/Docker |
| Structured live control | **Yes** — `--mode rpc` (send/abort/state/title/usage) + `--mode json` event stream |

**Known special-cases / workarounds:**
- **Word-boundary classifier** — match `pi` on a word boundary so `pip`/`mpi`/`python`/`comp`/`pomp` don't false-match; default a bare/empty command to `pi`.
- **Enter is contextual** — idle→submit, busy→**queue steering**, `Alt+Enter`→follow-up. "Send" semantics must track busy/idle; prefer RPC `streamingBehavior` when scripting.
- **tmux strips modifiers** — enable `extended-keys on` + `extended-keys-format csi-u` (tmux 3.5+) or `Shift`/`Ctrl`/`Alt+Enter` collapse to plain Enter/Tab.
- **Auth precedence** — `auth.json` beats env; **no auto env-strip** — unset provider env vars to force OAuth/stored creds.
- **RPC/JSON is `\n`-only JSONL** — do **not** use Node `readline` (it also splits on U+2028/U+2029, valid inside JSON strings); split on `\n` and strip a trailing `\r`.
- **Sessions are trees, not lists** — forks/branches share a file; walk the active leaf via `id`/`parentId`.
- **Hooks are in-process TS** — no port/token callback; bring your own side-channel inside the extension (and re-read an on-disk endpoint file each event for restart resilience), or just consume `--mode json/rpc`.
- **`--list-models` may emit on stderr** — parse stdout **and** stderr.
- **Startup banner defeats post-ready paste** — Pi's multi-second skills/extensions/context load resets the bracketed-paste quiet-timer; use the extension `setEditorText` path for initial drafts.
- **One writer per session id** — never run a TUI and an RPC process (or two TUIs) against the same JSONL; use `--fork`/`--no-session` to branch.

## 14. Failure, exit & recovery

- **Crash/exit detection** — Process exit code (non-zero = abnormal) via the PTY host's `onExit`. Within a turn, distinguish error/abort *without* relying on the exit code via `done.reason` (`error|aborted`) and message `stopReason` (`error|aborted|length|stop|toolUse`) in RPC/JSON/JSONL — so "clean completion" (`stop`) is distinguishable from an in-turn error. `auto_retry_start`/`_end` show provider-error retries; `extension_error` shows extension load/handler failures.
  - Established: `done.reason`/`stopReason` from the event stream (in-turn) + exit code (process). **Fallback (bare PTY):** exit code + output activity only — cannot distinguish in-turn error from clean done.
- **Reattach-after-restart healing** — No agent-native healing. The orchestrator detects an exited-but-alive multiplexer pane, reaps orphans, and either reattaches (still-running, + resize-nudge) or resumes the JSONL (`--session <id>`). Because the JSONL is append-only/tree, a crash mid-turn leaves a recoverable partial; resume continues from the active leaf. An extension status channel should re-read its endpoint coordinate on each event so callbacks survive an orchestrator restart.
- **Error surfacing** — Surface RPC `response{success:false,error}`, `done{reason:"error"}`, message `stopReason:"error"`, `auto_retry_*`, `extension_error`, and a non-zero exit code. In the TUI, errors render inline; the footer shows model/usage. **Pi has no dedicated permission-denied/error OSC signal** — error state must come from the event stream/exit, not from screen-scraping (UNVERIFIED whether anything error-specific appears in the title).

**Conflicts / open questions:** a bare-PTY integration (no structured mode/extension) cannot cleanly separate in-turn error from clean completion — run `--mode rpc`/`--mode json` or an extension where that distinction matters.

## 15. Remote / transport

- **Supported transports** — **Local exec (primary), SSH-to-remote-worktree, and daemon-subprocess PTY hosting** — Pi is a normal CLI, so all three work the way any PTY-hosted agent does. Termux (Android) and Windows are explicitly documented (`termux.md`, `windows.md`).
- **Forwarding PTY/git/fs + instrumentation over the relay** — PTY bytes relay as for any TUI; git/fs ops run wherever `pi` runs (the remote host for SSH). **For instrumentation over a relay, prefer `--mode rpc`/`--mode json`** (a structured stream over the same channel) rather than the in-process extension HTTP-callback pattern — there is **no built-in port/token callback to forward**. If you do use an extension for state, it runs on the remote host and must reach the orchestrator **from there** (loopback to a relayed listener, or a file the relay reads). Keyboard fidelity over the relay needs the tmux `extended-keys` / terminal keyboard-protocol setup so modifier keys (`Shift+Enter`, `Alt+Enter`, `Shift+Tab`, `Shift+Ctrl+P`) survive the hop.
- **Agent-specific remote limitations** — **No native multi-machine session sync** — the session JSONL lives on whichever host ran `pi` (under that host's `~/.pi/agent/sessions/`). `/share` (GitHub gist) and `/export` (HTML) are the only cross-host sharing primitives. Any remote-specific bugs are **UNVERIFIED**.

**Conflicts / open questions:** for remote instrumentation, the structured RPC/JSON stream is strongly preferred over an extension side-channel (no port/token forwarding to wire up). Remote-specific quirks are unverified.

---

## Open questions / unverified

- **Live-running confirmation:** the `pi` binary was not run on the research host (not installed; no `~/.pi`), so `--help`/`--version` exact output, on-disk file contents, and any flag's runtime behavior are sourced from docs/README/source, not from execution. Confirm against a live install.
- **Version gating:** no evidence any flag/feature is version-gated; unverified whether any is.
- **Session-file locking:** unverified whether Pi takes a lock to prevent concurrent-writer corruption — treat "one writer per session id" as a hard invariant regardless.
- **OAuth internals:** exact `auth.json` OAuth field names and per-provider refresh endpoints/client-ids are undocumented (Pi-internal auto-refresh; orchestrator does not touch them).
- **Menu/option enumeration:** whether a clean machine-readable option list for interactive prompts exists outside extensions (RPC does not return menu contents) is unverified.
- **Sub-agent state:** per-subagent identity/channel inheritance within the parent event stream is unverified.
- **Terminal internals:** alt-screen usage, exact mouse-mode, and Pi-specific redraw quirks are undocumented — confirm against a running instance.
- **Title eventing:** no documented title-changed event — poll `get_state` / re-read the JSONL.
- **Error in OSC title:** whether any error-specific signal appears in a title sequence is unverified (error state should come from the event stream/exit).
- **Remote bugs:** any remote/SSH-specific bugs are unverified.
