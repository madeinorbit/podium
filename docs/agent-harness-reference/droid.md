# Factory Droid — orchestrator integration reference

Authoritative integration reference for hosting the **Factory Droid** coding-agent CLI (by Factory AI) inside a remote/web/mobile multi-agent orchestrator. Binary name: **`droid`**. Config/state home: **`~/.factory`**. The agent identifier used throughout this orchestrator is `droid`.

Droid exposes two surfaces that matter for integration: a full-screen **interactive TUI** (`droid`) and a purpose-built **headless** runner (`droid exec`) with structured output and a JSON-RPC stdio mode. It supports a Claude-Code-style **shell-command hook system** (9 events), per-session **JSONL transcripts**, first-class **resume/fork**, native **git worktrees**, a local **session search index**, and an official **TypeScript SDK** that drives `droid` as a subprocess over JSON-RPC.

> **Version caveat.** Headless `exec`, `stream-jsonrpc`, hooks, `--session-id`, and the TS SDK are newer features (CLI ~v0.4.0+ era). **Gate behavior on `droid --version`.** On-disk paths assume the default `~/.factory`.
>
> **Verification status.** Flags, hook events/payloads, settings schema, `exec` JSON result fields, the transcript-on-disk location, autonomy levels, env vars, and the auth/keyring model are confirmed from the official docs (docs.factory.ai: CLI Reference, Hooks Reference, Settings, BYOK, Droid Exec, Pricing), the official TS SDK, and the GitHub Action wrapper. Items that could not be confirmed against a live binary on this machine are tagged **(unverified)** inline and collected at the end. Re-run `droid --help`, `droid exec --help`, `droid --version`, and inspect `~/.factory/{settings.json,config.json,mcp.json,projects/*/*.jsonl,logs/*}` on a real install to close them.

---

## 1. Discovery & identity

- **Binary detection / "installed?":** Binary is **`droid`** on PATH; single name, no known alias/remap. Installed via `curl -fsSL https://app.factory.ai/cli | sh` (mac/Linux), `irm https://app.factory.ai/cli/windows | iex` (Windows), or `npm install -g droid`. **"Installed?"** = `which droid` resolves on PATH (no Droid-specific probe needed — a generic PATH/`which` lookup is the established method). The catalog/identity record is `{ id: 'droid', label: 'Droid', cmd: 'droid', homepageUrl: 'https://factory.ai/cli' }`. *(established method)*
- **Version detection / gating:** `droid -v` / `droid --version` prints the version; `droid update` self-updates. Behavior **does** gate on version: `exec` headless mode, `stream-jsonrpc`, hooks, the TS SDK, and `--session-id` are recent. Gate the orchestrator on a minimum version. *(established method)*
  - **Conflicts / open questions:** Exact version thresholds and the precise `--version` output string are unverified — confirm empirically.
- **Existing-session discovery (paths/globs):** Sessions are stored as **per-session JSONL transcripts, one file per session**, under a per-project directory:
  - `~/.factory/projects/<project>/<session-id>.jsonl` — **glob `~/.factory/projects/*/*.jsonl`** (this is the primary, doc/disk-confirmed location).
  - A built-in **`droid search "query"`** subcommand exists with `--kind {message_text,document,tool_use,tool_result,all}`, `--limit-sessions`, `--limit-hits`, `--json`, `--reindex` — i.e. a local **search index** over sessions. `droid search --json` (or `/sessions` in-TUI) can enumerate/locate sessions instead of, or in addition to, globbing. *(established method = glob; `droid search --json` = structured fallback/enumeration)*
  - **Conflicts / open questions:** One source additionally references `~/.factory/sessions/` as a second JSONL root; the disk-confirmed location is `~/.factory/projects/<project>/`. Scan both `~/.factory/projects/*/*.jsonl` and `~/.factory/sessions/*.jsonl` defensively. The `<project>` dir-name encoding (likely a slug/hash of the repo path, Claude-Code-style) is unverified.
- **Stable session identity:** A **session id** string (the file stem of the transcript). Sources:
  - **Live at launch:** capture `session_id` from `droid exec --output-format json`/`stream-json` output, from the **`SessionStart` hook payload** (`session_id` + `transcript_path` fields), or from the newly created transcript filename. The TS SDK returns `sessionId` from `createSession`.
  - **Pre-existing:** the JSONL filename stem, or the id from `droid search --json` / `/sessions`. Hooks always carry `session_id`; transcript lines carry `sessionId`/`session_id`.
  - Sanitize ids before reuse (reject control chars, leading `-`, excessive length) since they flow into resume argv. *(established method)*
  - **Conflicts / open questions:** Format is ambiguous — the CLI Reference example renders `session-abc123`, other material implies a UUID. Treat as an opaque string.
- **Session ↔ repo/worktree/cwd mapping:** Transcripts live under `~/.factory/projects/<project>/`, mapping session→project dir. Every hook payload and the `SessionStart` event carry **`cwd`**; the env var **`FACTORY_PROJECT_DIR`** is the project root — both give session→repo. Native worktree support via **`-w, --worktree [name]`** + the `worktreeDirectory` setting (default `~/.factory/worktrees`) maps a session to an isolated git worktree/branch. On resume, prefix the launch with `cd '<cwd>'` taken from the transcript's `cwd` / `session_start.cwd` record. *(established method)*

## 2. Launch & process model

- **Spawn mechanism / PTY host:** Two distinct models.
  - **(a) Interactive TUI** — `droid` / `droid "prompt"` is a full-screen alt-screen REPL; host it in a **PTY** (local / SSH-remote / daemon-subprocess), under a durable multiplexer for survival (§3).
  - **(b) Headless** — `droid exec` is non-interactive (exec-and-exit), no PTY needed: spawn directly, read stdout. The official **TS SDK** (`Factory-AI/droid-sdk-typescript`) spawns `droid` as a subprocess and speaks **JSON-RPC over stdio** (`execPath` default `"droid"`, `execArgs` extra args) — the cleanest headless control surface (§6/§12/§15). *(established method)*
