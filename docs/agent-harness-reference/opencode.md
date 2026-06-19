# OpenCode — orchestrator integration reference

> Agent CLI: **opencode** (SST, npm `@opencode-ai/opencode`), an open-source terminal AI coding agent (TypeScript + Go, runs on Bun). Verified against a locally installed native binary **v1.17.8** plus the official docs at opencode.ai/docs.
>
> **Architecture fact that drives everything below:** opencode is **client/server**. A headless server (`opencode serve` / `opencode web`) owns all agent logic, sessions, the SQLite store, and an SSE event bus + OpenAPI HTTP API; the TUI is just one client. An orchestrator can integrate at **two tiers**:
> - **(A) Server/SSE tier (preferred):** run one long-lived `opencode serve` and drive many sessions over HTTP + SSE — richer state, transcript, send, abort, title, and naturally survivable. Unusual among coding-agent CLIs.
> - **(B) PTY-TUI tier (fallback):** PTY-drive the full-screen TUI like any other harness, with an in-process plugin for state callbacks and tmux/abduco for survival.
>
> Both are documented per section where they differ. Tier A is recommended wherever a choice exists.
>
> **On-disk layout (this host):** legacy `~/.opencode/` holds the standalone binary `bin/opencode` plus a vendored `@opencode-ai/plugin` + `@opencode-ai/sdk` under `node_modules`. Active XDG data dir `~/.local/share/opencode/` holds the SQLite DB, `auth.json`, snapshots, tool-output, and logs. Config lives at `~/.config/opencode/`.

---

## 1. Discovery & identity

- **Binary detection / "installed?"** — Command name is `opencode`, no aliases. Resolve `opencode` on `PATH` first (`which opencode` / `where` on Windows). The npm/bun/pnpm (`@opencode-ai/opencode`) and brew installs drop `opencode` on PATH normally; the standalone curl installer instead puts a native ELF executable at **`~/.opencode/bin/opencode`** (not a shim/symlink). So a robust probe is: PATH → else `~/.opencode/bin/opencode` → else scan known install dirs (e.g. `~/Library/pnpm/opencode` on macOS, pnpm/bun global bins) for an unhydrated PATH. Confirm with `opencode --version`.
  - Established method: PATH lookup. Fallback: probe `~/.opencode/bin/opencode` + known install dirs.
- **Version detection / gating** — `opencode --version` prints a bare semver string (e.g. `1.17.8`). This is a **fast-moving** CLI and gating matters: the SQLite session store and several `run` flags (`--variant`, `--thinking`, `--replay`, `--attach`, `--interactive`, `--format json`) are recent. Each session row in the DB stamps the `version` that created it. **Gate feature use on detected version** where a flag may be absent.
  - Established method: parse `--version` semver and gate. (Boolean "available?" probe via `opencode --version` is the minimal fallback.)
- **Existing-session discovery (paths/globs)** — Authoritative store is **SQLite** at `~/.local/share/opencode/opencode.db` (table `session`); the DB path is printable via `opencode db path`. Enumerate via, in order of preference:
  1. `opencode session list --format json` (established).
  2. Server `GET /session` (established, requires a running server).
  3. Direct read-only `SELECT … FROM session` against the DB (fallback).
  4. **Legacy**: pre-DB versions wrote JSON/JSONL under `~/.local/share/opencode/storage/session/**` with per-message files under `storage/message/<sessionID>/*.json`. On v1.17.8 only `storage/session_diff/<sessionID>.json` and `storage/migration` remain on disk; treat JSONL as a legacy fallback (not supported / not present on current versions).
  - Data dir relocation honored via `XDG_DATA_HOME` (and `XDG_CONFIG_HOME` for config).
- **Stable session identity** — `session.id` = **`ses_<base62>`** (e.g. `ses_1256e8a64ffeIygP5d4sGxGS6c`). This is the resume id used by `--session`/`-s`. Companions: a human `slug` (e.g. `playful-cactus`) and a `title`.
  - **At launch (server tier):** create a session via the API; the id is returned and re-emitted on the SSE `session.updated` event.
  - **At launch (PTY tier):** the id is written to the DB row and, via the in-process plugin, can be learned from the first hook event carrying the **`sessionID`** field (the plugin/SDK uses `sessionID`; the DB column is `id`/`session_id`). For a pre-existing session, read `id` from `session list`/DB.
- **Session ↔ repo/worktree mapping** — Each `session` has `project_id` (FK → `project`) and a `directory`/`path` column. `project.worktree` is the absolute git root (e.g. `/home/user/src/other/podium`), `project.vcs='git'`, and `project.id` is a stable hash of the worktree (the same hash names `~/.local/share/opencode/snapshot/<projectHash>`). There is also a `workspace` table + per-session `workspace_id`. Forward map: `session → project_id → project.worktree`. Reverse map: hash/look up the matching `project.worktree` for a given cwd. For the PTY tier you can additionally inject orchestrator env coordinates (pane/tab/worktree ids) and have a plugin echo them back on every callback to tie a live session to its pane.

**Conflicts / open questions:** The two integration tiers describe the same identity (`ses_…`) but reach it differently — server returns it on creation; the plugin path surfaces it via the `sessionID` field on the first event. Exact legacy JSONL layout on pre-DB versions is unverified (not present on this host).

## 2. Launch & process model

- **Spawn mechanism / PTY host** — Three models:
  1. **TUI in a PTY (tier B):** `opencode [project]` launches the full-screen Bubbletea TUI; a shell command string is typed into a PTY (local / SSH / daemon-subprocess host). Even the local TUI starts an embedded server internally.
  2. **Headless server (tier A):** `opencode serve` — no TUI, HTTP + SSE only.
  3. **Attach:** `opencode attach <url>` runs a TUI client against an already-running (possibly remote) server.
  An orchestrator can run **one shared `opencode serve`** and drive many sessions over HTTP instead of one PTY per agent.
