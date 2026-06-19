# Amp (Sourcegraph) — orchestrator integration reference

Target CLI: **Amp** (`amp`), the coding agent from Sourcegraph / Amp Code. Facts are grounded in the official Amp Owner's Manual (<https://ampcode.com/manual>), the official CLI guide (<https://github.com/sourcegraph/amp-examples-and-guides>), and static inspection of the shipped native binary (the Bun-compiled single-binary ELF inside `@ampcode/cli-linux-x64`; literals — env vars, path-join expressions, flags, subcommands — are intact in the minified-but-not-stripped bundle). Each answer enumerates viable methods and tags them **established** / **fallback** / **not supported**. Where direct on-host verification was not possible, items are tagged **UNVERIFIED**. Discrepancies are called out under "Conflicts / open questions" within a section.

Amp uses three separate XDG roots — **config** `~/.config/amp/`, **data** `~/.local/share/amp/`, **cache** `~/.cache/amp/` — relocatable via `$XDG_CONFIG_HOME` / `$XDG_DATA_HOME` / `$XDG_CACHE_HOME` (the basis of per-account isolation, §4). A fourth, `$AMP_HOME` (default `$HOME/.amp`), governs only the install-script binary location, not config/data/cache.

Key on-disk layout (resolved from binary path-join expressions + docs):
- Settings: `~/.config/amp/settings.json` (`$XDG_CONFIG_HOME ?? ~/.config` + `amp/settings.json`); overridable with `--settings-file` / `AMP_SETTINGS_FILE`.
- Credentials/data: `~/.local/share/amp/` holding `secrets.json` (credentials) and `device-id.json` (install identity).
- Threads/logs/cache: `~/.cache/amp/logs/` holding `cli.log` and `threads/<threadId>/` (per-thread `thread.json` + `thread-actors.json`).
- Plugins: project `.amp/plugins/*.ts` and system `~/.config/amp/plugins/*.ts`.

---

## 1. Discovery & identity

- **Binary detection (established):** command name is `amp` (npm `bin: { amp: ... }` in both the compatibility alias package `@sourcegraph/amp` and the active `@ampcode/cli`). "Installed?" = `amp` resolvable on PATH. Install paths: install-script default `~/.local/bin/amp` (skipped when `$AMP_HOME` is set — binary literal "AMP_HOME detected - skipping installation of ~/.local/bin/amp"), or an npm global. No alias/remap is needed beyond knowing the npm package was renamed `@sourcegraph/amp` → `@ampcode/cli` (the alias still resolves). A bare PATH probe of `amp` is the established install check; `amp doctor` is a deeper self-check.
- **Version detection (established):** `amp --version` / `-V`. The version string is a build-timestamp form, e.g. `0.0.1781836651-g5bbf05`; an internal `AMP_SDK_VERSION` also exists. **Do not version-gate flags.** Amp auto-updates aggressively (`amp.updates.mode` ∈ `auto`/`warn`/`disabled`, env `AMP_SKIP_UPDATE_CHECK`), so the binary is a moving target — pin with `AMP_SKIP_UPDATE_CHECK=1` for the lifetime of a managed session rather than branching on semver.
- **Existing-session discovery (established):** sessions are "threads", discoverable two ways. (1) **On-disk:** per-thread directories under `~/.cache/amp/logs/threads/<threadId>/`, each with `thread.json` (the conversation) and `thread-actors.json`. Glob: `~/.cache/amp/logs/threads/*/thread.json`. (2) **Service / CLI:** `amp threads list` ("List all your threads…"); threads also live server-side at `https://ampcode.com/threads/T-<uuid>`. Local-disk is the preferred discovery path for an orchestrator (no network), with `amp threads list` as the cross-machine fallback.
- **Stable session identity (established):** a **thread ID** of the form `T-<uuid>` (e.g. `T-019cafea-01eb-70a9-…`), referenced in prompts as `@T-<uuid>` and at `https://ampcode.com/threads/T-<uuid>`. Obtaining it:
  - *At launch:* `amp threads new` (or `amp threads new -x "…"`) creates a thread and prints its id; the running process also exposes it via env `AMP_THREAD_ID` / `AMP_CURRENT_THREAD_ID`.
  - *In structured output:* `--stream-json` emits the id as `thread_id` (a `sessionId` field also appears in the bundle).
  - *For a pre-existing session:* the directory name under the threads dir, or a row from `amp threads list`.
- **Session ↔ repo/worktree/cwd (established + UNVERIFIED detail):** mapping is by **cwd at launch** — the CLI runs in the working dir, and `AMP_PWD` captures it. Threads additionally carry git linkage via an `Amp-Thread:` commit trailer (`amp.git.commit.ampThread.enabled`, default on), so thread→repo can be recovered by correlating the trailer. Whether the launch cwd is persisted as a field inside `thread.json` is **UNVERIFIED** — confirm against a real `thread.json`.

**Conflicts / open questions:** thread id can be sourced from any of the on-disk dir name, `amp threads list`, the thread URL, env `AMP_THREAD_ID`, or stream-json `thread_id` — all valid; prefer on-disk + env for a managed launch. Exact `thread.json` cwd/repo field names are unverified.

## 2. Launch & process model