- **Full launch command / args / env:**
  - **Interactive:** `droid` (optionally `droid "<initial prompt>"`), plus `-m/--model`, `-r/--reasoning-effort`, `--auto <level>`, `-w/--worktree`, `--cwd`, `--use-spec`, `--mission`, `--append-system-prompt` / `--append-system-prompt-file`, `--no-hooks`, `--settings <file>`, `-f/--file <path>`.
  - **Headless:** `droid exec [options] [prompt]` with `-o, --output-format {text|json|stream-json|stream-jsonrpc}`, `-s/--session-id`, `--fork`, `--input-format stream-jsonrpc`.
  - **Env Droid injects** into the child/hook environment: `FACTORY_PROJECT_DIR`, `DROID_CWD`, `DROID_PLUGIN_ROOT`, `FACTORY_LOG_FILE`.
  - **Env Droid reads** for config/auth: `FACTORY_API_KEY` (`fk-…`), `FACTORY_TOKEN` (CI), `FACTORY_DISABLE_KEYRING`, plus standard `HTTPS_PROXY` / `NO_PROXY` / `NODE_EXTRA_CA_CERTS` / `GH_TOKEN`.
  - **Orchestrator instrumentation env** (hook callback port + auth token, pane/tab/worktree ids) is injected here too and consumed by the installed hook script (§8).
  - **Env to strip:** inherited `ANTHROPIC_AUTH_TOKEN` overrides `~/.factory/config.json` and causes errors (BYOK note) — strip it (and likely `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`) unless intentionally doing BYOK. *(established method)*
  - **Conflicts / open questions:** No Droid-specific env-strip is strictly *required* for the spawn-and-let-CLI-auth path (Droid runs in the user's own shell with their own creds). The strip above matters only when stray provider keys are present in the orchestrator's environment.
- **Durable backing across restart/detach:** Droid has **no built-in survival daemon for the TUI** — use a generic tmux/abduco-style multiplexer, as with other full-screen TUIs. **Caution:** `droid daemon` exists but is the **Factory daemon server** for `droid computer` (BYOM remote machines), **not** a session-survival multiplexer — do not conflate them. *(established method = generic mux)*
- **Initial-prompt injection mode:** Multiple:
  - **argv:** `droid "do X"` (TUI) / `droid exec "do X"` (headless). Standard shell quoting; single-quote the prompt.
  - **flag/file:** **`-f, --file <path>`** reads the prompt from a file (both modes) — **preferred** for large/multiline prompts (no quoting issues).
  - **stdin pipe:** `echo "…" | droid exec` (headless).
  - **type-after-ready:** type into the composer of an already-running interactive PTY (§6).
  *(established method; pick per transport — argv for short one-liners, `-f`/stdin for anything large)*
- **First-run / trust handling:** First run requires **authentication** (browser OAuth or API key) and an onboarding step. Pre-seed by pre-writing `~/.factory/settings.json` with the "already onboarded" markers (e.g. `ideExtensionPromptedAt`, `ideActivationNudgedForVersion`, a chosen `theme`) and ensuring creds exist before first spawn. For headless/CI, `FACTORY_TOKEN`/`FACTORY_API_KEY` + `--auto <level>` + `--skip-permissions-unsafe` bypasses interactive trust entirely. *(fallback — settings pre-seed; established for headless via env + flags)*
  - **Conflicts / open questions:** Exact trust-prompt bytes and the definitive set of "onboarded" marker keys are unverified — confirm the trust-prompt sequence on a real device.
- **Permission / YOLO / sandbox modes:** **`--auto <level>`** governs autonomy: default (no flag) = **read-only**; `low` = file create/edit in project; `medium` = + package install, git commit, builds (no push/sudo); `high` = + git push, deploys, arbitrary exec. **`--skip-permissions-unsafe`** removes all checks (containers only). Also **Droid Shield** (`enableDroidShield` setting) and command lists (`commandAllowlist` / `commandDenylist` / `commandBlocklist`) in settings; org clamp via `maxAutonomyLevel`. For an interactive launch, prefer the read-only default and let the user escalate via Shift+Tab (§5/§6). *(established method)*
- **Model / reasoning-effort / fast-mode at launch:** **Model:** `-m, --model <id>`. **Reasoning effort:** `-r, --reasoning-effort {off,none,low,medium,high}`. Spec-mode variants: `--spec-model` / `--spec-reasoning-effort`. Mission variants: `--worker-model` / `--validator-model`. **Fast mode IS a concept** — a **`/fast`** slash command toggles a fast model (e.g. a Turbo-class default); effectively a model choice + low reasoning rather than a dedicated launch flag. *(established method for model/effort; fast mode = slash toggle)*
  - **Conflicts / open questions:** No launch flag named `--fast` is confirmed (fast mode is the `/fast` slash toggle). **`-r` is overloaded** in the CLI Reference for both `--resume` and `--reasoning-effort` — **always use the long forms** (`--reasoning-effort`, `--resume`) to avoid ambiguity.

## 3. Resume & reattach

- **Resume support / flags / id source:** Yes, first-class.
  - **Interactive:** `--resume [sessionId]` (defaults to the last-modified session if id omitted). `--fork <sessionId>` duplicates into a new session.
  - **Headless:** `-s, --session-id <id>` continues an existing session across `exec` calls; `--fork <id>` branches.
  - **TS SDK:** `resumeSession(id, options?)`, `forkSession()`; `initResult` caches the raw `load_session` JSON-RPC payload.
  - The id comes from §1 (transcript filename stem, `SessionStart`/`exec --output-format json` `session_id`, or `droid search --json`). Resume is gated on having a valid session id. Resume command should be `cd '<cwd>' && droid --resume '<id>'`. *(established method)*
  - **Conflicts / open questions:** Because of the `-r` overload, **prefer long-form `--resume`**.
- **State restored vs lost on resume:** Droid restores conversation **history, transcript, tool calls, and context** ("rejoin work-in-progress without losing tool calls, transcripts, or context"). The orchestrator restores **cwd** (via the `cd` prefix). **Model / permissions (`--auto`) are not guaranteed restored** — re-pass `-m`/`--cwd`/`--auto` explicitly on resume to be safe. The orchestrator should also reinstall hooks on `SessionStart` so a resumed session resets per-pane prompt/tool caches without waiting for the next `UserPromptSubmit` (§7/§8). *(established method)*
  - **Conflicts / open questions:** Whether model/cwd/permission state survives resume natively is unverified — re-supply them.
- **Reattach to a still-running PTY after restart:** No Droid-native PTY reattach — **falls back to generic** tmux/abduco reattach. As a full-screen alt-screen TUI it only repaints on resize, so a **redraw nudge (SIGWINCH / resize toggle)** is needed after reattach to force a repaint. For the headless/SDK path, reconnect a fresh JSON-RPC client. On reattach, treat `SessionStart` as **state-neutral** (clear the per-pane turn cache, emit no state) so a resumed-but-idle TUI is not shown as "working" (§7). *(established method = generic mux + SIGWINCH; Droid-aware = SessionStart state-clearing)*
- **Idempotency / race hazards:** (a) Only **one** PTY client may hold the multiplexer master — a double-attach causes echo-doubling. (b) On `--resume`/`-s`, ensure only one process owns a given session id at a time (two writers would both write the JSONL + server-side session). (c) `SessionStart` must yield no state to avoid a phantom "working" row on open/resume. (d) Sanitize the session id before building resume argv. *(guard rules)*
  - **Conflicts / open questions:** Whether Droid locks the session JSONL against concurrent writers is unverified — enforce single-owner at the orchestrator level.

## 4. Auth & subscription

- **Credential locations:**
  - **System keyring (primary):** OAuth tokens in the OS keyring (macOS Keychain / Windows Credential Manager / Linux Secret Service), with a **fallback file** when the keyring is unavailable. **`FACTORY_DISABLE_KEYRING=1`** forces the fallback file. MCP OAuth tokens are also keyring-stored, global (not per-project). Tokens auto-rotate ~every 30 days with atomic writes.
  - **API key:** `FACTORY_API_KEY` (`fk-…`) env var, or `~/.factory/config.json` / `settings.json` (`apiKey` / `customModels[].apiKey`). `FACTORY_TOKEN` for CI.
  - **BYOK provider keys:** `customModels[].apiKey` (or `${ENV}` interpolation) in settings (§5). *(established method)*
  - **Conflicts / open questions:** The keyring fallback-file path is not disclosed/unverified.
- **Reuse model:** **Spawn-and-let-CLI-auth** is the established, simplest path: the user runs `droid` once, OAuth/API-key persists in keyring/config, and the orchestrator launches Droid in the user's own environment using those creds as-is. **Orchestrator-managed multi-account is possible but awkward** because creds live in the OS keyring, not a plain file — capture/materialize per account requires one of: `FACTORY_DISABLE_KEYRING=1` + managing the fallback file, per-account `FACTORY_API_KEY` env injection, or per-account `HOME`/`~/.factory` sandboxing. *(established = spawn-and-let-CLI-auth; multi-account = fallback, awkward)*
- **Token refresh:** Owned by the CLI — Droid refreshes against Factory's auth service (`app.factory.ai` / `api.factory.ai`), auto-rotating ~30 days with write-back to the keyring. The orchestrator does **not** refresh. *(established method, CLI-owned)*
- **Env hygiene:** Strip inherited `ANTHROPIC_AUTH_TOKEN` (it overrides config and errors) and likely other stray provider keys unless doing BYOK. For Factory-native auth, don't inherit foreign provider keys. *(established method)*
- **Multi-account isolation / selection:** Best lever is **per-account `HOME` (hence `~/.factory`) sandboxing** + that account's keyring/config, or a distinct `FACTORY_API_KEY` per spawn. In-CLI there are only `/login`, `/logout`, `/account` slash commands (no `--account`/profile flag). *(fallback)*
  - **Conflicts / open questions:** Whether a dedicated config-dir override env (e.g. `FACTORY_HOME`) exists is unverified — only `HOME`/`USERPROFILE` redirection is known to work.

## 5. Models, usage & accounting

- **Model listing (settings UI):** **No documented machine-readable `droid models --json` subcommand.** Enumeration paths, in order of usefulness:
  - **`droid exec --help`** text lists a **fixed built-in set of "factory" model IDs** (`exec -m` validates against it and rejects unknown IDs) — brittle but parseable.
  - In-TUI **`/model`** lists Factory-provided models + a "Custom models" (BYOK) section.
  - **`customModels[]`** in `~/.factory/settings.json` / `config.json` enumerates BYOK/custom models (`id`, `displayName`, `provider`, `baseUrl`); custom ids use the form `custom:<Name>-[<Provider>]-<n>`.
  - Default factory IDs (fluid, re-read per version): Claude Opus/Sonnet/Haiku 4.x, GPT-5.x / GPT-5.x-Codex, Gemini 3 Pro/Flash, plus BYOK (Kimi, GLM, MiniMax, …). *(fallback methods only — no clean `--list-models` JSON)*
  - **Conflicts / open questions:** `exec -m` **rejects custom model IDs** not in its fixed list (a known limitation) — BYOK custom models work interactively but may not via `exec -m`.
- **Runtime switching mid-session:** Yes — **`/model`** (model), **Tab** cycles reasoning effort, **`/fast`** toggles fast model, **Shift+Tab** cycles autonomy level. All driven from the composer. *(established method, in-TUI)*
- **Usage windows / quota / rate-limits:** **`/limits`** toggles Droid Core vs Extra Usage and shows limit state; there are **three independent rate windows (5-hour, weekly, monthly)** that must all have headroom. On exhaustion the in-flight request finishes, then subsequent ones return a "Rate Limit" error. Surfaced in the TUI status card. *(established method = in-TUI `/limits`)*
  - **Conflicts / open questions:** No documented local file or `api.factory.ai` endpoint the orchestrator can read directly for remaining quota — unverified.
- **Token accounting:** Available.
  - **Transcript JSONL** carries per-message **`tokenUsage`** with `inputTokens` / `outputTokens`, plus **`assistantActiveTimeMs`** (duration). A coarse per-session total can be summed from `completion`/message records' usage.
  - **stream-jsonrpc / TS SDK** emit **`token_usage_update`** partial events (context-usage counters).
  - In-TUI **`/usage off|tokens|full`** toggles a per-response footer; **`/usage cost`**, **`/cost`**, **`/stats`** show local aggregates. `showTokenUsageIndicator` setting. *(established method = transcript `tokenUsage` + stream events)*
  - **Conflicts / open questions:** Cache/reasoning token sub-fields are unverified; no per-turn input/output/cache/reasoning breakdown via hooks is documented.
- **Pricing / cost:** Droid computes cost for **API-key (BYOK)** sessions and shows it in the status card + `/usage cost` / `/cost`. **No documented machine-readable per-model rate table** for the orchestrator — maintain your own price table if cost display is needed. *(not exposed — orchestrator-owned)*

## 6. Driving & input — two-way control

- **Send a new user message mid-session:**
  - **Interactive PTY:** type into the composer and submit. **Enter** submits; **Shift+Enter** = newline (may need `/terminal-setup`). For programmatic injection, use **bracketed paste** (`ESC[200~ … ESC[201~`) for the text, then a **separate CR** (`0x0d`) to submit (TUI-safe; treat like other alt-screen TUIs).
  - **Headless multi-turn:** `--input-format stream-jsonrpc` + `--output-format stream-jsonrpc` drives turns as JSON-RPC messages (what the TS SDK does); `-s/--session-id` continues across `exec` calls. *(established method)*
  - **Conflicts / open questions:** Droid's exact paste handling / paste-ready signal is unverified — gate the paste on the composer being ready (see rendering §11).
- **Read the agent's current input-box contents (draft sync out):** **Not supported natively** — no API/OSC/transcript exposure of the live composer. Only route is **screen-scraping** the composer line (dim-placeholder detection). For SDK/headless clients the draft lives in the orchestrator, so this is moot. *(not supported; screen-scrape fallback)*
- **Pre-fill / set the input box (draft sync in):** **No flag/env to prefill the live composer.** Initial prompt only via argv / `-f` / stdin (§2). For a live TUI, **typed/bracketed paste is the only path** (gated on composer-ready). No native `--prefill`. *(not supported natively; fallback = typed paste)*
- **Answer interactive prompts / permission menus:** Permission requests surface as a **`Notification` hook** (`notification_type`, `notification_message`) and as a selectable menu in the TUI. Detection of "needs-user" is best taken from the `Notification` hook + the `permission_mode` field rather than scraping.
  - **TUI selection:** via keys (arrow / number / Enter) — exact bytes unverified; treat generically.
  - **Headless/SDK (clean):** a **`permissionHandler`** callback receives the request and returns a **`ToolConfirmationOutcome`** — the preferred programmatic path.
  - The orchestrator may **detect→surface "waiting"** without auto-selecting; leave the actual choice to the user typing into the PTY (or the SDK handler). *(established method = Notification hook + SDK handler; TUI selection = generic keys)*
- **Interrupt / cancel / escape:** **Ctrl+C cancels the current turn** (does not necessarily quit); **Esc** also interrupts; **Ctrl+C twice** or `/quit` exits. *(established method)*
  - **Conflicts / open questions:** One source reports the opposite — that Ctrl+C does **not** interrupt the current turn and that repeated Ctrl+C only exits, in which case Esc (or a turn-cancel via the SDK/JSON-RPC) is the interrupt and an idle "waiting for your input" Notification (mapped to `done`) marks the cancelled turn rather than a `Stop` event. **This is the single most important behavior to verify byte-by-byte on a real device before relying on Ctrl+C as the interrupt.** Until verified, prefer the SDK/JSON-RPC interrupt for headless and treat Esc as the safer TUI interrupt; do not assume a `Stop` hook fires on interrupt.
- **Slash commands the orchestrator may issue (40+):** `/model`, `/fast`, `/sessions`, `/new`, `/clear`, `/compress`, `/context`, `/cost`, `/stats`, `/status`, `/usage`, `/limits`, `/review`, `/mcp`, `/skills`, `/droids`, `/missions`, `/fork`, `/rename`, `/favorite`, `/rewind-conversation`, `/cwd`, `/hooks`, `/plugins`, `/themes`, `/statusline`, `/terminal-setup`, `/login`, `/logout`, `/account`, `/billing`, `/share`, `/copy`, `/quit`. *(established method)*
- **Attachments / large paste:** **`@`** triggers file autocomplete (reference a file by path). Images are supported via the composer/paste for capable models (BYOK models can opt out with `noImageSupport`). For large content use **`-f, --file`** (headless) or `@file` references rather than pasting. *(established method)*
  - **Conflicts / open questions:** On-disk representation of a pasted image is unverified.
- **Important keyboard shortcuts & modifier keys (mobile soft-keyboard):**
  - **Enter** = submit; **Shift+Enter** = newline (may need `/terminal-setup`).
  - **Esc** = interrupt/cancel; **Ctrl+C** = cancel/quit (see interrupt caveat above).
  - **Shift+Tab** = cycle autonomy level; **Tab** = cycle reasoning effort; **@** = file autocomplete; **!** = bash mode (run shell when input is empty).
  - **Ctrl+O** = open transcript view; **Ctrl+R** = transcript / reverse-search; **Ctrl+L** = clear; **Ctrl+N** = new; **?** = help.
  - History/cursor: **Alt+Up/Down/PageUp/PageDown** + readline-style **Ctrl+A/E/W/K/U/D**. The **Alt/Meta** combos require Alt/Option fidelity in the soft keyboard. *(established list)*
  - **Conflicts / open questions:** Exact key bytes for shortcuts and menu navigation are unverified — confirm on-device.

## 7. Agent-state classification

- **State vocabulary:** Map into **`working | waiting (needs-user) | done`**, with optional **`error`** and an **`interrupted`** flag. The hook stream is the spine.
- **Signal sources & authority rank (highest→lowest):**
  1. **Hooks (authoritative):** `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SubagentStop`, `PreCompact`, `SessionEnd` (§8). Hooks should be treated as ground truth.
  2. **stream-jsonrpc / TS SDK events** (headless): `assistant`, `tool_call`, `tool_result`, `error`, `result` (turn end), plus partials `assistant_text_delta`, `thinking_text_delta`, `tool_call_delta`, `token_usage_update`, `permission_resolved`, hook-execution started/finished, `mission_state_changed` / `mission_progress_entry` / `mission_heartbeat`.
  3. **Transcript JSONL** new lines (poll/tail).
  4. **Process exit** (headless `exec`) and generic output-activity / foreground-child heuristics (TUI).
  5. **OSC/native terminal title (deliberately weak):** Droid sets a window title and supports a custom `statusLine`, but a name-only "Droid" title carries no working/idle info — **treat as inconclusive** and never let it flip a working pane to done. Prefer hooks.
- **Event→state mapping:**

  | signal | state |
  |---|---|
  | `SessionStart` | **none** — clear turn cache, emit no state (idle on open/resume) |
  | `UserPromptSubmit` | **working** (also marks the new-turn boundary) |
  | `PreToolUse` (ordinary tool) | **working** |
  | `PreToolUse` (AskUser tool, or `riskLevel`/`risk_level` == `high`) | **waiting** |
  | `PostToolUse` / `assistant` / `tool_result` deltas | **working** (still in turn) |
  | `Notification` matching permission/approve/approval (or with `notification_type` = permission) | **waiting** |
  | `Notification` matching "waiting for (your) input" (idle) | **done** |
  | `PermissionRequest` (if emitted) | **waiting** |
  | `Stop` (and SDK `result`) | **done** |
  | `SubagentStop` | **ignored** (subagent done; parent unaffected) |
  | SDK `error` event / non-zero `exec` exit | **error** |
  | Ctrl+C / Esc | **interrupted** |

- **"Stopped but needs user" vs "done":** Distinguish by event. Approval/AskUser/high-risk paths → **waiting** (`PreToolUse` AskUser/high-risk, `Notification` matching permission, or `PermissionRequest`). Genuine completion → **done** (`Stop` / SDK `result`). The `permission_mode` field (`off | spec | auto-low | auto-medium | auto-high`) present on every hook payload disambiguates. Because the approval path may emit only a `Notification` (not a `Stop`), use **multiple detectors** for "waiting." *(established method)*
- **Reconciliation:** Hooks are ground truth. Reset tool/prompt caches on the `UserPromptSubmit` new-turn boundary. For `Notification` events, force the cached prompt text to `''` so status copy doesn't overwrite the real user prompt. Apply a quiet-window/debounce on `Stop` (a new turn can begin right after). The `stop_hook_active` boolean guards against hook re-entrancy loops. Subordinate the native title to hook state. *(established method)*
- **Sub-agent / nested state:** `SubagentStop` fires for Task-tool sub-droids — **intentionally ignored** so a sub-droid finishing can't flip/notify the parent. Mission mode emits its own `mission_*` progress events. Subagents share the parent `session_id`. *(established method)*
  - **Conflicts / open questions:** Whether subagents ever get a distinct id is unverified.
- **Latency:** Hooks fire synchronously around tool/turn boundaries (stdin JSON, default 60s timeout) — low latency. Stream deltas are token-time; transcript tail is write-time. Make the hook callback non-blocking with a short timeout so a down orchestrator never stalls Droid. *(established method)*
- **Conflicts / open questions:** Whether Droid emits an OSC JSON status channel (beyond the plain window title) is unverified — do not depend on one.

## 8. Hooks & instrumentation install

- **Mechanism:** **Yes — a Claude-Code-style shell-command hook system** (managed scripts), plus **plugins** (`droid plugin`, `DROID_PLUGIN_ROOT`) and skills/custom droids. `enableHooks` setting; **`--no-hooks`** flag disables. The orchestrator installs a managed hook script (`droid-hook.sh`, or `droid-hook.cmd` on Windows) and registers it under the `hooks` key. *(established method)*
- **Install location & trust:** Configure under the **`hooks`** key in **`~/.factory/settings.json`** (user) or **`.factory/settings.json`** (project), with `settings.local.json` overrides; hook scripts conventionally in `.factory/hooks/`. The service should also honor a `hooksDisabled: true` (or `enableHooks: false`) flag and surface it. **No documented config-hash / trust-attestation gate** — `enableHooks`/`--no-hooks` is the on/off, and `commandAllowlist`/Droid Shield govern command safety. *(established method)*
  - **Conflicts / open questions:** Any hash-attestation step is unverified (none documented).
- **Hook config schema (verbatim shape):**
  ```json
  {
    "hooks": {
      "PreToolUse": [
        { "matcher": "Create|Edit",
          "hooks": [ { "type": "command", "command": "/abs/path/droid-hook.sh", "timeout": 60 } ] }
      ],
      "Stop": [
        { "hooks": [ { "type": "command", "command": "/abs/path/droid-hook.sh Stop" } ] }
      ]
    }
  }
  ```
  - Matchers apply to `PreToolUse` / `PostToolUse` (tool-name regex, e.g. `Edit|Create`, case-sensitive — or `*` to match all). The other events (`UserPromptSubmit`, `Notification`, `Stop`, `SubagentStop`, `PreCompact`, `SessionStart`, `SessionEnd`) take no matcher.
- **Event taxonomy + payload (stdin JSON):** **9 events** (§7). **Common fields on every event:** `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`. **Event-specific:**
  - `SessionStart` → `trigger_source` (`startup` / `resume` / `clear` / `compact`)
  - `UserPromptSubmit` → `prompt` / `prompt_text`
  - `PreToolUse` → `tool_name` (+ `name`), `tool_input` (+ `input` / `arguments`), `riskLevel` / `risk_level`
  - `PostToolUse` → + `tool_response` (+ `tool_output`)
  - `Notification` → `notification_type`, `notification_message` (+ `message`)
  - `Stop` / `SubagentStop` → `stop_hook_active` (plus `last_assistant_message` / transcript tail on `Stop`)
  - `PreCompact` → `trigger_type`, `custom_instructions`
  - `SessionEnd` → `reason` (`clear` / `logout` / `prompt_input_exit` / `other`)
- **Transport back + fail-open:** Hooks run as shell commands with **JSON on stdin**; the managed script forwards to the orchestrator — the established pattern is an **HTTP POST to `http://127.0.0.1:<injected-port>/hook/droid`** with an injected auth-token header and the urlencoded payload + pane/tab/worktree ids. Env available to the script: `FACTORY_PROJECT_DIR`, `DROID_CWD`, `DROID_PLUGIN_ROOT`, plus the injected orchestrator hook env. **Output protocol:** exit 0 = ok; **exit 2 = blocking** (stderr fed back to Droid / blocks the prompt, event-dependent); structured stdout JSON can set `permissionDecision` / `decision` / `additionalContext`. **Fail-open:** make the callback non-blocking, use short connect/read timeouts, `|| true`, and exit 0 when the port/token/pane-id/payload is empty — so a down orchestrator never stalls Droid. *(established method)*
- **Lifecycle:** install / status / uninstall. Install writes the managed command into each subscribed event's `hooks[]` array; **idempotent** (sweep managed entries out of no-longer-subscribed events, dedup within subscribed events via a managed-command matcher). Per-event arrays let orchestrator hooks coexist with user hooks. Version skew handled via an injected hook-version env. Reinstall (or rely on `SessionStart`) on resume so per-pane caches reset. Surface a hook-install error state when `~/.factory/settings.json` can't be parsed. *(established method)*

## 9. Session titles

- **Source of truth (in order):**
  1. **First-prompt text** (truncated/regex) — always available from `UserPromptSubmit` (`prompt` / `prompt_text`), or the first transcript line's user message, or a `session_start.title` record if present.
  2. **`/rename`** sets a custom title; **`/favorite`** marks sessions — implies stored title/metadata on the session.
  3. **OSC window title** the TUI sets — low-fidelity, name-only (inconclusive for state; §7).
  - For a live pane, the orchestrator may **synthesize** state-bearing titles from hook state (e.g. `Droid` / `Droid - action required` / `Droid ready`) since the native title carries no working/idle info.
- **Read/update/eventing:** Read first prompt at `UserPromptSubmit`/`SessionStart`; re-read on `/rename`. Live titles update via the hook→state pipeline; transcript titles are read on scan. No documented title-changed event. *(established method)*
- **Fallback / synthetic:** First-prompt truncation → `session_start.title` → "Session <short-id>" → cwd basename. *(established method)*
  - **Conflicts / open questions:** The on-disk location of `/rename` metadata is unverified (likely server-side or a sidecar).

## 10. Transcript & history

- **Storage:** **JSONL, one file per session**, at `~/.factory/projects/<project>/<session-id>.jsonl` (also reachable via the `transcript_path` field on hook events). One JSON object per line per turn/message. *(established method)*
- **Parsing / schema mapping (field names approximate where unverified):**
  - `session_start` → `id` (sessionId), `title`, `cwd`.
  - `system` → `cwd`, `model`.
  - any record → `session_id` / `sessionId` override.
  - message lines → `role` (`user` / `assistant`, possibly nested `message.role`), `messageId` (per-message id), `content` / `text` (preview text); first user message seeds the title.
  - `completion` → assistant message, `finalText` preview.
  - **`tool_use` blocks** → tool calls (Create / Edit / ApplyPatch tool inputs/outputs → diffs).
  - **`tokenUsage`** (`inputTokens` / `outputTokens`) + **`assistantActiveTimeMs`** → analytics (§5).
  - thinking → `thinking_text_delta` / `showThinkingInMainView` (thinking blocks exist).
- **Live tail vs historical read:** **Historical** = read the JSONL. **Live**, three options: (a) **tail the JSONL** (detect new lines by file offset / `messageId` set); (b) subscribe to **stream-jsonrpc** events; (c) drive off the **`Stop` / `PostToolUse` hooks**, which carry `transcript_path` to re-parse (the established sync pattern: on `Stop`, parse the JSONL and diff against a synced-`messageId` set in a state file). The `Stop` hook can also read the transcript tail for the last assistant message directly. Order by file order; dedup by `messageId`. *(established method)*
- **Consumers:** chat view ← role/content/`tool_use`; last-message/preview ← last assistant line (or `Stop` hook tail); clickable items ← `tool_input` file paths, `@file` refs, Edit/ApplyPatch diffs; state classification ← hooks/events (§7); analytics ← `tokenUsage` / `assistantActiveTimeMs`.
- **Transcript ↔ terminal reconciliation:** Two views — reconcile by `messageId` / turn order. Use the JSONL for structured chat, the PTY for fidelity. The native title is subordinated to hook state (§7/§9).
- **Special content types & quirks:** Thinking blocks (`showThinkingInMainView`, `thinking_text_delta`); tool outputs (`toolResultDisplay: expanded|compact`); diffs (`diffMode: github|unified`; tools Create/Edit/ApplyPatch); images (BYOK `noImageSupport` flag); Mermaid diagrams auto-rendered to ASCII in the TUI. *(established method)*
  - **Conflicts / open questions:** Full JSONL schema, cache/reasoning token fields, on-disk representation of pasted images and thinking blocks, and any redacted/internal entry handling are unverified — confirm against real `*.jsonl`.

## 11. Terminal rendering & display fidelity

Essentially all generic — Droid needs no custom rendering code beyond the alt-screen-TUI handling common to other full-screen agents.
- **PTY → xterm:** Interactive Droid is a full **alt-screen TUI**; capture PTY bytes → stream → xterm.js. May need alt-screen-chrome stripping for embedding and OSC-title interception for §9. *(generic)*
- **Resize/reflow:** Send **SIGWINCH** on cols/rows change; because it repaints on resize, use a **resize toggle as the redraw nudge**. Handle the mobile↔desktop breakpoint remount with a forced resize/redraw. *(generic)*
- **Scrollback model:** **Native TUI alt-screen** — Droid owns its history rendering; **forward the mouse** so the agent scrolls its own buffer (not xterm scrollback). `Ctrl+O` / `Ctrl+R` open the transcript view. Distinguish scrolling agent history vs the input box via the TUI's own handling. *(generic)*
- **Mouse forwarding:** Forward scroll/click into the TUI while in alt-screen; disable when not needed. *(generic)*
  - **Conflicts / open questions:** Droid's exact mouse-mode is unverified.
- **Snapshot/serialize for reattach:** Generic headless-xterm serialize + replay; **redraw nudge after reattach**. *(generic)*
- **Local cache → instant render → live reconnect:** No agent-specific support — generic: persist the last serialized xterm buffer for an instant paint, then reconnect the live PTY and SIGWINCH-nudge to reconcile. The **structured JSONL transcript is the better instant-render source for the chat view** (render JSONL immediately, attach the PTY in the background). *(generic)*
- **Composer/cursor:** Composer is a prompt line; `@` autocomplete, `!` bash-mode, **dim-placeholder when empty** (scrape with dropDim-style logic). *(generic)*
  - **Conflicts / open questions:** The exact dim sequence and the paste-ready signal are unverified — scrape defensively; gate paste on composer-ready.
- **Color/theme/OSC:** `theme`, `terminalColorMode` / `overrideTerminalColors`, `nerdFont`, `logoAnimation`, custom `statusLine`. **Nerd-font glyphs may render oddly without the font on web** — consider forcing a theme / disabling `nerdFont` / disabling `logoAnimation` for the embedded terminal. *(generic + Droid settings)*

## 12. Background / headless invocation

- **Non-interactive:** **Yes — `droid exec` is purpose-built for this.**
  - One-shot: `droid exec "prompt"` / `droid exec -f file.md` / `echo prompt | droid exec`.
  - Output: **`-o text|json|stream-json|stream-jsonrpc`**.
  - **JSON result fields:** `type`, `subtype`, `is_error`, `duration_ms`, `num_turns`, `result`, `session_id` — clean for programmatic consumption.
  - Multi-turn: `--input-format stream-jsonrpc` + `-s/--session-id`. *(established method)*
- **Which features could use it:** commit messages, PR title/body, branch names, session summaries/titles, code review (`/review`, the `Factory-AI/droid-action` GitHub Action), and one-shot LLM utility calls — all via `droid exec -o json --auto low` (or the read-only default for pure text generation). Model discovery is weak (no clean list command; §5).
- **Auth path for headless:** `FACTORY_API_KEY` / `FACTORY_TOKEN` env (CI) or an inherited keyring login. Set `--auto` appropriately (read-only default is safest for pure generation).
- **Cost / latency / timeout / caps:** Read-only default (no mutations) is cheap and safe; `--auto high` is risky. `llmRequestTimeout` setting governs request timeout; `--skip-permissions-unsafe` only in containers. **Fail-fast:** exec stops + non-zero exit + no partial changes if an action exceeds the autonomy level. Runs locally, or remotely via `droid computer` / `droid daemon`. *(established method)*

## 13. Capabilities & quirks matrix

| Capability | Droid |
|---|---|
| Resumable | **Yes** — `--resume [id]` (TUI), `-s/--session-id` (exec), `--fork` |
| Hooks | **Yes** — 9 events, shell-command, stdin JSON (Claude-Code-style); `~/.factory/settings.json` `hooks` key; `--no-hooks` disables |
| Plugins / skills / subagents | **Yes** — `droid plugin`, `.factory/skills`, `.factory/droids` |
| Draft prefill (live composer) | **None** — initial prompt via argv / `-f` / stdin only; live = typed paste |
| Trust preset | Settings markers + `FACTORY_TOKEN` / `--auto` / `--skip-permissions-unsafe` (exact markers unverified) |
| Interactive-prompt selection | TUI menu keys (detect→waiting; not auto-selected) **or** SDK `permissionHandler` → `ToolConfirmationOutcome` (clean) |
| Title source | First-prompt / `session_start.title` / `/rename` metadata / synthesized from hooks; native OSC title inconclusive |
| Transcript format | **JSONL**, one file/session, `~/.factory/projects/<project>/<id>.jsonl` |
| Headless / background | **Yes** — `droid exec`, `-o json/stream-json/stream-jsonrpc` |
| Model listing | **Weak** — `/model`, `exec --help` fixed list, `customModels[]` in settings; no `--list-models` JSON |
| Usage / quota | `/limits` (5h / weekly / monthly windows), `/usage`, `/cost`; no documented orchestrator-readable endpoint |
| Token accounting | **Yes** — `tokenUsage.input/output` + `assistantActiveTimeMs` in JSONL; `token_usage_update` stream events |
| Fast mode | **Yes** — `/fast` slash toggle (no `--fast` flag confirmed) |
| Worktrees | **Yes** — `-w/--worktree`, `worktreeDirectory` |
| Search index | **Yes** — `droid search --json --kind …` |
| TS SDK | **Yes** — `Factory-AI/droid-sdk-typescript` (JSON-RPC over stdio) |
| Permission / autonomy flag | **Yes** — `--auto {off|low|medium|high}`, `--skip-permissions-unsafe`, Droid Shield, command allow/deny lists |
| Auth management | Spawn-and-let-CLI-auth (keyring); orchestrator multi-account awkward (keyring, not a plain file) |
| Prompt injection | `argv` / `-f file` / `stdin` (exec) / type-after-ready (TUI) |

**Known agent-specific special-cases / workarounds:**
- **`-r` is overloaded** for both `--resume` and `--reasoning-effort` in the CLI Reference — **always use long forms.**
- **`exec -m` rejects custom model IDs** not in its fixed built-in list — BYOK custom models work interactively but may not via `exec -m`.
- **Inherited `ANTHROPIC_AUTH_TOKEN` overrides config and errors** — strip it unless doing BYOK.
- **Creds live in the OS keyring** (not a plain file) — complicates multi-account capture/materialize (use `FACTORY_DISABLE_KEYRING`, per-account `FACTORY_API_KEY`, or per-account `HOME`).
- **`droid daemon` ≠ session multiplexer** — it's the BYOM / `droid computer` server. Use tmux/abduco for TUI survival.
- **Native title is inconclusive** — a bare "Droid" title carries no working/idle state; never let it flip working→done. Use a token-boundary name match so "android"/Android titles aren't misclassified.
- **Approvals span multiple detectors** — `PreToolUse` (AskUser / high-risk `riskLevel`), `Notification` (permission), and `PermissionRequest`; the observed approval path may emit only a `Notification`.
- **`SubagentStop` should be ignored** so a sub-droid finishing can't flip/notify the parent.
- **`Notification` prompt forced to `''`** so status copy doesn't overwrite the cached user prompt.
- **Nerd-font / animations** may need disabling (`nerdFont`, `logoAnimation`) for clean web xterm rendering.

## 14. Failure, exit & recovery

- **Crash / exit detection:** `exec` exit codes — **`0`** success, **`1`** general runtime error, **`2`** invalid CLI args; exec also returns **non-zero on permission-violation / tool error / unmet objective** with fail-fast (no partial changes). The JSON result's **`is_error` + `subtype`** distinguish failure class from clean completion. The `SessionEnd` hook `reason` distinguishes `clear` / `logout` / `prompt_input_exit` / `other`. For the TUI, repeated-Ctrl+C exit is normal PTY teardown — do not treat it as an interrupted turn. *(established method)*
- **Reattach-after-restart healing:** Generic — reconcile tmux/abduco masters; treat "exited-but-alive" rows by checking the master is still alive (don't mark a live session exited on orchestrator restart); reap orphan/zombie attach clients by explicit PID. Droid itself has no special healing; re-enter via `--resume` / `-s` and SIGWINCH-nudge. On reattach, `SessionStart` clears the turn cache and emits no state so a healed-but-idle pane isn't shown as working. *(established method)*
- **Error surfacing:** Error state comes from the SDK `error` event, hook **exit-2 stderr** (shown to Droid/user), `exec` non-zero exit + `is_error`, and **Rate-Limit** errors on `/limits` exhaustion. Surface a hook-install error when `~/.factory/settings.json` is unparseable. Logs at `~/.factory/logs/droid-log-single.log`, `bash-command-log.txt`, and `FACTORY_LOG_FILE`. *(established method)*
  - **Conflicts / open questions:** `normalizeDroidEvent`-style state reducers emit only `working|waiting|done` from hooks (no `error`/`blocked` from the hook stream alone) — derive `error` from `exec` exit / SDK `error` event rather than from hooks.

## 15. Remote / transport

- **Supported transports:**
  - **Local** — PTY (TUI) or direct exec.
  - **SSH / remote worktree** — generic: run `droid` / `droid exec` over SSH in a remote PTY.
  - **Daemon-subprocess** — the TS SDK spawns `droid` as a subprocess and talks JSON-RPC over stdio (ideal for a daemon-hosted relay).
  - **Factory-native remote machines** — `droid computer register/remove/list/ssh` + `droid daemon` (BYOM, "Bring Your Own Machine"): Droid can target registered remote machines natively. *(established method)*
  - **Conflicts / open questions:** How Factory's native BYOM remote-machine concept composes with an external orchestrator's own relay is unverified.
- **Forwarding PTY/git/fs + instrumentation over a relay:** Generic — PTY bytes + SIGWINCH over the relay; git/fs ops run wherever Droid runs (`--cwd` / worktree). **Hook HTTP callbacks need the injected port/token reachable from where Droid runs** — forward/tunnel for remote sessions (or stamp the connection id on receive). For remote, **prefer `droid exec -o stream-jsonrpc`** (structured, no PTY) over driving the TUI across the relay. *(established method)*
- **Limitations:** Keyring-based auth is host-local — a remote host needs its own login or `FACTORY_API_KEY` / `FACTORY_TOKEN`. Hook callbacks across a remote boundary need network reachability.

---

## Open questions / unverified

These could not be confirmed against a live binary or real on-disk files; re-check on a real install (`droid --help`, `droid exec --help`, `droid --version`, and inspect `~/.factory/{settings.json,config.json,mcp.json,projects/*/*.jsonl,logs/*}`):

1. **Ctrl+C semantics (highest priority).** Does Ctrl+C interrupt the current turn, or only exit on repeat? Sources conflict directly. Verify byte-level; until then prefer Esc (TUI) and the SDK/JSON-RPC interrupt (headless), and do not assume a `Stop` hook fires on interrupt (an idle "waiting for your input" `Notification` may appear instead).
2. **Session-id format** — UUID vs `session-<rand>`; treat as opaque.
3. **`<project>` directory-name encoding** under `~/.factory/projects/` (slug vs hash of repo path).
4. **Second transcript root** — whether `~/.factory/sessions/*.jsonl` exists in addition to `~/.factory/projects/*/*.jsonl` (scan both).
5. **Keyring fallback-file path** (when `FACTORY_DISABLE_KEYRING=1`).
6. **Config-dir override env** (does a `FACTORY_HOME` analogue exist, or is `HOME` redirection the only isolation lever?).
7. **Resume state fidelity** — whether model / cwd / `--auto` survive `--resume`/`-s` natively (re-supply them defensively).
8. **Session-file locking** against concurrent writers.
9. **Exact key bytes** for shortcuts and menu navigation (especially Alt/Meta combos and approval-menu selection).
10. **Composer paste-ready signal** and the exact dim-placeholder sequence.
11. **OSC JSON status channel** — whether one exists beyond the plain window title (assume not).
12. **Full transcript JSONL schema**, including cache/reasoning token sub-fields, and on-disk representation of pasted images / thinking blocks / redacted entries.
13. **`/rename` title metadata** on-disk location (server-side vs sidecar).
14. **`-r` overload resolution** (which `-r` wins) — mooted by always using long forms.
15. **Orchestrator-readable usage/quota endpoint** — any local file or `api.factory.ai` endpoint for remaining quota.
16. **Pasted-image on-disk representation** and whether `exec` supports image input.
17. **BYOM remote-machine composition** with an external relay.
18. **Trust/onboarding markers** — the definitive set of `settings.json` keys that mark a profile "already onboarded," and the exact trust-prompt bytes.
19. **Version thresholds** for `exec` / `stream-jsonrpc` / hooks / `--session-id` / SDK, and the `--version` output format.
