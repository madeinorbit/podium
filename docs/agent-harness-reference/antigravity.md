# Antigravity — orchestrator integration reference

Authoritative integration reference for hosting Google's **Antigravity CLI** inside a remote/web/mobile multi-agent orchestrator. Binary name: **`agy`**. A Go single-binary interactive TUI (BubbleTea-style alt-screen), successor to / sharing the agent core with the Antigravity 2.0 desktop IDE, introduced ~Google I/O 2026. Homepage / docs: `https://antigravity.google` (`/docs/cli-overview`, `/cli/install.sh`). It carries a Gemini-CLI lineage: its config root lives **inside** the shared `~/.gemini` namespace (subdir `~/.gemini/antigravity-cli/`) and its global hooks live in `~/.gemini/config/hooks.json` — do **not** conflate an Antigravity install with a Gemini-CLI install.

> **Version caveat.** Antigravity moves fast and several documented surfaces are not yet implemented. Notably `--output-format json` is *documented but errors* (`flags provided but not defined: -output-format`), and an ACP / JSON-RPC stdio mode is requested but unimplemented. **Capability-probe / version-gate rather than assume a flag exists.** On-disk paths and flag spellings below are drawn from official docs, community tutorials/cheatsheets, and real orchestrator integrations driving `agy`; where a fact has not been confirmed against a live `agy --help` it is marked **(unverified)**. The binary is not assumed present on the host — detect first. Default config root is `~/.gemini/antigravity-cli/`.

---

## 1. Discovery & identity

- **Binary detection / "installed?":** Binary is `agy` on PATH. Installed via `curl -fsSL https://antigravity.google/cli/install.sh | bash` (macOS/Linux) or PowerShell `irm .../install.ps1 | iex`; the installer accepts `--skip-aliases`, `--skip-path`, `--dir` to control PATH/alias setup. **"Installed?"** = `which agy` resolves on PATH; a secondary corroborating signal is the presence of the config root `~/.gemini/antigravity-cli/`. There are no known aliases or renames. Process-table identity is the bare token `agy`, matched on a word boundary (it is unsafe as a substring — e.g. regex `/(?<![\w./\\-])agy(?![\w./\\-])/i`). *(established method)*
- **Version detection / gating:** `agy --version` exists *(established method)*; exact output format is **(unverified)** and may be thin on current builds. **Version/capability gating is required**, not optional: `--output-format json` errors today, and ACP/JSON-RPC stdio is unimplemented. Treat documented-but-missing flags as capability probes (run the flag, detect the `flags provided but not defined` error, fall back). *(established method: probe; behavior gating mandatory)*
- **Existing-session discovery (paths/globs):** Sessions are discoverable on disk under the config root (`<appDataDir>` = `~/.gemini/antigravity-cli` on macOS/Linux):
  - `~/.gemini/antigravity-cli/history.jsonl` — index of all conversations; enumerate sessions here. *(established method)*
  - `~/.gemini/antigravity-cli/conversations/` — per-conversation store, reported as **protobuf** (opaque — do **not** parse or hand-edit). *(fallback — read JSONL instead)*
  - `~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` (truncated) and `transcript_full.jsonl` (full). **Glob:** `~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript*.jsonl`. *(established method)*
  - `~/.gemini/antigravity-cli/brain/<id>/scratch/` — temp + per-conversation artifacts `implementation_plan.md`, `task.md`, `walkthrough.md`. *(established method)*
  - **Conflicts / open questions:** A startup filesystem scan keyed only on the runtime hook-reported `transcriptPath` (i.e. discovering sessions purely *at runtime* via the hook payload, with no boot-time scan) is one viable integration style, but the verifiable disk layout above is the stronger discovery surface — prefer scanning `history.jsonl` + the `brain/*` glob at startup, and use the hook `transcriptPath` (§8/§10) for the *live* per-session path. The exact field name for the workspace mapping inside the protobuf conversation file is unverified.
- **Stable session identity:** A **conversation UUID** (e.g. `3b4a1d20-3968-4ed2-90b3-00eea3060b02`). Sources: (a) at interactive **quit** the CLI prints `Resume: agy --conversation=<id> (or -c)`; (b) the `brain/<id>/` directory name; (c) the `history.jsonl` index; (d) at runtime the hook payload field **`conversationId`** (this is the only id source for an integration that does not scan disk). This is the resume key (`{ key: 'conversation_id', id }` from `conversationId`). There is **no OSC-emitted id** and no headless emission of the id (see hazard below). *(established method)*
  - **Headless gap:** `agy --print` does **not** emit the conversation UUID it created (open feature request). A headless caller cannot reliably learn the UUID it just minted except by **diffing `brain/` / `history.jsonl` before vs after** the run — a real hazard for resume-after-headless. *(fallback)*
- **Session ↔ repo/worktree/cwd mapping:** A conversation records `workspacePaths` (active workspace dirs), exposed in hook payloads and `agy inspect`. Workspace dirs are set at launch (cwd + repeatable `--add-dir <dir>`) or in-session via `/add-dir`; `trustedWorkspaces` in `settings.json` ties paths to trust state. Reverse map (repo→sessions) = scan `history.jsonl` / transcripts for `workspacePaths`. For an orchestrator-launched pane, the simplest binding is the generic per-pane launch cwd plus orchestrator-owned pane/tab/worktree ids carried through the hook env (§8), so each hook event maps back to the pane that launched it. *(established method; cwd-derived)*

## 2. Launch & process model