- **Spawn mechanism (established):** direct exec of the native `amp` ELF (a Bun-compiled single binary; the npm `@ampcode/cli` wrapper resolves the per-platform native package and `spawnSync(binary, argv, {stdio:'inherit'})`). For an **interactive TUI**, spawn under a PTY (hosted locally, over SSH, or by a daemon-held master). For **one-shot** work, exec directly with stdin/stdout pipes (§12). Amp has no built-in daemon/detach.
- **Launch command (established):** interactive `amp`; with an initial prompt `amp -x "<prompt>"` or `amp threads new -x "<prompt>"`.
- **Env Amp reads (established, from the bundle):** `AMP_API_KEY` (auth), `AMP_URL` (service base, default `https://ampcode.com`), `AMP_SETTINGS_FILE`, `AMP_HOME`, `AMP_PWD`, `AMP_THREAD_ID` / `AMP_CURRENT_THREAD_ID`, `AMP_EXECUTOR`, `AMP_LOG_LEVEL` / `AMP_LOG_FILE` / `AMP_MAX_LOG_FILE_SIZE`, `AMP_SKIP_UPDATE_CHECK`, `AMP_DEBUG`, `AMP_DISABLE_PLUGINS`, `AMP_DISABLE_SECRET_REDACTION`, `AMP_RIPGREP_PATH`, `AMP_GITHUB_TOKEN`, `AMP_REMOTE_CONTROL_TERMINAL`, `AMP_FORCE_BEL`, `NO_ANIMATION`, the `XDG_*` roots, plus provider keys (e.g. `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`).
- **Env to strip (established):** to force Amp through its own gateway with orchestrator-managed auth, strip provider keys (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, etc.) and leave only `AMP_API_KEY`. Leave `AMP_DISABLE_SECRET_REDACTION` **unset** so secrets stay redacted in transcripts. For multi-account, additionally point `$XDG_CONFIG_HOME`/`$XDG_DATA_HOME`/`$XDG_CACHE_HOME` (or `AMP_SETTINGS_FILE`) at the account's dir (§4).
- **Durable backing (fallback):** none built in — Amp is a single process with no tmux/abduco equivalent. Survival across orchestrator restart = a generic multiplexer (tmux/abduco) or a daemon-held PTY master, **plus** Amp's own resume (`amp threads continue`, §3), since threads persist on disk and server-side.
- **Initial-prompt injection (established, multiple modes):**
  - **flag/argv (established, one-shot):** `-x` / `--execute "<prompt>"` — runs and exits.
  - **stdin (established, one-shot):** piping auto-enables execute mode when stdout is redirected — `echo "…" | amp`, `amp < prompt.txt`.
  - **stream-json stdin (established):** `amp -x --stream-json --stream-json-input` reads JSON-Lines user messages from stdin (`--stream-json-input` = "Read JSON Lines user messages from stdin").
  - **type-after-ready (established, interactive):** for an interactive PTY, bracketed-paste the prompt then send a separate CR. This is the safest interactive path because `-x` exits after answering. Mechanics: wrap payload in `\x1b[200~` … `\x1b[201~`, then Enter (`\r`) after a short post-paste settle. Amp publishes no explicit paste-ready signal, so gate on a render-quiet heuristic after the bracketed-paste echo / process readiness.
- **First-run / trust handling (established):** **no per-directory "trust this folder" gate** like Claude Code. The only first-run gate is **auth** (`amp login` or `AMP_API_KEY`). Tool execution is the confirmation surface — bypass with `--dangerously-allow-all` (flag) or `amp.dangerouslyAllowAll: true` (settings). Pre-seed by writing `~/.config/amp/settings.json` and providing `AMP_API_KEY` so nothing blocks the first prompt.
- **Permission / YOLO / sandbox (established):** YOLO = `--dangerously-allow-all` ("Disable all command confirmation prompts") / settings `amp.dangerouslyAllowAll`. Fine-grained: `amp.permissions` rules (subcommands `amp permissions list|test|edit|add`), `amp.guardedFiles.allowlist`, `amp.tools.disable` (e.g. `"builtin:<tool>"`). **No OS-level sandbox** flag (no seatbelt/landlock jail) — Amp relies on permission prompts, not a kernel sandbox.
- **Model / reasoning-effort / fast-mode at launch (established for modes, UNVERIFIED as a launch flag):** Amp has **no `--model` flag** (none in the bundle — do not pass one). Model choice is abstracted as **agent modes**: `deep` (extended-thinking frontier model), `smart`/`frontier` (state-of-the-art), `rush` (fast, no reasoning). Mode is normally selected at runtime (Ctrl+S, or Ctrl+O palette → `mode`) and persisted; settings `amp.agent.deepReasoningEffort`, `amp.anthropic.effort`, `amp.anthropic.provider` tune it. **Fast mode** = `rush` mode (also an Alt+R runtime toggle). To pin a mode at launch, set it in settings via `--settings-file`, or use mode-scoped continue ("Continue the last thread for the current mode"). **There is no documented launch flag to pin a mode — launch-time mode selection is config/settings-based.**

**Conflicts / open questions:** for a *headless* one-shot, mode/effort can be supplied as flags `--mode <model>` and `--effort <level>` (used by automated commit-message generation; see §12); for the *interactive* TUI no such flag is documented and mode pinning is settings-based. Treat `--mode`/`--effort` as headless-only until verified on the interactive path.