- **Launch command + args + env** —
  - TUI: `opencode <dir> -m <provider/model> --agent <name> --prompt "<text>" [-c | -s <ses_id>] [--port N] [--hostname H]`.
  - Server: `opencode serve --port <N> --hostname <H> [--cors <origin>…] [--mdns]`.
  - **Env honored:** `OPENCODE_CONFIG` (config file path), `OPENCODE_CONFIG_CONTENT` (inline JSON config), `OPENCODE_CONFIG_DIR` (config dir; **singular**, not a colon-list — see overlay note below), `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` (server basic-auth), provider API keys via config `{env:VAR}` substitution, and `XDG_DATA_HOME` / `XDG_CONFIG_HOME` to relocate data/config dirs.
  - **Env to strip** to pin opencode's stored OAuth account rather than an inherited key: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, etc. (config `{env:VAR}` and provider defaults can otherwise prefer an inherited key over stored OAuth — see §4).
  - **`--pure`** runs without external plugins (neutralizes user/orchestrator plugin interference during automation).
  - For tier B with a hook plugin, point `OPENCODE_CONFIG_DIR` at an orchestrator-owned config dir whose `plugins/` holds the status plugin (see §8), preserving the user's own config via symlink-mirroring.
- **Durable backing for survival** — opencode has **no built-in multiplexer**. The native durability story is the client/server split: run `opencode serve` as a long-lived daemon (e.g. systemd); sessions survive any TUI/client restart because state lives in the server + DB (tier A — preferred). For tier B you still need tmux/abduco to keep the TUI master alive.
- **Initial-prompt injection** — Multiple first-class modes; no PTY typing required:
  - `--prompt "<text>"` flag (TUI and `run`) — **established**. (POSIX single-quote / PowerShell / cmd escaping as appropriate; this rides argv on the launch command and auto-runs the turn, not a reviewable draft.)
  - `opencode run [message..]` takes the message as **positional argv**, and reads piped **stdin** as the message in non-interactive use — **established** for headless.
  - Server: `POST /session/:id/message` with the prompt in the JSON body — **established** (tier A).
  - **Fallback:** type-after-ready (bracketed paste + CR) into the PTY composer; unnecessary given the flag/argv/API paths.
- **First-run / trust handling** — **No per-directory "trust this folder" gate** (unlike Claude Code). First run prompts only for **provider auth / model**. Pre-seed by writing `auth.json` (or running `opencode auth login`) and a config with a default `model`/`agent` before launch so no interactive onboarding eats the first prompt. No trust artifact/hash needs to be pre-seeded.
- **Permission / YOLO / sandbox** — Policy-based, **not** a one-time menu and **not** an OS sandbox. Config key `permission` with per-tool values `allow | ask | deny` (e.g. `{"permission":{"edit":"ask","bash":"ask"}}`), plus per-agent permission rule arrays (visible via `opencode agent list`, which prints rules like `{"permission":"*","action":"allow","pattern":"*"}`, with special perms `doom_loop`, `external_directory`, `question`). "YOLO" = set everything to `allow`. There is also an external-directory allowlist (e.g. tool-output under `/tmp/opencode/*`). **No `--dangerously-skip-permissions`-style flag exists**; treat any such flag as unsupported and strip it from user-supplied launch args.
- **Model / reasoning-effort / fast-mode at launch** —
  - **Model:** `-m, --model provider/model` (e.g. `openai/gpt-5.5`, `xai/grok-4.3`, `opencode/deepseek-v4-flash-free`).
  - **Reasoning effort:** `--variant <high|max|minimal|…>` ("provider-specific reasoning effort"), stored per-session as `model.variant` (e.g. `{"id":"deepseek-v4-flash-free","providerID":"opencode","variant":"max"}`).
  - **Fast mode:** expressed as **distinct model ids** with a `-fast` suffix (`openai/gpt-5.4-fast`, `gpt-5.5-fast`, `gpt-5.4-mini-fast`) — select the fast variant by picking that model id; **there is no separate fast-mode toggle flag**.
  - `--thinking` toggles whether thinking blocks render.
  - `--agent <name>` selects the agent (e.g. `build`); `--variant`/`--model`/`--agent` all also work on `run` (§12).

**Conflicts / open questions:** Whether `--model`/`--variant` are injected on the interactive TUI launch is an orchestrator policy choice — they are first-class flags on both `tui` and `run`, but a minimal launch may pass only `--prompt`. Exact env var names beyond the documented `OPENCODE_*`/`XDG_*` set are unverified.

## 3. Resume & reattach

- **Resume support** — Yes, first-class. `-c, --continue` resumes the **last** session; `-s, --session <ses_id>` resumes a specific id; both work on `tui`, `run`, and `attach`. `--fork` branches a copy (creates a child session with `parent_id` set) instead of mutating in place. The id comes from `session list` / DB / server (§1).
  - Established: `opencode --session <ses_id>` (TUI) and `opencode run -s <ses_id> …` (headless). Server tier: just keep using the same `session/:id`.
- **State restored vs lost** — High-fidelity. Resume restores full message/part history (from the `message` + `part` tables), the session's stored `agent`, `model` (incl. `variant`), `directory` (→ cwd), `title`, cost/token counters, and `todo` list — all persisted on the session/message rows. **Permissions follow current config/agent, not a frozen snapshot** (so a config change between runs takes effect on resume). Model/variant are restored from the row; you do not need to re-pass `--model` on resume.
- **Reattach after orchestrator/daemon restart** — Two answers:
  - **Server tier (preferred):** nothing to reattach — reconnect the SSE stream (`GET /event` or `GET /global/event`) and re-list messages; the long-lived `opencode serve` kept running. `opencode attach <url>` is the built-in "reattach a fresh TUI to the live server" command.
  - **PTY tier:** you need tmux/abduco to have kept the TUI master alive; on reattach send a redraw nudge (SIGWINCH / resize) because the Bubbletea TUI repaints on resize. `opencode run --replay` (default true) **replays interactive session history on resume and after resize**, and `--replay-limit N` caps it — directly relevant to redraw-on-reattach. If using a hook plugin, have it re-resolve its callback coordinates per-POST (from an on-disk endpoint file rather than frozen env) so a long-running process re-reaches a restarted orchestrator without relaunch.