- **Spawn mechanism / PTY host:** `agy` is an interactive full-screen TUI — host it in a **PTY** (local / remote-SSH / daemon-subprocess). Interactive sessions require a real PTY (`pty=true`, typically under tmux). For headless one-shot use `agy --print`/`-p` (no TUI; but see the non-TTY bug in §12). The CLI is explicitly "optimized for remote SSH sessions with minimal resource overhead." *(established method)*
- **Full launch command / args / env:** Interactive base = bare `agy`. Common args: `-m/--model "<name>"`, `--add-dir <dir>` (repeatable), `--dangerously-skip-permissions`, `--sandbox`, `--log-file <path>`, `--print-timeout <dur>` (default `5m0s`), `-c/--continue`, `--conversation <id>`, `-p/--print/--prompt`, `-i/--prompt-interactive`. **Auth env Antigravity reads:** `GEMINI_API_KEY` (AI Studio key) and/or `ANTIGRAVITY_API_KEY`. **Orchestrator instrumentation env** (hook port/token/endpoint, pane/tab/worktree ids) is injected here and consumed by the hook script (§8). *(established method)*
  - **Critical env-sanitization gotcha:** Antigravity **sanitizes the child/hook environment to a whitelist** — arbitrary custom env vars are **not** forwarded to hook subprocesses. An orchestrator therefore **cannot** rely on passing config/feature-flags to hooks via env (a disable-via-env switch silently fails). Pass hook config via **files / socket existence**, not env. *(established constraint)*
  - **Conflicts / open questions:** No API-key stripping is performed by default in some integrations; whether to strip inherited `GEMINI_API_KEY` / `ANTIGRAVITY_API_KEY` depends on whether you want CLI-stored OAuth (strip) or forced key-auth (inject) — see §4. Which inherited keys are honored vs stripped by `agy` itself is unverified.
- **Durable survival backing:** No built-in daemon/multiplexer — wrap the PTY in external **tmux/abduco** for live-turn survival across detach/restart. Conversation *state* persists independently on disk (resume by UUID), so history is recoverable even without a multiplexer; only a live in-progress turn dies with the PTY. *(established method = external mux; generic)*
- **Initial-prompt injection mode:** Three modes:
  1. **`flag-interactive` (preferred for "seed first turn + keep TUI"):** `agy -i "<prompt>"` / `agy --prompt-interactive "<prompt>"` — runs the initial prompt then stays interactive. Carried as a single shell-quoted argv token (POSIX single-quote), not typed/bracketed-paste, not a one-shot. *(established method, authoritative for normal launch)*
  2. **`flag-prompt` headless:** `agy -p "<prompt>"` / `--print "<prompt>"` / `--prompt "<prompt>"` — one-shot, prints, exits (§12). *(established method, headless only)*
  3. **type-after-ready:** type into the PTY composer + submit (Enter); bracketed paste for large/multi-line (generic). Whether `agy` advertises bracketed paste is **(unverified)** — treat as generic. *(fallback)*
- **First-run / trust handling:** First launch performs Google sign-in (local browser; on remote/SSH it prints an auth URL). Workspace **trust** is tracked via `trustedWorkspaces` in `settings.json` — **pre-seed `trustedWorkspaces` (and `permissions`) before launch** so the first prompt isn't eaten by a trust menu. `--dangerously-skip-permissions` also bypasses prompts entirely. A passive terminal-tail "ready prompt" detector (recognizing the `antigravity cli` banner header + a model line + the `>` composer prompt) can clear stale startup-modal "blocked" signals on reattach, but is not a substitute for pre-seeding trust. *(established method = pre-seed config + skip flag; ready-prompt detector = fallback reconciliation)*
- **Permission / YOLO / sandbox modes:** Four permission presets: `request-review`, `always-proceed`, `strict`, `proceed-in-sandbox`. **YOLO** = `agy --dangerously-skip-permissions` (skips all tool-authorization confirmations) — a sensible default launch arg. **Sandbox** = `agy --sandbox` and/or `enableTerminalSandbox: true` in `settings.json`. Fine-grained `permissions.allow` / `permissions.deny` arrays in `settings.json`; in-session `/permissions` editor. *(established method)*
- **Model / reasoning-effort / fast-mode at launch:** **Model:** `agy -m "<name>"` / `--model "<name>"` (e.g. `--model "Gemini 3.5 Flash (Low)"`); default model from `settings.json` `model` key. **Reasoning effort is baked into the model label** (`(Low)`/`(Medium)`/`(High)`/`(Thinking)`), not a separate flag. **Fast mode:** a real concept — in-session `/fast` toggles "fast mode for quick actions"; a launch flag for fast mode is **(unverified)**. *(established method)*
  - **Conflicts / open questions:** Whether `--model` is meaningfully wired into the *interactive* launch (vs only used by headless one-shot model selection) — the verifiable flag exists for both; default-model-from-settings is the safer interactive path. A launch-time fast-mode flag is unconfirmed.

## 3. Resume & reattach

- **Resume support / flags / id source:** Yes. **By explicit UUID (preferred):** `agy --conversation <id>`. **Most-recent:** `agy --continue` / `-c`. The id comes from the exit message `Resume: agy --conversation=<id>`, `history.jsonl`, the `brain/<id>/` dir, or the cached hook `conversationId`. Resume argv only fires when the cached provider session key is `conversation_id`. *(established method)*
  - **`--continue` hazard — never use it in a multi-instance orchestrator:** `-c`/`--continue` resumes the *most recent* conversation and **cross-contaminates between concurrent wrappers** (it is unusable for multi-instance integrations). **Always resume by explicit UUID.** *(established constraint)*
  - **Conflicts / open questions:** `-c` is overloaded across sources between `--continue` and `--conversation`; the unambiguous form is `--conversation=<id>` as printed by the exit message — prefer it.
- **State restored vs lost on resume:** Restored by `agy` from the transcript/protobuf store: full conversation history, `workspacePaths`, and artifacts (`task.md`, `implementation_plan.md`, `walkthrough.md`). Model/permissions are taken from current `settings.json`/flags at resume time, **not necessarily the original session's** (whether per-conversation model is persisted/restored is **unverified**). By default the CLI "forgets everything between sessions" except the explicitly-resumed conversation (semantic cross-session memory needs an external MCP such as Mem0). The orchestrator restores nothing extra and does not re-pass model/permissions unless it chooses to. *(established method)*
- **Reattach to a running PTY after restart:** **No native PTY reattach** — this is the orchestrator's job. Wrap the PTY in tmux/abduco (or a daemon-held PTY) and reattach; because the TUI is alt-screen BubbleTea it repaints on resize, so issue a **redraw nudge** (SIGWINCH / resize ±1) after reattach. The ready-prompt detector (§2/§11) helps reconcile a retained terminal tail by locating the live `>` composer past stale startup modals. If the PTY died, **cold-resume** via `agy --conversation=<id>` (loses the in-flight turn). *(established method = generic mux + SIGWINCH + ready-prompt reconcile)*
- **Idempotency / race hazards:** (a) Headless `--print` does not emit the UUID → reattach target unknown; mitigate by snapshotting `brain/`/`history.jsonl` before launch. (b) `--continue` racing across instances → always use UUIDs. (c) `conversations/` is protobuf → never hand-edit. (d) The shared `~/.gemini` root means multiple agents write the same `history.jsonl` → guard against concurrent-write races on the index. (e) Status-pipeline de-dup: a post-`Stop` bookkeeping `PostToolUse` carrying the same `transcriptPath` should be dropped so a finished session doesn't flip back to "working" (cache completed-transcript-by-pane). *(guard rules)*