## 3. Resume & reattach

- **Resume support (established):** yes. `amp threads continue [threadId]` ("Continue an existing thread by resuming the conversation"); `amp threads continue` with no id continues the last thread; `amp threads continue --last` continues the last thread directly; "Continue the last thread for the current mode" is mode-scoped. Append `-x "<msg>"` to push a message into the resumed thread non-interactively. `amp threads fork [threadId]` branches a copy. The id comes from `amp threads list`, the thread URL, the on-disk dir name, or `AMP_THREAD_ID`/`thread_id` from a prior run.
- **State restored vs lost (established + UNVERIFIED detail):** full conversation history is restored (server-side + `thread.json`); agent mode is restored ("for the current mode"). **cwd is not part of the thread** — relaunch in the same directory. Permissions come from current settings, not the thread. Whether cwd is persisted per-thread is **UNVERIFIED**.
- **Reattach to a still-running PTY (fallback):** no Amp-native reattach — use a generic multiplexer (tmux/abduco) or daemon-held PTY master. After reattach, a **SIGWINCH redraw nudge** repaints the full-screen alt-screen TUI. For a process that has already exited, do **not** reattach — respawn with `amp threads continue <id>` (history is preserved on disk/server).
- **Idempotency / race hazards (established):** "Execute mode can only resume one thread" — do not fire two concurrent `-x` continues against the same thread. Auto-update can swap the binary between runs (`AMP_SKIP_UPDATE_CHECK=1` to pin during a session). Decide reattach-vs-respawn by **liveness** (PTY master alive?) so a still-running thread is never marked exited.

## 4. Auth & subscription