- **Idempotency / race hazards** — Multiple clients can attach to the same session simultaneously (documented multi-client feature) — guard against duplicate prompt submission. Racing two writers on `--continue` can interleave; prefer explicit `-s <id>` and serialize sends. Use `--fork` for an isolated branch rather than risking a clobber. On the SSE stream, **dedupe by message/part `id`** (events are `message.updated` / `message.part.updated` with stable ids). Plugin-side, dedupe identical consecutive busy/idle transitions, and suppress child sessions (see §7) so sub-sessions don't flip the root pane.

**Conflicts / open questions:** None material. Server-tier reattach is strictly simpler (no PTY to heal); PTY-tier reattach inherits the generic tmux/abduco + redraw machinery.

## 4. Auth & subscription

- **Credential location(s)** — `~/.local/share/opencode/auth.json` (mode 600). Verified shape: a JSON object keyed by provider id; OAuth providers store `{ "type":"oauth", "access":"…", "refresh":"…", "expires":<epoch-ms>, "accountId":"…" }` (seen for `openai`, `xai`); API-key providers store `{ "type":"api", "key":"…" }`. `opencode providers list` confirms the path and prints each provider + auth type. Some hosted-gateway control-plane state also lives in the DB (`account`, `control_account`, `account_state`, `credential` tables).
- **Reuse model** — **Spawn-and-let-CLI-auth** is the native model: `opencode auth login` / `opencode providers login` performs OAuth and writes `auth.json`. The simplest orchestrator path is to let opencode own `auth.json` and point each spawn at the right data dir. No "capture/store/switch accounts" service is required or assumed.
  - **Orchestrator-managed multi-account (fallback):** materialize different `auth.json` files into different data dirs (relocate via `XDG_DATA_HOME`/`XDG_CONFIG_HOME`) per account. When overlaying a config dir for hook install (§8), symlink-mirror the user's `auth.json` into the overlay so their token still loads.
- **Token refresh** — opencode refreshes OAuth tokens itself against the provider/its gateway and **writes back** to `auth.json` (it checks the `expires` epoch-ms field). The orchestrator should **not** refresh; just preserve write access to `auth.json`.
- **Env hygiene** — To force opencode's stored creds, strip inherited `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `XAI_API_KEY` / `OPENROUTER_API_KEY` etc. from the child env (config `{env:VAR}` substitution / provider defaults can otherwise prefer an inherited key). No keys are forced/cleared automatically.
- **Multi-account** — No built-in per-session account-switch flag. Isolate accounts by separate data dirs (separate `auth.json`). The DB `account_state.active_account_id` hints at an "active account" concept for the hosted control plane, but per-spawn selection of an arbitrary provider account is not a documented flag (not supported as a flag; achievable by data-dir isolation).

**Conflicts / open questions:** Per-spawn arbitrary-account selection is unverified beyond data-dir isolation. Whether the hosted gateway exposes additional account-switch surface (via the `account*` DB tables) is unverified.

## 5. Models, usage & accounting

- **Model listing (settings UI)** — **Yes, dynamic.** `opencode models [provider]` prints one `provider/model` per line (verified: `opencode/*`, `openai/gpt-5.5`, `xai/grok-4.3`, …). `opencode models --verbose` adds metadata including per-model costs/context; `opencode models --refresh` refreshes the cache **from models.dev** (the upstream catalog). Enumeration = run `opencode models` (parse newline-delimited ids), optionally `--verbose` for cost/context metadata; freshness controlled by `--refresh`. A reasonable static fallback default is a free model id (e.g. `opencode/deepseek-v4-flash-free`) to avoid workspace-billing failures on hosted GPT models.
  - Established: `opencode models` (+ `--verbose`/`--refresh`). Fallback: query models.dev directly; static default list.
- **Runtime mid-session model / effort switch** —
  - **TUI:** keybinds `model_cycle_recent` (`f2`) cycle models; `agent_cycle` (`tab`) / `agent_cycle_reverse` (`shift+tab`) switch agents.
  - **Server:** set the model (and variant) per message in `POST /session/:id/message`.
  - Reasoning effort = `--variant` at launch or model/variant per message.
  - Established (server tier): per-message model/variant. Fallback (PTY tier): drive the `f2`/`tab` keybinds.
- **Usage windows / quota / rate-limits** — **No documented quota/reset-window endpoint or file.** Rate-limit/quota status is provider-side; opencode surfaces provider rate-limit/quota errors via `session.error` events but does not expose a quota meter. Whether the hosted opencode gateway exposes a balance/quota endpoint is unverified.
  - Not supported as a first-class meter. Fallback: catch `session.error` for rate-limit/quota error names.