## 4. Auth & subscription

- **Credential locations:** Primary = **OS secure keyring** (tried first), with browser Google sign-in fallback. On keyring-less environments (e.g. WSL) token storage is **file-based** under the config root `~/.gemini/antigravity-cli/` (exact filename **unverified**). Env-var creds: `GEMINI_API_KEY`, `ANTIGRAVITY_API_KEY`. Note: a **Google AI Pro/Ultra subscription** lets `agy` consume Claude (Sonnet/Opus 4.6) and GPT-OSS tokens via Google's billing (single bill). *(established method)*
- **Reuse model:** Default = **spawn-and-let-CLI-auth** (keyring/OAuth) — the orchestrator does not read/manage credentials. For multi-account/headless, the cleaner path is **env-var API keys per spawn** (`GEMINI_API_KEY` / `ANTIGRAVITY_API_KEY`). There is no orchestrator-managed capture/store/switch module assumed. *(spawn-and-let-CLI-auth = established; env-key injection = established fallback for headless/CI)*
- **Token refresh:** Handled internally by the CLI against Google's OAuth/Antigravity endpoints (keyring write-back). API-key auth avoids refresh entirely. Endpoint/client-id **unverified**. The orchestrator does not refresh tokens. *(CLI-owned)*
- **Env hygiene:** To force the CLI's own OAuth creds, do not inject conflicting keys; to force key-auth in CI, inject `GEMINI_API_KEY` (guard with `: "${GEMINI_API_KEY:?required}"`). Remember the env-whitelist for hook children (§2) — env-based config does not reach hooks. Which inherited keys `agy` strips vs honors is **unverified**. *(established method)*
- **Multi-account support:** No documented first-class multi-account switch. Practical isolation = a separate `HOME` / config-root per account (point each spawn at a distinct `~/.gemini` via `HOME` override) and/or distinct API keys. `/logout` (and `agy logout`) clears the current saved credentials. Whether a config-dir env override is honored is **unverified**. *(fallback)*

## 5. Models, usage & accounting

- **Model listing for a settings UI:** `agy models` subcommand lists available models *(established method)*; in-session `/model` shows/sets. **Parse:** each non-empty stdout line is one model id (id == label; no `id - label` split observed). Output format (table vs lines) is **(unverified)**; no `--json` confirmed. Known set (~8 models, effort embedded in the label): **Gemini 3.5 Flash (Low/Medium/High)**, **Gemini 3.1 Pro (Low/High)**, **Claude Sonnet 4.6 (Thinking)**, **Claude Opus 4.6 (Thinking)**, **GPT-OSS 120B (Medium)**. Static fallback default: `Gemini 3.5 Flash (Medium)`. *(established method = `agy models`; static list = fallback)*
- **Runtime model / effort / fast switching mid-session:** Yes — `/model [name]` switches model live; `/fast` toggles fast mode live; reasoning effort = pick a different labeled variant. No separate mid-session reasoning-effort dial beyond model choice. There is no flag/env/IPC to switch model purely programmatically mid-session — drive it by typing the slash command into the PTY. *(established method via slash command; no structured switch)*
- **Usage windows / quota / rate-limits:** In-session `/usage` (quota/rate-limit) and `/context` (token usage + checkpoints) in the TUI. **Programmatic quota read (best path):** community status-line tools (`agy-hud`, `antigravity-statusline`) find the local Antigravity **`language_server` process, extract its CSRF token from its command line, discover its listening port, and call `GetUserStatus`** → quota by active-model label + reset countdown, refreshing ~30s. This is an **undocumented local RPC** but the only known machine-readable quota route. A `statusLine` config key (`settings.json`) + `/statusline` customizes the bar. **Caveat:** heavy fixed system-prompt overhead (~23–25k tokens/request) + aggressive ~5-hour rate windows on Pro → quota burns fast; surface it. *(established for TUI `/usage`; `GetUserStatus` RPC = single-source fallback)*
- **Token accounting for analytics:** Per-turn/session counts visible via `/context` and `/usage` and via the `GetUserStatus` RPC. On disk, `transcript_full.jsonl` carries exact tool results/text; whether it includes per-step input/output/cache/reasoning token counts is **unverified** (observed schema fields are `step_index/source/type/status/content/tool_calls`, no explicit token fields). Hook payloads do not carry token counts. For reliable accounting prefer the `GetUserStatus` RPC. *(fallback; not from transcript/hooks)*
- **Pricing / cost:** **Not supported** — the CLI does not compute/expose cost (subscription-metered for bundled providers); no pricing file shipped. Cost analytics must be derived externally from token counts × your own rate table. *(not supported natively)*

## 6. Driving & input — two-way control