- **Credential location(s) (established):** `amp login` stores credentials in `~/.local/share/amp/secrets.json` (data dir). An optional OS-keyring path exists: setting `amp.experimental.cli.nativeSecretsStorage.enabled` + env `AMP_KEYRING_ENTRY_CLASS__` → a libsecret/Keychain-style entry instead of plaintext `secrets.json`. Non-interactive: env `AMP_API_KEY` (a token minted at `https://ampcode.com/settings`). `~/.local/share/amp/device-id.json` identifies the install.
- **Reuse model (established):** **spawn-and-let-CLI-auth** is the simplest path (the CLI reads `secrets.json`/keyring). For orchestrator-managed multi-account, the cleanest contract is to **inject `AMP_API_KEY` per spawn** (it overrides file creds) and/or point the `XDG_*` roots / `AMP_SETTINGS_FILE` at a per-account dir. Amp routes through its own single gateway via `AMP_API_KEY`, so there is **no need to capture per-provider OAuth**.
- **Token refresh (established):** `AMP_API_KEY` is a long-lived access token (no orchestrator-side rotation). Interactive `amp login` uses an OAuth-ish browser/device flow (binary has `AMP_HEADLESS_OAUTH`, `AMP_HEADLESS_VERBOSE`, and a local callback HTTP server returning `accessToken`); the CLI handles any refresh/write-back into `secrets.json`. The orchestrator does not refresh.
- **Env hygiene (established):** strip inherited provider keys (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, …) so Amp uses its own gateway; keep only `AMP_API_KEY`. Leave `AMP_DISABLE_SECRET_REDACTION` unset.
- **Multi-account (established):** isolate each account with a distinct `AMP_API_KEY` and/or separate `$XDG_DATA_HOME`/`$XDG_CONFIG_HOME`/`$XDG_CACHE_HOME` (so `secrets.json`, settings, and threads don't collide). No built-in account-switch command was observed — isolation is via env.

## 5. Models, usage & accounting

- **Model listing for a settings UI (established):** **no `amp models` / `--list-models` subcommand.** Models are abstracted behind agent **modes** — `deep`, `smart`/`frontier`, `rush` — and the full model set lives on the service (`/models` page). **Expose the three modes, not raw model IDs**, in a settings UI; there is no stable user-facing model-list API in the CLI. A static mode list usable for automated/headless work: `smart` (default), `rush`, `large` (thinking levels, default low), `deep` (thinking levels, default low). Any concrete provider/model-ID catalog (e.g. specific Claude/GPT/Gemini ids) is third-party reverse-engineered and **will drift** — do not hard-code it.
- **Runtime switching (established):** yes — agent mode at runtime via **Ctrl+S** or **Ctrl+O → `mode`**; **Alt+R** toggles fast mode; **Alt+D** toggles reasoning effort. Programmatically from the orchestrator: send those key bytes into the PTY, or set the mode in `--settings-file` before launch. No mid-session JSON command for model switch was found.
- **Usage windows / quota / rate-limits (established + UNVERIFIED shape):** `amp usage` reports the **credit balance**; the web `/settings` page mirrors it. Amp is **credit-based pay-as-you-go** (USD credits, $5 minimum, expire after ~1 yr inactivity) — *not* a fixed rate-limit window, so "remaining quota" = remaining credit. Read via `amp usage` (parse stdout) or the service API. The machine-readable shape of `amp usage` output is **UNVERIFIED**.
- **Token accounting (established + partially UNVERIFIED):** per-turn token counts are present in the stream — the bundle carries `inputTokens` / `outputTokens`, and `thread.json` persists the conversation. `--stream-json-thinking` adds thinking blocks. Exact result-summary field names (cache tokens, cost) are **not fully confirmed** — for analytics, parse `--stream-json` output and/or `thread.json`.
- **Pricing / cost (established):** cost is computed and shown in-CLI — setting `amp.showCosts` (default true) renders cost per turn/thread; `amp usage` shows the credit balance. Pricing = actual LLM+tool cost passed through (at cost for individuals/teams, +50% for Enterprise per docs). **No static per-model rate card** ships in the CLI; cost comes from the service.

**Conflicts / open questions:** for headless model selection only, flags `--mode <model>` / `--effort <level>` exist; there is no interactive `--model` flag and no `--list-models`. The exact `amp usage` and `--stream-json` result/usage/cost field names need on-host confirmation.

## 6. Driving & input — two-way control

- **Send a new user message mid-session (established, multiple transports):**
  - **Interactive PTY (established):** type into the composer + Enter to submit. Multi-line: **Ctrl+J** (newline, works in any terminal) or **Shift+Enter** (terminal-dependent); submit is plain **Enter**. `Enter Enter` queues a message to send when the agent is done. For an orchestrator: bracketed-paste the text, then send a separate CR (standard TUI-safe pattern).
  - **Non-interactive (established):** `amp threads continue <id> -x "<msg>"`.
  - **stream-json stdin (established):** write JSON-Lines to the stdin of `amp -x --stream-json --stream-json-input`, e.g. `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`.
- **Read the current input-box contents / draft sync out (fallback):** no API/OSC for composer contents — **screen-scrape the alt-screen composer line** is the only method. Dim-placeholder behavior is not separately documented.
- **Pre-fill / set the input box / draft sync in (fallback):** no flag or env pre-seeds the composer for an *interactive* session; only `-x`/stdin deliver a full message. To prefill an interactive composer, type the bytes into the PTY without a submit CR. `Ctrl+G` / `/editor` opens `$EDITOR` for long prompts (an indirect route).
- **Answer interactive prompts / permission menus (established mechanism, UNVERIFIED bytes):** tool-confirmation and AskUser prompts are answered in the TUI (arrow/number keys + Enter, or y/n style — **exact bytes UNVERIFIED**). To avoid prompts entirely, run with `--dangerously-allow-all` or pre-seed `amp.permissions`. Detect a pending prompt by screen-scraping (no event channel surfaces a distinct "waiting on user" state by default — see §7).
- **Interrupt / cancel (established):** **`Esc Esc`** = force-stop the agent (send immediately) — the interrupt-current-turn key is **double-Esc**. `Ctrl+C Ctrl+C` = quit; `Ctrl+C Ctrl+N` = archive thread + new; `Ctrl+C Ctrl+E` = archive + quit. After cancellation, a clean stream/event run reports cancellation in its end record.
- **Slash commands (established):** `/editor`, `/agent` (generate AGENTS.md), `/compact`, `/help`, `/quit`. Command palette via **Ctrl+O** (modes, plugins reload, skills list, IDE connect, thread archive/visibility, etc.).
- **Attachments / large paste (established):** images via **Ctrl+V** (clipboard) or `@path` to a file; files mentioned with `@` fuzzy search; other threads with `@@` or `@T-<uuid>`. Large content: paste, or `Ctrl+G` editor.
- **Important keyboard shortcuts & modifier keys (established) — surface these on a mobile soft-keyboard:**
  - Submit = **Enter**; newline = **Ctrl+J** (universal) or **Shift+Enter**.
  - Interrupt = **Esc Esc**; quit = **Ctrl+C Ctrl+C**.
  - History: **Ctrl+R** (prompt history), **↑/↓** (navigate/edit prior messages), **Tab** (prior messages), **e** (edit prior).
  - Command palette = **Ctrl+O**; switch mode = **Ctrl+S**; expand thinking/tools = **Alt+T**; toggle reasoning = **Alt+D**; toggle fast mode = **Alt+R**.
  - Mention = **@**; editor = **Ctrl+G**.
  - **Alt/Meta fidelity is required** for `Alt+T` / `Alt+D` / `Alt+R` — ensure Option/Alt → ESC-prefixed bytes round-trip on mobile.

## 7. Agent-state classification

- **State vocabulary (established):** Amp exports no documented state enum. Map into the orchestrator's generic set `working | waiting-on-user | done | error` (+ `interrupted`). In practice, when state is derived purely from in-process plugin events (§8), only `working` and `done` are cleanly produced (plus `interrupted` on cancel); `waiting-on-user`/`error` require richer signals (screen-scrape or stream-json inspection).
- **Signal sources & authority rank:**
  1. **Plugin events (established, highest authority when a plugin is installed):** an in-process TS plugin (§8) subscribes to `session.start`, `agent.start`, `agent.end`, `tool.call`, `tool.result` and POSTs them to an orchestrator endpoint. `agent.start`/`tool.call`/`tool.result` → `working`; `agent.end` → `done` (cancelled end → `interrupted`). This is the recommended authoritative channel and the lowest-latency one.
  2. **`--stream-json` events (established, for headless/scripted runs):** message/tool/result lines; a `result` line and `is_error` distinguish clean completion from error.
  3. **Transcript tail (established):** `~/.cache/amp/logs/threads/<id>/thread.json` growth.
  4. **Process exit (established):** a one-shot `-x` process exits when done.
  5. **Output activity / TUI screen-scrape (fallback, lowest authority):** for interactive sessions with no plugin.
  - **Not supported:** no HTTP stop-hook channel exists natively (the plugin is what supplies one); **no OSC JSON status channel**; Amp does not emit an OSC title that classifies state.
- **Event → state mapping (established/derived):** `agent.start` / `tool.call` / `tool.result` → `working`; a visible permission/confirmation prompt → `waiting-on-user`; `agent.end` / `-x` exit 0 / `result` line → `done`; `is_error` / nonzero exit / error line → `error`; double-Esc → `interrupted`. `session.start` is a turn/thread boundary (no visible state).
- **"Stopped but needs user" vs done (fallback):** distinguish by detecting a confirmation/AskUser prompt on screen (or a tool awaiting permission) versus a clean `result`/exit. With plugin-only signals this is *not* distinguished (everything non-terminal is `working`, the end is `done`); to get a true `waiting-on-user` you must screen-scrape or inspect stream-json. Running with `--dangerously-allow-all` removes the prompts (and the ambiguity) entirely.
- **Reconciliation (established/generic):** prefer the highest-authority live signal; debounce output-activity; apply stickiness so a brief idle between tools doesn't flip to `done`. When multiplexing multiple threads through one pane, key state caches per `threadId` and bound them (e.g. retain only the most-recent N thread scopes) so concurrent threads don't clobber each other; drop late fire-and-forget tool events that arrive after that thread's `agent.end`.
- **Sub-agent / nested state (established):** Amp spawns **subagents** autonomously (including an "Oracle" subagent) that run in isolation and return only a summary to the parent thread. Subagent activity surfaces as the parent being `working`; no separate per-subagent identity/state stream is documented.
- **Latency (established):** plugin events are in-process (fast); stream-json is line-buffered (near-real-time); screen-scrape/output-activity is slowest and noisiest.

**Conflicts / open questions:** the authoritative status path is plugin events, but a plugin-only classifier collapses `waiting-on-user` and `error` into `working`/`done`. For full fidelity, combine plugin events with stream-json (`is_error`/`result`) or screen-scrape. Whether the native `amp.hooks` setting (§8) can emit status directly is **UNVERIFIED**.

## 8. Hooks & instrumentation install

- **Mechanism (established):** **in-process TypeScript plugins** (run under Bun). A plugin is a `.ts` file exporting a default function that receives a `PluginAPI` and can `amp.registerTool(...)`, `amp.registerCommand(...)`, subscribe to events via `amp.on('session.start' | 'agent.start' | 'agent.end' | 'tool.call' | 'tool.result', …)`, show UI (notifications/confirm/input/select), call `amp.ai.ask(...)`, and create custom agents (`amp.experimental.createAgent`). This is the authoritative instrumentation channel feeding §7. There is **also** a separate `amp.hooks` settings key ("Custom hooks for extending Amp functionality") — its event names are **UNVERIFIED**; prefer the plugin API.
- **Install location / trust (established):** plugins live in **`.amp/plugins/*.ts`** (project) or **`~/.config/amp/plugins/*.ts`** (system). **No hash-allowlist trust file** (unlike Claude/Codex settings-hook trust entries) — plugins are trusted by location and auto-loaded from those dirs. `AMP_DISABLE_PLUGINS` is the kill-switch; `AMP_PLUGIN_RUNTIME_LOG_FILE` logs runtime; `AMP_PLUGIN_URI` / `AMP_PLUGIN_SOURCE_BASE` configure sourcing. Reload at runtime: **Ctrl+O → `plugins: reload`**. A managed orchestrator plugin should mark ownership (e.g. a "managed; do not edit" header) and refuse to clobber an unmanaged user plugin at the same path.
- **Hook event taxonomy + payload fields (established names, UNVERIFIED exact shapes):** `session.start` (thread id), `agent.start` (thread id + message), `agent.end` (thread id + message + status), `tool.call` (thread id + tool name + input; the handler can return an allow/deny action), `tool.result` (thread id + tool name + input + status/error/output). Extract: tool name (`tool`/`toolName`/`name`), tool input (`input`/`tool_input`/`arguments`, with a generic fallback since plugin tool names are arbitrary), and the last assistant message text from `agent.start`/`agent.end` `message` or from `tool.result` `error`/`output`/`result`/`message` (the `tool.result` `message` is *output text*, not a user prompt). Sanitize/bound payloads before forwarding (depth/length caps).
- **Transport back to the orchestrator (established):** the plugin runs in-process, so it can **POST to an injected orchestrator HTTP endpoint** (read port + auth token + a pane/session identifier from env vars the orchestrator injects), or append to a file/socket. **Fail-open:** wrap callbacks in try/catch (and a short abort timeout + a small bounded queue) so plugin/HTTP errors never block or kill the Amp run; warn-once on transport errors and otherwise stay silent. Re-resolve the endpoint per event (e.g. read an endpoint file each event before env fallback) so a thread that **outlives an orchestrator restart** keeps reporting after the endpoint is rewritten. `AMP_DISABLE_PLUGINS` is the hard kill-switch.
- **Lifecycle (established):** install = drop the `.ts` into the plugins dir (idempotent by filename; atomic write; no-op if identical); update = overwrite + Ctrl+O reload; uninstall = remove the file (only ever remove a managed file). Status can be modeled as `not_installed | installed | partial | error` with a completeness check that the managed file still contains all required handlers (downgrade to `partial` on drift). Version-skew: the plugin API is `experimental` in places — re-validate after Amp auto-updates.

**Conflicts / open questions:** two extension surfaces exist — the documented **plugin** API (`amp.on(...)`, the recommended path) and an undocumented **`amp.hooks`** settings key. Use plugins; treat `amp.hooks` as unverified.

## 9. Session titles

- **Source of truth (established + UNVERIFIED field):** **agent/LLM-generated thread title** — Amp generates a title server-side from the conversation, shown in `amp threads list` and the web feed. The local `thread.json` should carry the title (field name **UNVERIFIED**). No reliance on an OSC title is needed (the CLI may set the terminal title via `process.title`/setTitle — present in the bundle — but the durable title is the thread's). There is **no synthetic working/idle/permission title profile** keyed off Amp events.
- **Read / update (established):** read from `thread.json` (or `amp threads list`); the title updates as the agent generates/refines it. Eventing = tail `thread.json` or poll `amp threads list`.
- **Fallback (established/generic):** if no generated title yet, fall back to first-prompt truncation (first clause / word-boundary cut); otherwise the agent label "Amp".

**Conflicts / open questions:** when classification is driven only by live in-process events with no transcript read, the practical title source degrades to first-prompt truncation (no live title eventing). With on-disk `thread.json` access, the agent-generated title is available — prefer it. Exact title field name in `thread.json` is unverified.

## 10. Transcript & history

- **Storage (established):** per-thread directory `~/.cache/amp/logs/threads/<threadId>/` containing **`thread.json`** (the conversation, a single JSON document — **not** JSONL) and `thread-actors.json`; plus `~/.cache/amp/logs/cli.log`. One `thread.json` per thread.
- **Parsing / schema (established + UNVERIFIED details):** `thread.json` holds the message list (roles user/assistant, tool calls/results, thinking, token counts `inputTokens`/`outputTokens`). The exact schema is **not published** — derive it from a real `thread.json` on a host with Amp installed. The **`--stream-json`** format is the documented, Claude-Code-compatible event stream and the more reliable parse target for live work: user/assistant/tool messages, `--stream-json-thinking` for thinking blocks, a `result` summary, and `thread_id`/`sessionId` fields. (A `--stream-jsonl` variant is also present.)
- **Live tail vs historical (established):** historical = read `thread.json`; live = consume `--stream-json` stdout (one JSON object per line) for headless runs, or tail `thread.json` for interactive. New entries detected by file growth (interactive) or stream lines (headless). For a plugin-only setup with no file read, "history" is whatever the hook plugin streams live; dedup late events in-memory per `threadId`.
- **Consumers (established):** chat view ← stream-json/`thread.json` messages; last-message/preview ← `-x` prints **only the agent's final message** (ideal for previews), or the last assistant `message` from hook events; clickable items ← tool calls + `@`-file refs + diffs in message content (and OSC 8 links the TUI emits, §11); state classification ← §7.
- **Transcript ↔ terminal mapping (established):** the interactive TUI renders the same conversation `thread.json` persists; reconcile by `thread_id`. There is no separate transcript view to keep in lockstep when running plugin-only — the terminal is the conversation surface.
- **Special content types & quirks (established + UNVERIFIED encodings):** images pasted via Ctrl+V or `@path` are stored in the thread (encoding **UNVERIFIED**); file refs are `@`-mentions; thread refs are `@@`/`@T-<uuid>`; thinking blocks are gated behind `--stream-json-thinking` / Alt+T; diffs appear as tool outputs; **secrets are redacted** unless `AMP_DISABLE_SECRET_REDACTION` is set. Live-event quirks: plugin tool names are arbitrary (use a generic input-field fallback); `tool.result` `message` is output text, not a prompt; fire-and-forget POSTs can arrive after `agent.end` (drop them).

**Conflicts / open questions:** there are two valid transcript surfaces — on-disk `thread.json` (full history, JSON, schema unverified) and the `--stream-json` event stream (documented, live, Claude-Code-compatible). A purely live, plugin-driven integration reads neither file and relies on streamed hook events only. Prefer `--stream-json`/`thread.json` when on-host access is available.

## 11. Terminal rendering & display fidelity

- **PTY → xterm (established):** Amp is a **full-screen TUI on the alt-screen**. Capture PTY bytes → stream → xterm.js with generic alt-screen handling; **do not strip the agent's own chrome** (it owns the screen). `--no-color` and `NO_ANIMATION` / `amp.terminal.theme` reduce escape noise if needed. Intercept only your own orchestrator control sequences (Amp emits none of its own status-control OSC).
- **Resize / reflow (established):** send **SIGWINCH** on cols/rows change; the TUI repaints on resize — use a SIGWINCH nudge as the post-reattach redraw. Mobile↔desktop breakpoint remount is generic.
- **Scrollback model (established):** native TUI alt-screen — the agent re-renders and owns scrollback. **Forward the mouse** so the TUI can scroll its own history; prefer the agent's own history nav (`↑/↓`, `Tab`, `Ctrl+R`) over xterm scrollback. `amp.terminal.copyOnSelect` (default on) affects selection.
- **Mouse forwarding (established):** forward scroll/click into the TUI while in alt-screen.
- **Snapshot/serialize for reattach (fallback/generic):** generic headless-xterm serialize + replay; a SIGWINCH redraw after reattach fixes a blank alt-screen (Amp has no native replay).
- **Local cache → instant render then live reconnect (fallback/generic):** persist the last serialized xterm buffer, render it instantly on return, then reconnect the live PTY and reconcile — relying on the multiplexer + serialized snapshot, since Amp provides no native replay.
- **Composer/cursor (fallback):** the composer is the TUI input line; no documented ready-signal/dim-placeholder behavior — **screen-scrape to detect readiness**, and gate bracketed-paste on a render-quiet heuristic.
- **Color / theme / OSC (established):** theming via `~/.config/amp/themes/<name>/colors.toml` + `amp.terminal.theme`; `--no-color` disables color; the TUI emits **OSC 8 (hyperlinks)** and **OSC 52 (clipboard)** (literals `]8;`, `]52;` in the bundle); `AMP_FORCE_BEL` affects the bell. **Honor OSC 8 links for clickable file refs.**

## 12. Background / headless invocation

- **Non-interactive one-shot (established):** yes — `amp -x "<prompt>"` (alias `amp --execute`) runs the agent, prints **only the final assistant message**, and exits. Structured output: `amp -x --stream-json "<prompt>"` (one JSON object per line; requires `-x`); add `--stream-json-thinking` to include thinking; a `--stream-jsonl` variant exists. Prompt delivery: flag (`-x`), stdin (`echo … | amp`, `amp < f`), or `--stream-json-input` (JSON-Lines on stdin). For headless model/effort selection, `--mode <model>` and `--effort <level>` are accepted (e.g. an automated commit-message run: `amp --execute --no-notifications --no-ide --no-jetbrains --mode <model> [--effort <lvl>]` with the prompt/diff on stdin).
- **Uses (established):** commit messages, PR titles/bodies, branch names, summaries, code review (`amp review` / `.agents/checks/`), and classification (`amp.ai.ask` from a plugin) — all viable one-shot.
- **Auth for headless (established):** `AMP_API_KEY` env (designed for CI/scripts) or an inherited `secrets.json`; no per-account env prep beyond §4.
- **Cost / latency / timeout / output caps (established):** pay-per-use credits (`amp usage`); set your own subprocess timeout; use `--dangerously-allow-all` to avoid blocking on confirmations in headless mode. Runs locally (talks to Amp's gateway); remote execution is wherever you host the binary.

**Conflicts / open questions:** the only feature observed wired to Amp's headless path in practice is automated commit-message generation (with a *static* mode list, not live discovery). The broader headless surface (`--stream-json`, PR/summary tasks) is documented but should be validated end-to-end on a host with `amp` installed.

## 13. Capabilities & quirks matrix

| Capability | Amp |
|---|---|
| Resumable | **Yes** — `amp threads continue [id]` / `--last` / `threads fork` (one thread per `-x` resume) |
| Hooks / instrumentation | **Yes** — in-process TS **plugins** (`amp.on('session.start'|'agent.start'|'agent.end'|'tool.call'|'tool.result', …)`) in `.amp/plugins/*.ts` or `~/.config/amp/plugins/*.ts`; also an undocumented `amp.hooks` setting |
| Session id captured | **Yes** — thread id `T-<uuid>`; env `AMP_THREAD_ID`/`AMP_CURRENT_THREAD_ID`; stream `thread_id`/`sessionId` |
| Draft prefill (interactive) | **None** — only `-x`/stdin deliver full messages; prefill = typed PTY bytes |
| Trust preset | **No folder-trust gate** — gate is auth + tool-confirm (`--dangerously-allow-all` / `amp.permissions`) |
| Interactive-prompt selection | **Via TUI keys** (exact bytes UNVERIFIED); bypass with `--dangerously-allow-all` |
| Title source | **Agent/LLM-generated** thread title (server + `thread.json`); first-prompt truncation fallback |
| Transcript format | **JSON** `thread.json` per thread (`~/.cache/amp/logs/threads/<id>/`) + `--stream-json` event stream |
| Headless | **Yes** — `-x` / `--stream-json` / `--stream-json-input`; `--mode`/`--effort` for headless model selection |
| Model listing | **No CLI list** — abstracted as modes `deep` / `smart`(`frontier`) / `rush`; no `--model` flag |
| Usage / quota | **Credit balance** via `amp usage`; cost via `amp.showCosts` (default on) |
| Fast mode | **Yes** — `rush` mode + **Alt+R** toggle |
| Prompt injection mode | argv `-x` (one-shot) / stdin / `--stream-json-input`; interactive = type-after-ready bracketed paste |
| YOLO arg | `--dangerously-allow-all` (settings `amp.dangerouslyAllowAll`) |
| State vocabulary | `working`, `done` from plugin events (+ `interrupted` on cancel); `waiting-on-user`/`error` need stream-json/screen-scrape |
| OSC quirks | Emits OSC 8 (hyperlinks) + OSC 52 (clipboard); honor OSC 8 for clickable refs; no status-control OSC |

**Known special-cases & workarounds:**
1. npm package renamed `@sourcegraph/amp` → `@ampcode/cli` (alias still works) — detect either.
2. Native single-binary (Bun-compiled, ~111 MB, per-platform via optionalDependencies) — `--ignore-scripts`/`--omit=optional` breaks the postinstall that places the binary; a `cli-wrapper.cjs` fallback exists.
3. **No `--model` flag** — drive model via modes/settings; do not pass `--model`.
4. Aggressive auto-update — pin with `AMP_SKIP_UPDATE_CHECK=1` / `amp.updates.mode:"disabled"` for a managed session.
5. "Execute mode can only resume one thread" — don't run concurrent `-x` continues on the same thread.
6. Three XDG roots — threads under **cache** (`~/.cache/amp/logs/threads`), creds under **data** (`~/.local/share/amp/secrets.json`), settings under **config** (`~/.config/amp/settings.json`); isolate accounts by overriding all three XDG vars.
7. Plugins trusted by **location** (no hash-allowlist); re-resolve the callback endpoint per event so a thread surviving an orchestrator restart keeps reporting; mark managed plugins and refuse to clobber unmanaged ones; bound per-`threadId` caches and drop post-`agent.end` tool events when multiplexing threads through one pane.

## 14. Failure, exit & recovery

- **Crash / exit detection (established):** a one-shot `-x` exits 0 on success, nonzero on error; `--stream-json` `result` / `is_error` distinguishes clean completion from error. An interactive crash = PTY EOF + nonzero exit. The clean completion signal in the event stream is `agent.end` → `done` (cancelled end → `interrupted`). There is no Amp-specific exit-code taxonomy beyond zero/nonzero. Diagnostics: `~/.cache/amp/logs/cli.log` (and `AMP_LOG_FILE` / `AMP_LOG_LEVEL`, levels error/warn/info/debug/audit); `amp doctor` / `amp mcp doctor` for self-checks.
- **Reattach-after-restart healing (established/generic):** no native daemon — heal via multiplexer liveness check; if the PTY master is gone, **respawn with `amp threads continue <id>`** (history preserved on disk/server), don't mark the thread dead just because the process exited. Reap orphaned `amp` processes by PID. On the plugin side, the per-event endpoint re-read lets a surviving Amp process keep reporting after an orchestrator restart.
- **Error surfacing (established):** surface nonzero exit, `is_error` in stream-json, `tool.result` `error`/`status`, `agent.end` `status`, and `cli.log` errors as the error state. Surface **auth failures** (missing/invalid `AMP_API_KEY`) and **out-of-credit** (`amp usage` = 0) distinctly — they are the common blockers. There is no dedicated Amp `error` agent-state in plugin events; the error text rides along as the last assistant/tool message.

## 15. Remote / transport

- **Supported transports (established + generic):** **local** exec; **SSH** to a remote worktree (run `amp` there, forward the PTY); **daemon-subprocess** (orchestrator spawns `amp` as a child) — all generic, no Amp-specific limitation. Amp also has its **own** remote-control feature: continue a CLI session from web/mobile (env `AMP_REMOTE_CONTROL_TERMINAL`; "Continue CLI sessions on web", enable Sudo) and `amp connect` / IDE connect. An orchestrator can either ignore this (drive the PTY itself) or interoperate with it.
- **Forwarding of PTY/git/fs + instrumentation callbacks (established):** PTY bytes over the relay (xterm); git/fs ops run **where `amp` runs**, so prefer co-locating `amp` with the repo. The plugin callback (§8) reaches the orchestrator over an injected HTTP endpoint / file / socket — for remote sessions, tunnel the callback port or write to a file/socket on the remote and relay it; the plugin should echo the orchestrator-injected pane/session identity env so a remote-ingested event resolves to the right pane. The plugin install is the only transport-aware step: write the managed plugin to a `~/.config/amp/plugins/<name>.ts` path locally, or push the same managed file over SFTP for remote (atomic write, with the unmanaged-file guard).

---

## Open questions / unverified

- **`thread.json` schema:** exact field names for message roles, generated **title**, per-thread **cwd**, and pasted-**image encoding** — derive from a real `thread.json` on a host with `amp` installed.
- **`--stream-json` result envelope:** exact `result`/usage/cost field names (cache tokens, cost) beyond `inputTokens`/`outputTokens` and `is_error`/`thread_id`/`sessionId`.
- **`amp usage` machine-readable shape:** is there a `--json`/structured form, and what fields (credit balance, currency, reset)?
- **Interactive permission-prompt key bytes:** the exact keys to select/confirm an AskUser or tool-confirmation menu (arrow/number/y-n).
- **`amp.hooks` settings key:** its event names and payloads (the documented, recommended channel is the plugin API; `amp.hooks` is unverified).
- **Launch-time mode pinning for the interactive TUI:** whether `--mode` works on an interactive launch or is headless-only; otherwise pin via `--settings-file`.
- **Per-thread cwd persistence:** whether the launch cwd is stored in the thread (needed for thread→repo mapping without the commit trailer).
- **Model catalog:** any concrete provider/model-ID list is third-party reverse-engineered and drifts — treat the three **modes** (`deep`/`smart`/`rush`), not raw model IDs, as the stable contract.
- **Plugin event payload shapes:** exact field schemas for `tool.call`/`tool.result`/`agent.*` — infer from the `PluginAPI` types; the API is `experimental` in places and can change across auto-updates.