- **Token accounting (analytics)** — **Excellent / among the richest of any CLI.** Per-session token + cost columns on the `session` row: `cost`, `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`. Per-message assistant data carries the same: `{cost, tokens:{input,output,reasoning,cache:{read,write}}, modelID, providerID, time:{created,completed}}` (verified in a real assistant `message.data` row). Aggregate view: `opencode stats [--days N] [--models] [--tools] [--project]` prints Sessions / Messages / Cost / Input / Output / Cache totals + tool-call accounting. Read computed values directly from the DB or `stats`; do not recompute.
  - Established: DB columns + `opencode stats`. (Live SSE/hook events carry message text/state, not token totals — read tokens from the message row's `data` JSON or the session aggregate.)
- **Pricing / cost** — Cost is **computed and persisted** by opencode (the `cost` field on session and message rows; `stats` shows total/avg/median cost). Per-model pricing comes from **models.dev** (refreshable via `opencode models --refresh`; `--verbose` shows per-model costs). Read computed cost directly rather than maintaining a rate table.

**Conflicts / open questions:** No quota/reset-window API is the main gap; an orchestrator that needs a usage meter must either infer from provider errors or (out of band) scrape a hosted dashboard. Hosted-gateway balance endpoint unverified.

## 6. Driving & input — two-way control

- **Send a new user message mid-session** —
  - **Server (preferred):** `POST /session/:id/message` ("Send a message and wait for response") — no PTY needed.
  - **Headless one-shot into an existing session:** `opencode run -s <id> "msg"`.
  - **Plugin hook into a live TUI composer:** `tui.prompt.append` injects text into the composer.
  - **PTY (fallback):** type text + Enter; the input box is multi-line, so use bracketed paste for big content, then a CR. Submit vs newline differ — see shortcuts below.
- **Read current input-box contents (draft sync out)** — **Not cleanly exposed.** No documented "get draft" endpoint or event. Options: screen-scrape the TUI composer (a normal text region; no dim-placeholder OSC quirk documented), or accept that the composer buffer is unavailable. The transcript/event path reports committed message text (user/assistant parts), not the live composer buffer.
  - Not supported (clean API). Fallback: screen-scrape.
- **Pre-fill / set the input box (draft sync in)** — Plugin hook **`tui.prompt.append`** appends text to the TUI composer — the supported live draft-prefill path. Launch-time prefill = `--prompt`. Over the server you don't prefill, you just submit.
  - Established: `tui.prompt.append` (live) / `--prompt` (launch). No `draftPromptFlag`/`draftPromptEnvVar` for a generic post-ready bracketed-paste path (fallback).
- **Answer interactive prompts / permission menus** — **Programmatic, not just key-scraping.** Permissions surface as `permission.asked` / `permission.replied` plugin events and `permission.updated` SSE events; a `permission` table exists in the DB and the server exposes a permission reply path. The prompt text + the set of options are delivered in the `permission.asked` payload / `permission.updated` event / `permission` row. In the TUI, prompts are answered with keys (arrow/enter accept-reject; `ctrl+f` = `permission.prompt.fullscreen`). The authoritative path is to **reply via the server/plugin permission API** rather than scrape the menu. `question.asked` is the analogous "AskUser" event → also waiting-on-user.
  - Established (server/plugin): reply via permission API. Fallback (PTY): drive accept/reject keys.
- **Interrupt / cancel** — Server `POST /session/:id/abort` ("Abort a running session") is authoritative. TUI keybind `session_interrupt` = `escape`. (Ctrl+C in a PTY would kill the client.)
  - Established (server): `POST /session/:id/abort`. PTY: send Escape. **Quirk:** when inferring an interrupt purely from PTY key presses (no plugin), treat a **double Escape** as the interrupt signal — a single Escape is often consumed as a TUI/editor cancel and may not end the turn.
- **Slash / special commands** — opencode supports custom **commands** defined in `.opencode/commands/` (markdown templates) plus built-in TUI slash commands. Plugin hook `tui.command.execute` triggers a command programmatically.
- **Attachments / large paste** — `opencode run -f, --file <path…>` attaches file(s) to the message (repeatable). Over the server, message parts include file/image part types; images attach as file parts. Large text paste in the PTY uses bracketed paste.
- **Important keyboard shortcuts (mobile soft-keys)** — verified default keybinds; note Alt/Ctrl/Shift fidelity needs:
  - **Submit:** `return` (`input_submit`).
  - **Newline:** `shift+return`, `ctrl+return`, `alt+return`, `ctrl+j` (`input_newline`) — needs Shift/Alt/Ctrl modifier fidelity on mobile.
  - **Interrupt:** `escape` (`session_interrupt`); double-Esc for PTY-only inference.
  - **Cycle model:** `f2`. **Cycle agent:** `tab` / `shift+tab`.
  - **New / list session:** `<leader>n` / `<leader>l` — **leader default = `ctrl+x`** (2000 ms chord timeout). Leader chords are critical to surface.
  - **Scroll:** `pageup`/`pagedown` (also `ctrl+alt+b`/`ctrl+alt+f`); half-page `ctrl+alt+u`/`ctrl+alt+d` — Alt fidelity needed.
  - **Permission fullscreen:** `ctrl+f`. **Copy/undo/redo:** `<leader>y` / `<leader>u` / `<leader>r`.

**Conflicts / open questions:** Exact `permission.asked` payload field names are unverified — read them from a live SSE `permission.updated` event or the `permission` DB row / `GET /doc` OpenAPI. Reading the composer draft has no clean API (scrape only).

## 7. Agent-state classification

- **State vocabulary** — `working | waiting (permission/question) | done (idle) | error | aborted`. opencode's own terminal signals are `session.idle`, `session.error`, `session.status`, plus `permission.asked`/`permission.replied` and `question.asked`; assistant messages carry an `error` object (verified `{"name":"MessageAbortedError",…}` on an aborted turn).
- **Signal sources & authority (highest → lowest):**
  1. **SSE event bus** `GET /event` / `GET /global/event` — authoritative, real-time. Emits `session.updated`, `session.idle`, `session.error`, `session.status`, `message.updated`, `message.part.updated`, `permission.updated`.
  2. **In-process plugin hooks** — `session.idle`, `session.error`, `session.compacted`, `permission.asked`, `permission.replied`, `question.asked`, `tool.execute.before`, `tool.execute.after`, `message.updated`, `message.part.updated` (verified names in the plugin/SDK type defs).
  3. **DB poll** — `message`/`part` rows; assistant `message.data.time.completed` set + no `error` ⇒ done; `error` present ⇒ error/aborted; latest part `type` (`tool` mid-call vs `step-finish`) indicates working.
  4. **Process/PTY activity, terminal title, OSC** — fallback for the bare-PTY path (title token "OpenCode" for hovercards; synthetic state labels; generic OSC-9999 status if present). Last-resort only.
- **Event → state mapping:**

  | Event / signal | State |
  |---|---|
  | `session.status` busy/retry, `tool.execute.before`, part `type:"tool"` `state.status:"running"`, streamed `message.part.updated` text | **working** |
  | `permission.asked` / `permission.updated` | **waiting** (needs user) |
  | `question.asked` | **waiting** (AskUser) |
  | `session.idle`, assistant `message.updated` with `time.completed` set & no error | **done** |
  | `message.data.error` = `MessageAbortedError` | **aborted** |
  | `message.data.error` other name, `session.error` | **error** |
  | `session.compacted` / `experimental.session.compacting` | transient **working** (context compaction) |

- **"Stopped but needs the user" vs "done"** — Distinguished **cleanly and explicitly**, not inferred: `permission.asked`/`permission.updated` (a `permission` DB row + event) and `question.asked` are separate signals from `session.idle`/done. A blocked agent shows `waiting` (needs-attention); a finished agent shows `done`. Emit these without mutating the last busy/idle status so a permission prompt doesn't read as "done."
- **Reconciliation** — Prefer SSE/hook events over DB polls; **dedupe by message/part `id`**; treat `session.idle` as authoritative end-of-turn. No quiet-window needed because events are explicit. Plugin-side, dedupe identical consecutive busy/idle. Per-message prompt-sent telemetry should key on the message id (e.g. `opencode-message-<messageID>`) and treat a matching key as duplicate.
- **Sub-agent / nested state** — Child agents create **child sessions** with `parent_id` set (verified: an `@explore subagent` session with `parent_id` → parent). Two valid policies: (a) observe subagents independently as their own session rows/events and inherit identity via the `parent_id` chain; (b) **suppress** child sessions so they don't flip the root pane to done — keep identity on the root and detect children via `parent_id` (cache `session.list()`, fail-closed). Subagents are also visible as `task`-type tool parts in the parent.
- **Latency / debounce** — SSE/hooks fire on the order of the model stream (near-real-time); DB-poll latency = poll interval. **Debounce `message.part.updated`** (high-frequency during streaming). The PTY-plugin path re-sends the full accumulated assistant text per chunk, so coalesce (e.g. trailing-edge ~250 ms) and cap text (e.g. ~4000 chars client / ~8000 server) to avoid an O(n²) flood; user prompts can post immediately.

**Conflicts / open questions:** Exact `session.status` payload field set is unverified — confirm against `GET /doc` (OpenAPI) on a running server. `session.error` collapsing to `done` vs a distinct `error` state is a policy choice; the structured data supports a real `error`/`aborted` state via `message.data.error.name`, so prefer that over collapsing.

## 8. Hooks & instrumentation install

- **Mechanism** — **In-process JS/TS plugins** loaded by the Bun runtime (not shell hooks, not a TS-extension host). A plugin is a module exporting plugin function(s); each receives `{ project, client, $ (Bun shell), directory, worktree }` and returns a hooks object. The vendored package is `@opencode-ai/plugin` (with `index.d.ts`, `tool.d.ts`, `tui.d.ts`, `shell.d.ts`, `example.{js,d.ts}`). **Alternatively, skip plugins entirely and consume the server SSE bus** — often simpler than installing a hook (tier A).
- **Install location / trust** — Plugins load from:
  - `~/.config/opencode/plugins/` (global) and `.opencode/plugins/` (project), or
  - npm packages listed under `plugin` in `opencode.json` (`"plugin": ["pkg", "@org/pkg"]`) — auto-installed via Bun at startup, cached under `~/.cache/opencode/node_modules/`.
  - **No per-hook trust/hash gate** (unlike Claude Code's settings hash). `--pure` disables external plugins.
  - For an orchestrator that must not perturb the user's real config, point `OPENCODE_CONFIG_DIR` at an **overlay** dir that symlink-mirrors the user's config (`auth.json`, `opencode.json[c]`, themes) and drops the orchestrator's status plugin alongside the user's plugins. Because `OPENCODE_CONFIG_DIR` is **singular** (not a colon-list), you must mirror-then-add rather than append. Make the overlay idempotent (manifest of mirrored entries; pre-write `unlink` so a symlink can't be written through a same-named user plugin) and guard nested inheritance so a child opencode doesn't overlay an overlay. Sanitize per-session dir names (e.g. `sha256(id).slice(0,32)`) because daemon-shaped ids can embed `::`/slashes.
- **Hook event taxonomy + payload fields** — verified names: `event` (catch-all), `tool.execute.before`, `tool.execute.after`, `chat.message`, `chat.params`, `permission.ask`/`permission.asked`/`permission.replied`, `question.asked`, `auth`, `session.created`/`updated`/`idle`/`error`/`compacted`/`deleted`/`diff`/`status`, `message.updated`/`part.updated`/`part.removed`/`removed`, `file.edited`, `file.watcher.updated`, `command.executed`, `todo.updated`, `installation.updated`, `server.connected`, `lsp.client.diagnostics`, `lsp.updated`, `shell.env`, TUI hooks `tui.prompt.append`/`tui.command.execute`/`tui.toast.show`, and `experimental.session.compacting`. Payloads carry session/message/part ids, tool name + args (`tool.execute.before`), permission details (`permission.ask`). Fields worth extracting for state/chat: `role`, `text`, `messageID`, `sessionID`, the assistant `MessagePart` text (last-assistant-message), and `permission`/`question` payloads. **Quirk:** `message.part.updated` carries no role — cache role per `messageID` from `message.updated`, and drop parts whose role is unknown rather than guessing. Drop non-text parts (`part.type !== 'text'`) when forwarding chat text.
- **Transport back to the orchestrator** — A plugin runs in-process and is handed the SDK `client` + Bun `$`, so it can call out over HTTP/socket/file directly — you write the callback (e.g. `fetch`-POST JSON to `http://127.0.0.1:<port>/…` with a shared token header). Resolve callback coordinates **per-POST** from an on-disk endpoint file (mtime:size:inode cache) rather than frozen `process.env`, so a long-running process re-reaches a restarted orchestrator. **Fail-open:** wrap every callback in a silent try/catch so opencode never fails a run because the orchestrator is down; missing port/token → silent return.
- **Lifecycle** — `opencode plugin <module>` (alias `plug`) installs a plugin and updates config; idempotent via the `plugin` config array. Install-on-spawn via the config-dir overlay is idempotent (manifest-based clear of stale mirrored entries). Teardown can be a deliberate no-op when config dirs are app/source-scoped rather than PTY-scoped (avoids platform teardown freezes). Version skew handled by Bun resolving the pinned npm version (this host vendors `@opencode-ai/plugin@1.3.17`); also enforce a client-side text cap so a pre-throttle plugin build can't flood.

**Conflicts / open questions:** The plugin fail-open guarantee (that a thrown plugin error cannot crash the agent run) is documented-by-convention but unverified at the runtime level. Exact `permission.ask` payload shape unverified (read from a live event / OpenAPI).

## 9. Session titles

- **Source of truth** — `session.title` column, an **agent/LLM-generated** summary title (e.g. "Dryrun cost check parameter parity", "Trace engine dryrun pricing (@explore subagent)"). opencode auto-summarizes the session into a title. A separate random human-friendly `slug` (e.g. `playful-cactus`) is also always present.
- **Read / update / eventing** — Read from the `title` column / `session list` / `GET /session`. Updated via the `session.updated` SSE event. `opencode run --title "<text>"` sets/overrides the title at launch (defaults to a truncated prompt if no value).
- **Fallback** — If no generated title yet, opencode uses the **truncated first prompt** (`--title` "uses truncated prompt if no value provided"). The column is NOT NULL so a synthetic scheme is rarely needed; `slug` is an additional always-available label. For a live PTY pane you may overlay synthetic state labels (e.g. "OpenCode", "OpenCode — action required", "OpenCode ready") driven by §7 state.

**Conflicts / open questions:** None material — the LLM-generated `title` is authoritative and always present; the truncated-prompt fallback and `slug` cover the rest.

## 10. Transcript & history

- **Storage / format** — **SQLite** (`~/.local/share/opencode/opencode.db`), not one-file-per-session. Tables: `session`, `message` (one row/message; `data` JSON, role, `session_id`, timestamps), `part` (one row per content part; FK to message + session; `data` JSON), `todo`, `session_share`, `event`/`event_sequence` (event log), `permission`, `project`, `workspace`. Export to a single JSON: `opencode export [sessionID] [--sanitize]`; import via `opencode import <file|url>`. **Legacy:** pre-DB versions used JSONL under `storage/` (per-message JSON files under `storage/message/<sessionID>/`) — fallback only.
- **Parsing / schema mapping** (verified) — `message.data.role` ∈ `{user, assistant}`; assistant messages carry `mode`/`agent`/`variant`, `path:{cwd,root}`, `cost`, `tokens:{input,output,reasoning,cache:{read,write}}`, `modelID`, `providerID`, `time:{created,completed}`, optional `error:{name,data}`. `part.data.type` ∈ `{text, reasoning, step-start, step-finish, tool, patch, compaction}`. A `tool` part has `tool` (name, e.g. `read`), `callID`, and `state:{status, input{…}, output, metadata{preview, truncated, …}, title, time:{start,end}}`. Roles other than user/assistant are skipped.
- **Live tail vs historical** —
  - **Live:** subscribe to SSE `GET /event` (`message.updated`, `message.part.updated`), or (PTY tier) the plugin's `message.part.updated` events. New entries detected by event id / monotonically increasing `time_created` + the `event_sequence` counter; **dedupe by part `id`**.
  - **Historical:** `GET /session/:id/message`, or `SELECT … FROM message/part WHERE session_id=? ORDER BY time_created`. (Historical disk scans should use mtime-based reuse to avoid re-reading unchanged data.)
- **Consumers** — chat-view ← `text`/`reasoning` parts + roles; last-message/preview ← latest `text` part (last-assistant-message); clickable items ← `tool` parts (file refs in `state.input.filePath`, diffs in `patch` parts / `storage/session_diff/<id>.json`); state classification ← §7; usage/analytics ← session/message token + cost columns (§5).
- **Transcript ↔ terminal mapping** — The TUI renders the same message/part stream, so the structured DB/SSE view is the **canonical source** and the terminal is a render of it. For a web chat view, render from the DB/API and ignore the PTY entirely if using the server tier.
- **Special content types / quirks** —
  - **Reasoning/thinking** = dedicated `reasoning` parts (visibility toggled by `--thinking`).
  - **Diffs** = `patch` parts + `storage/session_diff/<id>.json` + session summary columns (`summary_additions`/`deletions`/`files`/`diffs`).
  - **Tool output** = `tool` part `state.output` with a truncated `metadata.preview`; large outputs spill to `~/.local/share/opencode/tool-output/tool_<id>` files.
  - **Compaction** = `compaction` parts when context is summarized.
  - **Images/attachments** = file parts (attached via `run -f`).
  - **Redaction** = `export --sanitize` redacts sensitive transcript/file data.
  - **PTY-plugin quirk:** the plugin re-sends the *full accumulated* assistant text per chunk; coalesce + cap to avoid an O(n²) flood, and drop non-text parts (tool/reasoning/file) from forwarded chat text.

**Conflicts / open questions:** None material on the structured format. Legacy JSONL layout details unverified (not on this host).

## 11. Terminal rendering & display fidelity

> If integrating via the server/SSE tier, most of this section is moot — render from structured data, no PTY. Notes below are for the PTY-TUI tier.

- **PTY capture → xterm** — Standard alt-screen Bubbletea TUI; capture PTY bytes → stream → xterm.js. Strip/keep alt-screen chrome as for any full-screen TUI. **No special OSC-status channel** — status comes from the event bus/plugin, not OSC. No OpenCode-specific byte filtering required.
- **Resize/reflow** — Send SIGWINCH on cols/rows change; the TUI repaints on resize. `opencode run --replay` (default true) / `--replay-limit N` explicitly **replays history on resize** — the built-in redraw nudge. Mobile↔desktop breakpoint remount: re-send size and rely on replay.
- **Scrollback model** — Native TUI alt-screen — the agent owns its scrollback; forward mouse scroll/keys (`pageup`/`pagedown`, `ctrl+alt+u`/`ctrl+alt+d`) into the TUI rather than using xterm scrollback.
- **Mouse forwarding** — TUI uses mouse; forward scroll/click while attached. Exact enable/disable sequences unverified (generic mouse-mode handling).
- **Snapshot/serialize for reattach** — PTY tier: headless-xterm serialize as usual. Server tier: "snapshot" is just re-reading the DB/messages.
- **Local cache for instant render then live reconnect** — Strong fit. PTY tier: cache the last serialized buffer. **Server tier: cache the last N messages from `GET /session/:id/message`, render instantly, then reconnect SSE and reconcile by message/part `id`** — no flicker because reconciliation is id-keyed, not append-blind. `--replay-limit` is the TUI analog.
- **Composer/cursor specifics** — No documented dim-placeholder OSC composer-ready signal; treat the composer as a normal text region. Use `tui.prompt.append` to write into it rather than positional cursor math. (No paste-ready signal; PTY drafts use the generic post-ready bracketed-paste fallback.)
- **Color/theme/OSC** — TUI themes are config-driven (`tui.json`); standard ANSI/truecolor. No unusual OSC-title status protocol — titles/state come from the API, not OSC.

**Conflicts / open questions:** Exact mouse enable/disable sequences unverified. Everything in this section is generic/PTY-only; the server tier sidesteps it.

## 12. Background / headless invocation

- **Non-interactive one-shot** — `opencode run [message..]` is the canonical headless invocation. Prompt via **positional argv** or **stdin** (pipe — preferred for large/staged-diff prompts to dodge cross-platform argv limits). Output: `--format default` (human) or **`--format json`** (raw JSON event stream, machine-parseable). Combine with `-m <model>`, `--agent <name>` (e.g. `build`), `--variant <effort>`, `-s <id>` / `-c` to thread state, `-f` to attach files, `--title`, `--share`. Can target a remote server via `--attach <url>` + `--dir <remote-path>`.
- **Features that can use it** — commit messages, PR title/body, branch names, summaries, and **model discovery** (`opencode models`, §5). `run --format json` is ideal for programmatic one-shot LLM work owned by the orchestrator. `opencode export`/`stats` for analytics jobs.
- **Auth path for headless** — Inherits the same `auth.json` OAuth/api creds; strip inherited provider API-key env vars (§4) to pin the intended account. No special account materialization needed for the inherited account.
- **Cost / latency / timeout / output caps** — Provider `timeout`/`chunkTimeout` are config options; cost is reported per run (token/cost fields, §5). Local execution by default; remote via `--attach`. No hard output cap beyond model context (compaction parts kick in on long contexts). Choosing a free default model (e.g. `opencode/deepseek-v4-flash-free`) avoids workspace-billing failures on hosted GPT models.

**Conflicts / open questions:** None material — `run` is well-specified. `promptDelivery: stdin` is the recommended channel for large prompts.

## 13. Capabilities & quirks matrix

| Capability | OpenCode |
|---|---|
| Resumable | **Yes** — `-c` / `-s <ses_…>`; `--fork` to branch |
| Hooks / instrumentation | **Yes** — in-process JS/TS Bun plugins **+** rich SSE event bus (`GET /event`) |
| Draft prefill | **Flag** `--prompt` (launch) + plugin `tui.prompt.append` (live); reading draft = **none** (scrape only) |
| Trust preset needed | **No** per-dir trust gate; only provider/model first-run (pre-seed `auth.json` + config) |
| Interactive-prompt selection | **Yes, programmatic** — `permission.*` / `question.asked` events + reply API (not just key-scraping) |
| Title source | **Agent/LLM-generated** `session.title`; fallback truncated prompt; `slug` handle |
| Transcript format | **SQLite DB** (`message`/`part` JSON); JSON export/import; legacy JSONL fallback |
| Headless | **Yes** — `run [--format json]`, stdin/argv prompt; plus full `serve`/`web` HTTP + SSE server |
| Model listing | **Yes, dynamic** — `opencode models [--verbose] [--refresh]` (from models.dev) |
| Usage / quota | Token + **cost fully accounted** (DB cols + `stats`); **no quota/reset-window API** |
| Fast mode | **Yes, as separate model ids** `*-fast` (no toggle flag); reasoning effort via `--variant` |
| Multi-account | **No flag** — isolate via separate data dirs (`auth.json` per `XDG_DATA_HOME`) |
| Version gating | **Recommended** — fast-moving CLI; gate on `--version` semver |
| Server / API integration | **Yes (distinctive)** — OpenAPI HTTP + SSE; `attach`; ACP; mDNS discovery |
| Interrupt | **`POST /session/:id/abort`** (server) / `escape` (TUI); double-Esc for PTY-only inference |
| Permission posture | Policy-based (`permission` config `allow|ask|deny`), **no OS sandbox**, no `--dangerously-skip-permissions` |

- **Special cases / workarounds:**
  - **Binary may not be on PATH** — probe `~/.opencode/bin/opencode` for the standalone installer.
  - **Two integration tiers** — prefer the **server/SSE API** over PTY for state, transcript, send, abort, title (richer + survivable). PTY-TUI is a fallback.
  - **`OPENCODE_CONFIG_DIR` is singular** (not a colon-list) → overlay-mirror the user's config rather than append; guard nested-inheritance so a child opencode doesn't overlay an overlay.
  - **`--pure`** to neutralize user/orchestrator plugin interference during automation.
  - **mDNS** (`--mdns`) auto-advertises the server (defaults hostname to `0.0.0.0`) — convenient but a security consideration.
  - **Reasoning effort = `--variant`**; **fast = model-id `-fast` suffix** — don't look for a "fast flag."
  - **ACP** (`opencode acp`) exposes the Agent Client Protocol (Zed-style) — an alternative structured-control transport.
  - **PTY-plugin flood mitigation:** coalesce streamed assistant text (~250 ms) + cap (~4000/8000 chars); drop non-text parts; cache role per `messageID`.
  - **`--dangerously-skip-permissions`-style flags are unsupported** → strip from user launch args.
  - **No `session.idle`/`done` confusion at permission time** — emit `permission.asked`/`question.asked` without mutating last busy/idle status.

## 14. Failure, exit & recovery

- **Crash / exit detection** — Clean completion = assistant `message.data.time.completed` set + no `error` + `session.idle`. Failure = `message.data.error` (verified `{"name":"MessageAbortedError"}` for abort; other names for provider/tool errors) + `session.error` event. Distinguish user/`/abort` from a crash by `error.name`. The `run` process exit code reflects success/failure for headless jobs. The structured data supports a real `error`/`aborted` state — prefer surfacing it over collapsing `session.error` into `done`.
- **Reattach-after-restart healing** —
  - **Server tier:** reconnect SSE and re-list; the server kept session state, so there is no "exited-but-alive" ambiguity. Check `GET /global/health` before declaring a session dead.
  - **PTY tier:** if the TUI client died but `opencode serve` / the tmux master is alive, `opencode attach <url>` re-enters; heal "exited but server alive" by checking server health and re-reading messages. A surviving process with a hook plugin reconnects to a restarted orchestrator by re-reading its endpoint file per-POST.
- **Error surfacing** — Surface `session.error` events, assistant `error` objects, and `permission` denials to the user. `installation.updated` signals a version change underneath a long-running server (re-probe `--version`/features). `lsp.client.diagnostics` is available for surfacing code diagnostics.

**Conflicts / open questions:** Whether to surface a distinct `error` state vs collapse to `done` is a policy choice; the verified `message.data.error.name` field makes a true error/aborted state achievable and preferable.

## 15. Remote / transport

- **Transports:**
  1. **Local** — embedded server + TUI.
  2. **Daemon-subprocess (recommended for an orchestrator)** — one `opencode serve` daemon, many clients/sessions over HTTP + SSE.
  3. **Remote over network** — `opencode serve --hostname 0.0.0.0 --port N` + `opencode attach http://host:N` (or `run --attach <url> --dir <remote-path>`), secured with `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD` basic auth and `--cors`.
  4. **mDNS** auto-discovery of remote servers (`--mdns` / `--mdns-domain`).
  5. **SSH** — works like any CLI (run opencode on the remote host); the native HTTP server usually obviates SSH-PTY tunneling.
- **Forwarding PTY/git/fs + instrumentation callbacks** —
  - **Server tier:** forward **HTTP requests + the SSE event stream** instead of a PTY. git/fs ops happen on the server host (point `--dir` / `run --dir` at the remote path). Instrumentation comes from the SSE bus / plugins running in the remote server process — **no per-callback port injection needed**; the orchestrator just consumes SSE.
  - **PTY tier:** forward the PTY over the relay as with any harness and rely on tmux/abduco for survival. The hook listener should be host-agnostic so plugin callbacks are normalized **on the remote** and routed back over the relay. **Caveat:** the `OPENCODE_CONFIG_DIR` overlay and endpoint-file writes are host-local filesystem operations — for SSH/remote, the plugin-install/overlay is the remote host's responsibility, not the orchestrator's local machine.
- **Agent-specific limitation** — `run --dir` on an attached remote server is "path on the remote server" — paths are remote-relative, so the orchestrator must **translate worktree paths to the server host's filesystem**.

**Conflicts / open questions:** The server/HTTP+SSE transport is the distinctive, preferred remote path and largely obviates SSH-PTY; the PTY-tier remote story is the generic relay fallback with the host-local overlay caveat above.

---

## Open questions / unverified

- **`session.status` and `permission.asked`/`permission.ask` exact payload field sets** — confirm against `GET /doc` (OpenAPI) on a running server and a live SSE event.
- **Usage quota / reset-window / balance** — no documented endpoint or file; whether the hosted opencode gateway exposes a balance/quota meter is unverified. Only token/cost accounting (DB + `stats`) and provider `session.error` are available.
- **Multi-account per-spawn selection** — no documented flag; only data-dir isolation is verified. The DB `account*`/`account_state.active_account_id` tables hint at a hosted "active account" concept whose programmatic surface is unverified.
- **Legacy pre-DB JSONL transcript layout** — not present on the v1.17.8 host; exact schema/globs for old versions unverified.
- **Plugin fail-open guarantee** — that a thrown plugin error cannot crash an agent run is documented-by-convention, not runtime-verified.
- **Exact env var names beyond `OPENCODE_*`/`XDG_*`** — provider-key substitution names are config-driven; the precise inherited-key precedence is inferred.
- **Mouse enable/disable byte sequences** for the PTY-TUI tier — generic, unverified for opencode specifically.
- **Reading the live composer draft** — no clean API; screen-scrape only.