- **Send a new user message mid-session:** Type into the TUI composer and press **Enter** (submit). Transport = write bytes to the PTY; for multi-line build the message with `Shift+Enter` / `Ctrl+J` / `Alt+Enter` (newline) then a final Enter. Bracketed paste likely works for large/multi-line content but advertisement is **(unverified)** — treat as generic. (`--prompt-interactive` is launch-only; mid-session follow-ups are the generic PTY-typing path.) *(established method = generic PTY typing/CR)*
- **Read the agent's current input-box contents (draft sync out):** **No structured channel.** Only **screen scrape** of the composer line — find the `>` prompt in the banner region and read it, using dim-placeholder detection (read screen, drop dim cells) to distinguish placeholder from real draft. *(not supported structurally; screen-scrape fallback)*
- **Pre-fill / set the input box (draft sync in):** **No native live-composer prefill** (no `draftPromptFlag` / `draftPromptEnvVar`). Closest is `--prompt-interactive` / `-i` to seed the *first* turn only; after that, typed/bracketed-paste into the PTY after a ready signal (generic `render-quiet-after-bracketed-paste`). *(not supported as flag/env; falls back to generic paste-after-ready)*
- **Answer interactive prompts / permission menus:** Detection is strong; selection is not automated. **Detection:** a `PreToolUse` hook whose `toolCall.name` is `ask_question` or `ask_permission` is an authoritative out-of-band "waiting-on-user" signal; a subagent "awaiting confirmation" shows in `/agents`. **Selection:** arrow keys + Enter, or number keys (generic TUI); `Alt+J` cycles to the next subagent awaiting confirmation. The actual *set of options* is **not** read programmatically — read it from the hook `toolCall` payload or by screen-scrape; the user (or the orchestrator forwarding keys) answers in the live PTY. *(detection = established via hooks; selection = generic key forwarding, not auto-driven)*
- **Interrupt / cancel / escape:** `Ctrl+C` = cancel/interrupt the current turn; `Esc` = escape/dismiss; `Ctrl+D` (×2, or `/quit`) = exit. `Ctrl+C` / `Ctrl+D` / `Enter` are **system-protected, non-rebindable**. Generic interrupt intent = plain-escape or Ctrl-C with a short settle window. *(established method)*
- **Slash commands the orchestrator can issue (type into PTY):** `/help`, `/config` (`/settings`), `/model [name]`, `/fast`, `/usage`, `/context`, `/permissions`, `/agents` (subagent manager), `/tasks` (background shell logs), `/mcp`, `/hooks`, `/skills`, `/planning`, `/resume` (`/switch`), `/clear`, `/rewind` (`/undo`), `/fork`, `/rename <name>`, `/diff`, `/add-dir <path>`, `/title [on/off]`, `/keybindings`, `/artifact`, `/export` (push session to Antigravity 2.0 GUI), `/btw <query>`, `/logout`, `/quit` (`/exit`). *(established method)*
- **Attachments / large paste:** File refs via `@path`-style references and `--add-dir` for whole dirs. Pasted images — desktop supports them; CLI image-paste handling is **(unverified)**. Large content = bracketed paste into the PTY (generic). *(established for file refs; image paste unverified)*
- **Important keyboard shortcuts & modifier keys (for mobile soft-keyboard surfacing):**

  | Action | Keys |
  |---|---|
  | Submit | `Enter` |
  | Newline | `Shift+Enter`, `Ctrl+J`, **`Alt+Enter`** |
  | Cancel / interrupt | `Ctrl+C` |
  | Escape / dismiss | `Esc` |
  | Exit CLI | `Ctrl+D` (×2) |
  | Clear screen | `Ctrl+L` |
  | History nav | `Up` / `Down` |
  | Scroll | `PgUp`/`PgDn`, `Shift+Up`/`Shift+Down` |
  | Accept autofill | `Tab` |
  | Shell-mode toggle | `!` (then `!` or `Esc` to exit) |
  | Next subagent awaiting confirm | **`Alt+J`** |
  | Open external editor | `Ctrl+G` |

  **Modifier fidelity:** `Alt+Enter` (newline) and `Alt+J` (next subagent confirm) need **Alt/Option/Meta fidelity** — surface a dedicated Alt key on mobile, plus `Shift+Enter` / `Ctrl+J` as newline alternatives. Keybindings are user-editable (`/keybindings` → `~/.gemini/antigravity-cli/keybindings.json`), e.g. `"prompt.insert_newline": ["shift+enter","ctrl+j"]`, `"cli.clear_screen": ["ctrl+l"]`, `"edit.open_editor": ["ctrl+g"]`; `cli.exit` / `cli.enter` are protected. *(established method)*

## 7. Agent-state classification

- **State vocabulary:** Map into `working | waiting | done` (+ `error` / `interrupted`). Note that a hooks-driven normalizer in practice emits only `working`, `waiting`, `done` (no native `blocked` / `interrupted` event) — `error` and `interrupted` come from process/PTY signals, not hooks. Subagents add sub-states ("active", "completed", "awaiting confirmation") exposed via `/agents`. *(established method)*
- **Signal sources & authority rank (best → weakest):**
  1. **Hooks (authoritative).** Drive state directly (§8). *(established)*
  2. **Transcript tail.** `transcript.jsonl` step `type`/`status` + presence of pending `tool_calls`. *(established)*
  3. **Subagent panel** via `/agents` (scrape) / `agy inspect`. *(fallback)*
  4. **Process foreground / output activity** (generic) — busy spinner / output flux ⇒ working; quiescent + `>` composer ⇒ idle/waiting. *(fallback)*
  5. **Process exit** — clean vs crash (§14). *(fallback)*
  - **OSC:** `agy` emits a **terminal-window-title OSC** (toggle `/title [on/off]`), parseable for coarse title/state, but there is **no OSC JSON status channel**. Title-string contents are **(unverified)**. *(fallback for title only)*
- **Event → state mapping (hooks):**
  - `SessionStart` → working / idle-ready.
  - `PreInvocation` → `working`. Also the **new-turn boundary** (clears the completed-transcript cache).
  - `PostInvocation` → `working`.
  - `PreToolUse` → `working`, **unless** `toolCall.name ∈ {ask_question, ask_permission}` → `waiting` (needs-user).
  - `PostToolUse` → `working`.
  - `Stop` → `done`, **unless** `fullyIdle === false` (or `fully_idle === false`) → `working` (mid-turn Stop, **not** terminal).
  - Hook returns `deny` / non-zero unexpectedly → error/blocked; `Ctrl+C` → interrupted.
  - Any other event → ignore.
  - **Conflicts / open questions:** Whether `PreToolUse` is *installed* as a managed hook varies by integration philosophy — Antigravity uses `PreToolUse` for tool-permission *decisions*, so an observational integration may deliberately **omit installing `PreToolUse`** (to avoid altering the user's permission policy) and rely on `PreInvocation`/`PostInvocation`/`Stop`/`PostToolUse`; a state-detection-maximizing integration **does** install `PreToolUse` (read-only, returning a passive allow) precisely to catch the `ask_question`/`ask_permission` waiting signal. **Recommended:** install `PreToolUse` only if your hook strictly fails-open / returns `{}` (passive) so it never changes permission behavior — that buys the authoritative "waiting" signal. The `ask_question`/`ask_permission` waiting signal is reachable either way (a gated tool also stalls and shows in `/agents`).
- **"Stopped but needs user" vs "done":** (a) `PreToolUse` with `ask_question`/`ask_permission` → `waiting`; (b) a subagent "awaiting confirmation" in `/agents`; (c) a `Stop` with `fullyIdle:false` stays `working`. A truly idle `Stop` (`fullyIdle:true`) is `done` and should record `transcriptPath` into the completed-transcript cache. Without hooks you must scrape the permission menu. *(established method)*
- **Reconciliation / dedup / stickiness:** Prefer hook events; resolve conflicts **hook > transcript > output-activity**. Drop a same-`transcriptPath` `PostToolUse` arriving after `Stop` (completed-transcript cache) so a finished session doesn't bounce done→working. Debounce transcript-tail / output-activity with a quiet window (~300–800 ms). Make `Stop` sticky until the next user input. Prompt-cache the transcript read per hook to avoid re-reading. *(guard rules)*
- **Sub-agent / nested-task state & identity:** Subagents are first-class (parallel/async), each with its own status/step in `/agents`, its own `brain` artifacts, and `Alt+J` to cycle those awaiting confirmation. Parent-UUID ↔ child-subagent on-disk identity link is **unverified**; generic `toolAgentId`/`toolAgentType` fields are not populated by hooks. *(partial; identity link unverified)*
- **Latency:** Hooks fire sub-second around tool calls (best-effort `curl`, e.g. `--connect-timeout 0.5 --max-time 1.5`); transcript tail ~fs-write speed; `GetUserStatus`/status-line ~30s. Debounce output-activity. *(established)*

## 8. Hooks & instrumentation install

- **Supported?** **Yes — first-class hooks**, the strongest instrumentation surface and the recommended authority for §7. Mechanism = managed **shell-command hooks** (POSIX `.sh` + Windows `.cmd` / inline PowerShell). *(established method)*
- **Install location / config:** Declared in **`hooks.json`** (NOT `settings.json`). Locations:
  - Global: **`~/.gemini/config/hooks.json`** (note: this is `~/.gemini/config/`, the Gemini hooks dir, *not* the per-conversation `~/.gemini/antigravity-cli/` root and *not* a Gemini-CLI settings file).
  - Workspace: `.agents/hooks.json` (likely requires the workspace to be trusted via `trustedWorkspaces`; a hash-allowlist trust step is **unverified**).
  - Or bundled in a **plugin** (`plugin.json` + optional `hooks.json` / `mcp_config.json` / `skills/` / `agents/` / `rules/`) under `~/.gemini/antigravity-cli/plugins/<name>/`, installed via `agy plugin install/enable/disable/list`.
  - Write managed hooks under a **named namespace/bundle key** (e.g. a `<orchestrator>-status` bundle) to avoid clobbering user hooks. The managed script itself can live in a shared agent-hooks dir (e.g. `<orchestrator-config>/agent-hooks/antigravity-hook.sh`). *(established method)*
- **Hook event taxonomy + payload fields:** Events: `SessionStart`, `PreInvocation`, `PostInvocation`, `PreToolUse`, `PostToolUse`, `Stop`, and Notification-style events. `PreToolUse`/`PostToolUse` accept a **`matcher`** regex (which tools trigger; `*` = all); `PreInvocation`/`PostInvocation`/`Stop` take a flat handler list (matcher ignored). **stdin payload (JSON) fields to extract:**
  - `conversationId` — resume id (§1).
  - `toolCall.{name,args}` — tool name + arguments (name drives the `ask_question`/`ask_permission` waiting signal; args feed clickable-item previews).
  - `transcriptPath` / `transcript_path` — **the exact JSONL transcript to tail for this session** (gold for an orchestrator).
  - `workspacePaths` — active workspace dirs.
  - `fullyIdle` / `fully_idle` — the mid-turn-Stop discriminator (§7).
  - User-request text via a `<USER_REQUEST>…</USER_REQUEST>` envelope; transcript line types `USER_EXPLICIT`/`USER` + `USER_INPUT`/`REQUEST`, assistant `PLANNER_RESPONSE` / `assistant.message`.
  - Full field list (e.g. an explicit `sessionId`, exact tool-name field) is **(unverified)** — match defensively. *(established method)*
- **stdout response (control JSON):** A `PreToolUse` hook gates the tool via `{ "decision": "allow" | "deny" }`. For passive/observational hooks return `{}` (empty object) or `{"decision":""}` / `{"decision":"allow"}` so the hook does **not** alter the user's tool-permission policy. *(established method)*
- **Transport back + fail-open:** The hook is an arbitrary shell command — transport is your choice; both are proven in real integrations:
  - **HTTP callback:** inject a port/token via the hook config file and POST the event form-encoded to `http://127.0.0.1:${HOOK_PORT}/hook/antigravity` with an auth header (e.g. `X-…-Hook-Token`), body fields `paneKey/tabId/worktreeId/env/version/payload`; route map `'/hook/antigravity' → 'antigravity'` on the listener; best-effort `curl --connect-timeout 0.5 --max-time 1.5 … || true`. *(established)*
  - **Unix-domain-socket IPC:** exec a small client (e.g. `<orchestrator> --socket '<path>.sock' hooks feed --source antigravity --event PreToolUse`). *(established)*
  - **FAIL-OPEN IS MANDATORY:** if the hook command exits non-zero / cannot reach the orchestrator, **Antigravity treats it as `deny` and blocks the tool call** (real bug: "Tool call denied by jsonhook__…_PreToolUse_…"). The hook MUST emit `{}` (or `{"decision":"allow"}`) and `exit 0` when the orchestrator is unreachable: missing port/token/pane id → `exit 0`; empty stdin → still POST `payload='{}'` so the event shows. Re-source the endpoint each invocation so a PTY that outlives an orchestrator restart reaches the new server. *(critical constraint)*
- **Lifecycle:** `install` / `remove` / `getStatus` (+ remote install over SFTP to `${home}/.gemini/config/hooks.json` and the script path). In-session `/hooks` views them, and `agy plugin enable/disable/list` for plugin-bundled hooks. **Idempotency:** strip prior managed commands from the bundle before re-writing; `getStatus` should report `installed`/`partial`/`not_installed`/`error` and detect stale managed commands. **Version-skew:** the event-name set may grow — match defensively; warn-once on a hook env/version mismatch. *(established method)*

## 9. Session titles

- **Source of truth (in priority):** (1) user/agent-set name via **`/rename <name>`**; (2) the **terminal-window-title OSC** the CLI emits (toggle `/title [on/off]`) — parseable for a tab name; (3) fallback **first-prompt truncation** — read the first `USER_INPUT` step's `content` from `transcript.jsonl` (or the hook-extracted `<USER_REQUEST>` body), truncate the first clause (e.g. ≤40 chars). No confirmed LLM-generated CLI title scheme (desktop names sessions; CLI is **unverified**). *(established method; `/rename` + OSC primary, first-prompt fallback)*
- **Read / update / eventing:** Read the OSC title from the PTY stream, or read the `/rename` value / first user step from the transcript; updates fire when the first prompt is captured. Update is user-driven (`/rename`); no programmatic set-title flag known. *(established/partial)*
- **Fallback / synthetic:** First-prompt regex/truncation; ultimate fallback = conversation UUID short form + the display name "Antigravity". *(fallback)*

## 10. Transcript & history

- **Storage:** Two layers. **(a) JSONL transcripts (use these)** per conversation: `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` (truncated) and `transcript_full.jsonl` (full, exact tool results/text). The live per-session path also arrives in the hook `transcriptPath` field (§8). **(b) Protobuf conversation store** `~/.gemini/antigravity-cli/conversations/`, indexed by `~/.gemini/antigravity-cli/history.jsonl` — **opaque; do not parse.** One transcript pair per session. *(established method = JSONL; protobuf = do-not-parse fallback index)*
- **JSONL schema (per step):** `step_index` (int, ordering/dedup key), `source` (e.g. `USER_EXPLICIT`, `USER`, `MODEL`), `type` (`USER_INPUT`, `REQUEST`, `CONVERSATION_HISTORY`, `PLANNER_RESPONSE`, `SEARCH_WEB`, …), `status` (`DONE`, …), `content` (text), `tool_calls` (array of `{ name, args }`). Example: `{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"What is Google Cloud Run?"}`. *(established method)*
- **Role mapping:**
  - **User:** `source: USER_EXPLICIT|USER` + `type: USER_INPUT|REQUEST`; `content` further **unwrapped from `<USER_REQUEST>…</USER_REQUEST>`** when present.
  - **Assistant:** `type: assistant.message` (content array → text), or `source: MODEL` + `type: PLANNER_RESPONSE` (string content), or generic role==assistant.
  - **Tool:** `tool_calls[]` + tool-result steps; preview via a shared tool-input-keys table.
  - Thinking/reasoning, diffs, errors → likely surfaced as step types / tool outputs / `status` fields; exact representation **(unverified)**.
- **Live tail vs historical read:** Two viable patterns:
  - **Continuous tail (preferred for chat-view):** fs-watch `transcript.jsonl`, new lines = new steps, order/dedup by `step_index`; use `transcript_full.jsonl` when untruncated tool output is needed. *(established method)*
  - **Historical-on-demand:** read the file tail in chunks (e.g. 64 KB up to ~4 MB) only on `Stop`/when needed to pull the last assistant message / last user prompt (used by integrations that don't maintain a continuous watcher). *(fallback)*
  - **Conflicts / open questions:** Whether to maintain a continuous watcher vs read-on-demand is an integration choice; a full chat-view reconstruction needs the continuous tail. Per-step token fields are unverified (§5).
- **Consumers:** chat-view → render `content` per role (filter internal types like `CONVERSATION_HISTORY`); last-message/preview → last step `content`; clickable items → `tool_calls[].args` (file refs/commands) + brain artifacts (`implementation_plan.md`, `task.md`, `walkthrough.md`) as clickable docs; state classification → `type`/`status`/pending `tool_calls` + the hook `fullyIdle`/`ask_*` signals.
- **Transcript ↔ terminal mapping:** The xterm TUI is the chat view; the transcript is the structured source. Reconcile by `step_index` ordering. Subagents write their own brain dirs/artifacts.
- **Special content types / quirks:** **Truncated vs full dual-log** (keep both paths). The **`<USER_REQUEST>` envelope** and the **`PLANNER_RESPONSE`** assistant variant are the headline shape quirks. **Mid-turn `Stop` with `fullyIdle:false`** is the key behavioral quirk (§7). Images/attachments in transcript = **(unverified)**. Protobuf `conversations/` opaque. *(established + quirks)*

## 11. Terminal rendering & display fidelity

- **PTY → xterm.js:** Standard Go full-screen TUI (alt-screen). Capture PTY bytes → stream → xterm.js (generic byte path; no agent-specific filtering required). Intercept the **OSC title** (for §9) and handle alt-screen chrome. Strip ANSI when capturing *headless* output (`sed -r 's/\x1B\[[0-9;]*[A-Za-z]//g'`). *(established = generic)*
- **Resize/reflow:** Send `SIGWINCH` on cols/rows change; the BubbleTea-style TUI repaints on resize. A redraw nudge (resize ±1 then back) helps after reattach. Mobile↔desktop breakpoint remount = generic. Replay-on-resize is **(unverified)**. *(established = generic)*
- **Scrollback model:** **Native TUI alt-screen** — the agent owns its history view; scroll keys (`PgUp`/`PgDn`, `Shift+Up`/`Down`) are handled inside the TUI, so scrolling agent history vs the composer is driven by sending those keys into the PTY, not by xterm scrollback. *(established = native alt-screen)*
- **Mouse forwarding:** The TUI likely enables mouse for scroll/menu select; forward scroll/click into the PTY when alt-screen mouse mode is on. Exact mouse-mode toggling **(unverified)**. *(generic)*
- **Snapshot/serialize for reattach:** Headless xterm + serialize (generic) to persist the last screen; on reattach render the snapshot then SIGWINCH so the live TUI repaints. No native snapshot. *(established = generic)*
- **Local cache for instant render then live reconnect:** No built-in mechanism. Persist the last serialized xterm buffer (generic) for instant paint, then reconnect the live PTY (tmux reattach) and reconcile by forcing a TUI redraw: **show cached buffer → attach → send SIGWINCH → let the alt-screen TUI overwrite** (minimal flicker if the redraw is prompt). *(established = generic)*
- **Composer/cursor:** The composer is a `>` prompt line; ready-for-input = prompt + idle. The ready-prompt detector locates the live `>` past the `antigravity cli` banner / stale startup modals (used for ready/blocked reconciliation, not for reading composer text). Reading composer state = dim-placeholder detection (read screen, drop dim cells). Draft paste uses the generic `render-quiet-after-bracketed-paste` ready signal. *(established = heuristic terminal-tail + generic paste signal)*
- **Color/theme/OSC quirks:** `colorScheme` (`light`/`dark`) in `settings.json` + `/config`; emits OSC title (toggle `/title`). No other agent-specific OSC quirks. *(established)*

## 12. Background / headless invocation

- **Non-interactive invocation:** **Yes** — `agy -p "<prompt>"` / `--print "<prompt>"` / `--prompt "<prompt>"` runs one prompt, prints, exits; `--print-timeout <dur>` (default `5m0s`) caps it. A safety-oriented one-shot form is **`agy --print --sandbox --model <model>`** with the prompt/diff delivered on **stdin**. **Output is plain text only**; `--output-format json` is **documented but NOT implemented** (errors `flags provided but not defined: -output-format`). *(established method)*
- **CRITICAL non-TTY bug:** `agy` checks whether stdout is a TTY; when piped / in command-substitution / CI it can **silently drop the final response and still exit 0**. Workarounds: wrap in a pseudo-TTY — `script -qec 'agy -p "..."' /dev/null | tee out.txt` (Linux `-e` propagates the real exit code), or `unbuffer`; then strip ANSI/CR. **Validate output is non-empty AND contains an expected marker** (instruct the model to prefix e.g. `COMMIT:`); single retry on empty; `timeout 180`. **Exit-code-0 is not a reliable success signal.** *(critical constraint)*
- **Features that could use it:** commit messages, PR titles/bodies, branch names, summaries, one-shot Q&A, and model discovery (`agy models`, §5). Use marker-prefix prompting since there is no JSON output. *(established)*
- **Auth path for headless:** Interactive OAuth fails headless — use `GEMINI_API_KEY` / `ANTIGRAVITY_API_KEY` env (guard `: "${GEMINI_API_KEY:?required}"`). Otherwise inherits the CLI's stored account (§4). *(established)*
- **Cost / latency / timeout / local-vs-remote:** Heavy ~23–25k-token system overhead per call → quota-hungry; latency model-dependent; `--print-timeout` default 5m; runs locally or over SSH. **Headless does not return the conversation UUID** (open issue) — capture it via a `brain/`/`history.jsonl` diff if you need to resume the headless session. *(established + hazard)*

## 13. Capabilities & quirks matrix

| Capability | Antigravity (`agy`) |
|---|---|
| Resumable | **Yes** — `--conversation <uuid>` (preferred); `--continue`/`-c` (UNSAFE for concurrent instances) |
| Resume-id source | exit-msg `Resume: agy --conversation=<id>`, `history.jsonl`, `brain/<id>/`, hook `conversationId`; **NOT** emitted by `--print` |
| Hooks | **Yes (first-class)** — `hooks.json` (`~/.gemini/config/` global, `.agents/` workspace, or plugin); stdin JSON / stdout `{decision}` |
| Hook events | `SessionStart`, `PreInvocation`, `PostInvocation`, `PreToolUse`, `PostToolUse`, `Stop`, Notification-style (install `PreToolUse` only as a passive/fail-open hook) |
| Hook fail-mode | **Fail-CLOSED** by default (unreachable → tool denied) → hooks MUST emit `{}`/`exit 0` |
| Hook env | **Sanitized to a whitelist** — custom env NOT forwarded to hooks; configure via files/socket |
| Plugins/extensions | **Yes** — `agy plugin install/enable/disable/list`; `~/.gemini/antigravity-cli/plugins/<n>/` (skills/agents/rules/MCP/hooks) |
| Draft prefill | **Initial only** (`--prompt-interactive`/`-i`); no live composer prefill |
| Read composer draft | **No structured method** (screen-scrape / dim-placeholder only) |
| Trust preset | **Yes** — `trustedWorkspaces` + `permissions` in `settings.json`; `--dangerously-skip-permissions` |
| Permission modes | `request-review`, `always-proceed`, `strict`, `proceed-in-sandbox`; YOLO=`--dangerously-skip-permissions`; `--sandbox` |
| Interactive-prompt selection | Detected via `PreToolUse` (`ask_question`/`ask_permission`→waiting) / `/agents`; selection NOT auto-driven (arrow/number keys, `Alt+J` next subagent) |
| Title source | `/rename`, OSC title (`/title on/off`), else first-prompt truncation (≤40) |
| Transcript format | **JSONL** (`transcript.jsonl` + `transcript_full.jsonl`) + opaque protobuf `conversations/` |
| Headless | **Yes** (`-p`/`--print`, `--sandbox`, `--model`, stdin) — plain text only; **non-TTY silent-drop bug**; JSON output unimplemented |
| Model listing | **Yes** — `agy models` (line-per-model) / `/model` (~8 models, effort in label) |
| Usage / quota | `/usage`, `/context`; programmatic via local `language_server` CSRF→`GetUserStatus` RPC |
| Token accounting | TUI `/usage`/`/context` + `GetUserStatus`; per-step token fields in transcript UNVERIFIED |
| Pricing / cost | **Not exposed** (subscription-metered; derive externally) |
| Fast mode | **Yes** — `/fast` (in-session); launch flag unverified |
| Sandbox | **Yes** — `--sandbox` / `enableTerminalSandbox` |
| MCP | **Yes** — `/mcp`, `mcp_config.json` (global `~/.gemini/config/`, workspace `.agents/`) |
| Subagents | **Yes, parallel/async** — `/agents`, `/tasks`, `agy inspect` |
| Multi-account / managed auth | **No first-class switch** — isolate by `HOME`/config-root or distinct API keys |
| Initial-prompt mode | `flag-interactive` → `--prompt-interactive <p>` (preferred); `--print` (headless) |
| Process identity | bare token `agy`, word-boundary match (`/(?<![\w./\\-])agy(?![\w./\\-])/i`) |
| ACP / JSON-RPC stdio | **No** (requested, unimplemented) |

**Special-cases / workarounds:**
1. **Never `--continue` in multi-instance** — resume by UUID only.
2. **Headless = pseudo-TTY wrap** (`script -qec`) + ANSI strip + marker-prefix + non-empty check; ignore exit-code-0 alone.
3. **Hooks must fail-open** (emit `{}` / `exit 0`) or they block every tool call.
4. **Env sanitized for hooks** — config via files/socket, never env.
5. **No headless conversation-id emission** — diff `brain/`/`history.jsonl`.
6. **Heavy ~23–25k-token overhead + ~5h rate windows** — surface quota.
7. **Config root is shared `~/.gemini`** (subdir `antigravity-cli/`; hooks in `~/.gemini/config/`) — do not conflate with Gemini-CLI.
8. **`<USER_REQUEST>` envelope** + **`PLANNER_RESPONSE`** transcript-shape quirks; **mid-turn `Stop` (`fullyIdle:false`)** is not terminal.
9. Drop a post-`Stop` same-`transcriptPath` `PostToolUse` to avoid a done→working bounce.

## 14. Failure, exit & recovery

- **Crash/exit detection:** PTY exit + exit code (interactive). Clean completion = a `Stop`/`PostInvocation` hook fired with the composer idle (state `done` comes from a fully-idle `Stop` hook, **not** from process exit); crash = abnormal PTY close / non-zero exit with no `Stop`. **Headless caveat:** exit-code-0 is unreliable (can be 0 with empty/dropped output) — combine with the non-empty + marker check (§12). *(established + caveat)*
- **Reattach-after-restart healing:** State persists on disk → on orchestrator restart, re-enumerate from `history.jsonl`/`brain/`, mark live-but-detached sessions, and either reattach the tmux/abduco PTY (+ SIGWINCH redraw + ready-prompt reconcile + completed-transcript de-dup) or cold-resume via `--conversation=<id>`. Guard "exited-but-alive" rows by checking the multiplexer master before declaring a session dead; reap orphan PTYs by PID. *(established = generic + Antigravity-specific reconcile helpers)*
- **Error surfacing:** No native `blocked`/`interrupted` *hook* event — error visibility comes from: the **fail-closed PreToolUse** denial ("Tool call denied by jsonhook__…"), transcript `status` ≠ `DONE` / error step types (exact enum **unverified**), auth failures (no keyring / no API key) at launch, and quota/rate-limit lockouts (5-hour windows, read from `/usage`/`GetUserStatus`). Otherwise errors are visible only in raw terminal output. *(partial; some error states unverified)*

## 15. Remote / transport

- **Transports supported:** **Local PTY, SSH (remote worktree), and daemon-subprocess** — all via a generic provider layer; the CLI is explicitly "optimized for keyboard-driven workflows and remote SSH sessions." The Go single-binary is easy to ship to a remote host. No Antigravity-specific transport limitation. *(established method)*
- **Agent-specific remote limitations:**
  - **Auth:** on remote/SSH, sign-in prints an **auth URL** (no local browser); for unattended remotes use `GEMINI_API_KEY`/`ANTIGRAVITY_API_KEY`. Keyring may be absent on remotes → **file-based token storage** (WSL behavior).
  - **Hooks fire on the `agy` host** → the hook→orchestrator transport (Unix socket or HTTP) must terminate on that host or tunnel back over the relay; remember **fail-open** and the **env-whitelist** limitation when the socket/endpoint lives across the relay.
  - **Quota RPC** (`language_server` CSRF → `GetUserStatus`) is **local to the `agy` host** — read it there and forward.
- **Remote hook install:** Write `${home}/.gemini/config/hooks.json` and the managed script (POSIX `.sh` variant) over SFTP. *(established method)*
- **Callback forwarding over the relay:** The managed script POSTs to `127.0.0.1:${HOOK_PORT}/hook/antigravity` (or feeds a Unix socket); for remote sessions the relay hosts the listener (keep the listener UI-framework-free for exactly this reason) and forwards normalized events, stamping a `connectionId` from the SSH mux on ingest, sharing the same `'/hook/antigravity' → 'antigravity'` route on both local server and relay. Inject the orchestrator endpoint into `hooks.json` (**a file, since env is sanitized**) and ensure it is reachable or fails open. PTY/git/fs ops execute on the `agy` host via the generic SSH providers. *(established method)*

---

## Open questions / unverified

The binary was not available to probe locally; the following need confirmation against a live `agy` install (`agy --help`, `agy <sub> --help`, `agy --version`, and a real `~/.gemini/antigravity-cli/` tree + sample `transcript.jsonl`):

- Exact `agy --help` / `agy --version` output (flag spellings, `--version` format).
- `agy models` output format (table vs line-per-model; any `--json`).
- Per-step token fields (input/output/cache/reasoning) in `transcript.jsonl` / `transcript_full.jsonl` — none confirmed; quota likely only via `GetUserStatus`.
- Representation of thinking/reasoning blocks, diffs, images/attachments in the JSONL transcript.
- The workspace-mapping field name inside the protobuf `conversations/` file.
- Whether a per-conversation model is persisted and restored on resume (vs always taken from current settings/flags).
- File-based credential filename on keyring-less hosts; which inherited API keys `agy` strips vs honors; endpoint/client-id for token refresh.
- Whether a config-dir env override is honored for multi-account isolation (vs `HOME` redirection).
- Trust requirements for workspace `.agents/hooks.json` — whether a hash-allowlist step exists (Claude-Code style).
- Full hook stdin payload field list (explicit `sessionId`, exact tool-name field), and whether `SessionStart`/Notification events are reliably delivered.
- A launch-time fast-mode flag (only the in-session `/fast` toggle is confirmed).
- Whether `agy` advertises bracketed paste; exact mouse-mode toggling; replay-on-resize behavior.
- OSC title-string contents (for §9 parsing).
- Subagent on-disk identity link (parent UUID ↔ child subagent id).
- Resolution of the documented-but-unimplemented `--output-format json` and ACP/JSON-RPC stdio mode in future releases (version-gate).
