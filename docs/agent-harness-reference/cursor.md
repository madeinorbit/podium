# Cursor Agent CLI — orchestrator integration reference

Binary: **`cursor-agent`** (the internal program / usage string calls itself `agent`; docs and examples sometimes write `agent ...`, but the shipped, on-PATH name is `cursor-agent`). Full-screen alt-screen TUI for interactive use; first-class non-interactive `-p`/`--print` headless mode. Reference build observed: `2026.06.15-18-00-12-6f5a2cf`. Official docs: https://cursor.com/docs/cli/using , https://cursor.com/docs/cli/headless , https://cursor.com/docs/hooks , https://cursor.com/blog/cli .

Status tags below: **[established]** = the primary, well-supported method; **[fallback]** = secondary / generic-path method to use when the primary is unavailable; **[not supported]** = no known method. On-disk facts are written against the layout under `~/.cursor` and `~/.config/cursor`.

---

## 1. Discovery & identity

- **Binary detection / "installed?"** — Resolve the command name `cursor-agent` on `PATH` **[established]**. It is normally a symlink installed by `curl https://cursor.com/install | bash` at `~/.local/bin/cursor-agent -> ~/.local/share/cursor-agent/versions/<version>/cursor-agent`; follow the symlink to confirm a real binary. No aliases. The internal usage string says `agent`, so do not key detection off the help banner's program name.
- **Version detection / gating** — `cursor-agent --version` / `-v` prints a date-stamped build id (e.g. `2026.06.15-18-00-12-6f5a2cf`) **[established]**; `cursor-agent about --format json` returns `{"cliVersion","model","subscriptionTier","osPlatform","osArch"}` **[established]**. The version is **not semver** and changes fast, so **gate on presence of a flag/subcommand**, not on parsing the date (hooks landed in Cursor 1.7; `--resume`, `acp`, `worker`, `--worktree` are present in current builds) **[established]**.
- **Existing-session discovery** — Two parallel on-disk trees, both keyed off the absolute workspace path:
  - **Chats (canonical):** `~/.cursor/chats/<md5(workspacePath)>/<chatId>/` — each chat dir holds `store.db` (SQLite) + `meta.json`. The top dir is the **md5 of the absolute workspace path with NO trailing slash** (e.g. `md5("/home/user/src/other/podium") = 246166f199d85e0e4740c6a7f7bd6ec1`). `<chatId>` is a UUID. Glob: `~/.cursor/chats/*/*/meta.json`.
  - **Projects (transcripts + trust):** `~/.cursor/projects/<slug>/` — `slug` is the absolute path with leading `/` stripped and remaining separators → `-` (e.g. `home-user-src-other-podium`). Contains `repo.json` (`{"id":"<uuid>"}`), `.workspace-trusted`, `worker.log`, `worker.sock`, and the human-readable transcript at `agent-transcripts/<chatId>/<chatId>.jsonl`. Glob: `~/.cursor/projects/*/agent-transcripts/*/*.jsonl` **[established]**.
- **Stable session identity** — The **chat id (UUID)** is the durable identity **[established]**. Obtain it via: (a) the `session_id` field carried on **every** headless `stream-json` event; (b) `cursor-agent create-chat`, which prints a bare UUID to stdout to **pre-allocate** an id you then pass to `--resume`; (c) for a pre-existing session, the chat dir name `<chatId>` and `meta.json`/`store.db` `agentId`. No OSC-emitted id is observed.
- **Session ↔ repo/cwd mapping** — Forward: `md5(cwd-without-trailing-slash)` → chats dir; `cwd` with separators→`-` → projects slug. Reverse (authoritative cwd): `~/.cursor/projects/<slug>/.workspace-trusted` stores `{"workspacePath":"/abs/path","trustedAt":...}`; the chat `store.db` root node also embeds `file:///abs/workspace` plus git branch. `--workspace <path>` overrides cwd at launch **[established]**.
- **Conflicts / open questions:** The chats md5 key vs. the projects slug key are two different derivations of the same session's cwd; an orchestrator must compute and watch **both**. One characterization framed identity purely off the transcript filename (`sessionIdFromFileName`) and reported "no provider-session id usable for resume" — that is superseded: the UUID chat id is both the on-disk dir name and the live `session_id`, and it **is** resumable (see §3).

## 2. Launch & process model

- **Spawn mechanism** — Interactive: spawn `cursor-agent` in a **PTY** (full-screen TUI), hosted in the orchestrator daemon **[established]**. Headless: `cursor-agent -p ...` runs as a normal child with stdout/stderr pipes, **no PTY needed** **[established]**.
- **Launch command + args** — Interactive base: `cursor-agent [--model <id>] [--workspace <path>] [prompt...]` **[established]**.
- **Env injected / honored** — `CURSOR_API_KEY` (auth, optional; overrides the file-stored account — see §4); `NO_OPEN_BROWSER=1` (print the login URL instead of opening a browser). `CURSOR_DATA_DIR` and `CURSOR_WORKER_*` are worker-mode only. Any orchestrator instrumentation env (e.g. a hook callback host/port/token) must be baked into the hook `command` and/or exported into the child env so the hook process can reach the orchestrator (see §8).
- **Env stripping** — To force the file-stored account, strip any inherited `CURSOR_API_KEY` from the child env (otherwise it wins over `auth.json`). To force a specific key, set `CURSOR_API_KEY` and ignore the file.
- **HOME / config redirection** — There is **no `--config-dir`/`--profile`/`CONFIG_DIR` override**; config lives at the fixed `~/.cursor` and `~/.config/cursor`. The only file-based isolation lever is redirecting `HOME` per spawn. **[fallback]**
- **Durable backing for survival** — No built-in durable multiplexer for the interactive TUI; wrap the PTY in tmux/abduco as with other CLIs **[established]**. (Cursor also ships `cursor-agent worker start`, a persistent private cloud worker that connects outbound to Cursor and runs agents — a different, Cursor-dispatched architecture, not a local-PTY multiplexer; see §15.)
- **Initial-prompt injection** — Headless: trailing **argv** (`cursor-agent -p "..."`) or **stdin** (`echo "..." | cursor-agent -p`) **[established]**. Interactive: trailing **argv** prompt is accepted (`cursor-agent "fix the bug"`) and is the cleanest path for an orchestrator; otherwise type into the composer after ready and submit with CR, using bracketed paste for multi-line **[established / fallback]**.
- **First-run / trust handling** — Interactive first run shows a workspace-trust prompt that can swallow an immediately-typed/pasted draft. Pre-seed it by writing `~/.cursor/projects/<slug>/.workspace-trusted` = `{"trustedAt":"<iso>","workspacePath":"<abs>"}` (this mimics the file the CLI writes after the user accepts) **[established]**. The `--trust` flag also trusts the workspace **but only applies in `--print`/headless mode**, so it is not a substitute for the marker file in the interactive TUI **[established]**. MCP approval prompts are pre-seeded with `--approve-mcps`, `cursor-agent mcp enable <id>`, or `~/.cursor/cli-config.json` permissions.
- **Permission / YOLO / sandbox** — `-f`/`--force` (force-allow unless explicitly denied), `--yolo` (alias of `--force`, "Run Everything"), `--sandbox enabled|disabled` (overrides config), `--approve-mcps` **[established]**. Config equivalents in `~/.cursor/cli-config.json`: `permissions.allow`/`permissions.deny` arrays (entries like `"Shell(ls)"`), `approvalMode` (e.g. `"allowlist"`), `sandbox.mode`, `sandbox.networkAccess`. For unattended runs, `--yolo`/`--force` is the default bypass.
- **Model / reasoning-effort / fast-mode at launch** — `--model <id>` (e.g. `gpt-5`, `sonnet-4`, `sonnet-4-thinking`; full id grammar in §5) **[established]**. **Reasoning effort and fast-mode are encoded in the model-id suffix, not separate flags**: effort = `-low|-medium|-high|-xhigh|-max` (and `-thinking-*`), fast = a `-fast` suffix (e.g. `composer-2.5-fast`). On-disk defaults live in `cli-config.json` (`model`/`selectedModel`/`modelParameters`, e.g. `composer-2.5` with `parameters:[{"id":"fast","value":"true"}]`, plus `maxMode` for the "Max" context tier). "Fast" is a real concept (a `fast` model parameter / `-fast` id suffix) **[established]**.
- **Conflicts / open questions:** One characterization said there is "no interactive-launch model flag for cursor." That is incorrect for current builds — `--model` is a top-level launch flag for both interactive and headless. Whether all config paths honor a redirected `$HOME` for per-account isolation is unverified.

## 3. Resume & reattach

- **Resume support** — **Yes [established].** `--resume [chatId]` selects/resumes a chat (no id → interactive picker); `--continue` resumes the most recent (`--continue` ≈ `--resume=-1`). Subcommands `resume` (latest) and `ls` (pick) also exist. The id comes from the headless `session_id`, `create-chat`, or the on-disk chat dir name (§1). For headless follow-ups, re-run with `--resume <chatId>` plus a new `-p` prompt.
- **State restored vs lost** — Restored: full conversation history; last-used model (`meta.json.lastUsedModel` / `store.db lastUsedModel`); mode; and the content-addressed DAG of `system_prompt/tools/rules/skills/mcp/subagents/conversation`. cwd is re-derived from the chat's stored workspace path, but still pass `--workspace`/run in the right cwd. **Permissions/sandbox are NOT restored from the session** — they come from current `cli-config.json` + flags **[established]**.
- **Reattach to a running PTY after daemon restart** — No agent-specific mechanism; use the generic tmux/abduco reattach **[fallback]**. The TUI is alt-screen, so send a redraw nudge (SIGWINCH / resize) on reattach to force a repaint. Headless `-p` has no live process to reattach — re-`--resume` the chat id instead.
- **Idempotency / race hazards** — `create-chat` writes a **new** chat dir on every call; pre-allocate **once** and reuse, and reap stray empty chats **[established]**. `store.db` is a content-addressed (sha256-keyed `blobs` + a `meta` pointer to `latestRootBlobId`) append-mostly store, so two writers to the same chat dir race the `meta` pointer — **run only one process per chatId**.
- **Conflicts / open questions:** One characterization listed cursor as not resumable. Superseded — resume is a first-class, verified feature. If any older build genuinely lacks `--resume`, the version gate in §1 (flag-presence check) catches it.

## 4. Auth & subscription

- **Credential locations** — `~/.config/cursor/auth.json` = `{"accessToken":"<jwt ~415 chars>","refreshToken":"<~415 chars>"}` **[established]**. Account metadata cached in `~/.cursor/cli-config.json` → `authInfo` (`email`, `displayName`, `userId`, `authId` e.g. `github|user_...`) and `serverConfigCache` (`backendUrl: https://api2.cursor.sh`, `agentUrl: https://agentn.global.api5.cursor.sh`, `authCacheKey`). Env alternative: `CURSOR_API_KEY` / `--api-key <key>`. No OS-keychain usage observed (plain files).
- **Reuse model** — Two paths: (a) **spawn-and-let-CLI-auth** — `cursor-agent login` (opens a browser; `NO_OPEN_BROWSER=1` prints the URL), `logout`, `status`/`whoami [--format json]` — inherits the user's ambient login **[established, default]**. (b) **Orchestrator-managed** — pass `CURSOR_API_KEY`/`--api-key` per spawn (keys minted in the Cursor dashboard); clean multi-account / CI path that bypasses `auth.json` **[established]**.
- **Token refresh** — The CLI refreshes its own `accessToken` from the stored `refreshToken` against Cursor's auth backend (`api2.cursor.sh`) and writes back to `auth.json`; the orchestrator does not manage this. With `CURSOR_API_KEY` there is no refresh (long-lived key). The exact refresh client-id/endpoint is not publicly documented.
- **Env hygiene** — Strip inherited `CURSOR_API_KEY` to force the file account; set it to force a key.
- **Multi-account isolation** — Cleanest: per-account `CURSOR_API_KEY` per spawn **[established]**. File-based isolation requires a per-account `HOME` (each gets its own `~/.config/cursor/auth.json` + `~/.cursor`) **[fallback]**. There is no `--profile`/`--config-dir`.
- **Conflicts / open questions:** Whether every config path honors a redirected `$HOME`; the refresh client-id/endpoint (only the cached `backendUrl: api2.cursor.sh` is observed).

## 5. Models, usage & accounting

- **Model listing for a settings UI** — `cursor-agent models` or `cursor-agent --list-models` prints `<id> - <Display Name>` lines (account-specific; reflects subscription) **[established]**. **No `--format json` on `models`** — parse the `id - name` text lines (trim a trailing `(default)`/`(current)`). Verified id grammar: `auto`, `composer-2.5`, `composer-2.5-fast` (default), `gpt-5.2`, `gpt-5.3-codex[-low|-high|-xhigh][-fast]`, `gpt-5.5-{none,low,high}[-fast]`, `claude-opus-4-8-{low,medium,high,xhigh,max}[-fast]`, `claude-opus-4-8-thinking-{low..max}[-fast]`, etc. The `-fast` suffix = Fast variant; effort = the `-low/-medium/-high/-xhigh/-max` suffix. Freshness = on-demand subprocess.
- **Runtime model / effort / fast switching mid-session** — Interactive: pick a different (suffixed) id via the TUI model picker; `lastUsedModel` persists **[established]**. Headless: no mid-run switch — set per invocation with `--model` **[established]**. A slash-command model switch is unverified.
- **Usage windows / quota / rate-limits** — **No CLI command exposes remaining quota or reset windows [not supported].** `about --format json` shows `subscriptionTier` (e.g. `"Free"`) only. Rate-limit info appears only as an error at request time. (Usage lives in Cursor's web dashboard, unreachable from the CLI.)
- **Token accounting for analytics** — Per-turn/session token counts are **not** in the plaintext transcript (`agent-transcripts/*.jsonl` has roles/content/tool_use only) **[not supported via transcript]**. The headless **`result` event** is the documented completion summary (confirmed fields: `duration_ms`, `session_id`, `subtype`); explicit token/cost fields (`input_tokens`/`output_tokens`/`total_cost_usd`) are **unverified** — capture one `-p --output-format json` run to confirm. `~/.cursor/ai-tracking/ai-code-tracking.db` (SQLite) tracks AI-authored code (lines added/accepted), **not** LLM token counts.
- **Pricing / cost** — Not computed or exposed by the CLI; billing is server-side (subscription/request credits). No local rate table. `result.total_cost_usd` unverified **[not supported / unverified]**.
- **Conflicts / open questions:** Both characterizations agree `--list-models`/`models` is the listing surface and that quota, token accounting, and pricing are absent locally. Open: the `result`-event token/cost field names.

## 6. Driving & input — two-way control

- **Send a new user message mid-session** — Interactive: type into the composer and submit with **Enter**; transport = type into the PTY (bracketed paste for multi-line) then CR **[established]**. Cursor is a bracketed-paste TUI. Headless is one-shot per process — "continue the conversation" = `--resume <chatId>` with a new `-p` prompt.
- **Read live composer/input-box contents (draft sync out)** — No API/OSC/transcript exposure of the live composer text; **screen-scrape the PTY composer region** only **[fallback / effectively not supported]**.
- **Pre-fill / set the input box (draft sync in)** — **No flag/env to pre-populate the composer without submitting [not supported].** Any injected prompt (argv/stdin) submits. This is why the trust-marker preflight matters (§2): a draft is delivered by post-ready bracketed paste, not by a native prefill flag.
- **Answer interactive prompts / permission menus** — Permission/approval prompts are TUI menus: select via **arrow keys + Enter** or number keys; read the option set by screen-scraping **[fallback]**. The **established** strategy is to avoid menus entirely: `--force`/`--yolo` (command permissions), `--approve-mcps` / `mcp enable` (MCP), `--trust` + `.workspace-trusted` (workspace), or pre-seeded `cli-config.json` allow/deny lists. Structured permission decisions can also be returned from a `preToolUse`/`beforeShellExecution` hook (`{"permission":"allow"|"deny"|"ask"}`, §8) — the cleanest programmatic gate.
- **Interrupt / cancel / escape** — **Ctrl+C** cancels the current turn; **Ctrl+D** exits the CLI (**double-press** required); **ESC** dismisses menus **[established]**.
- **Slash / special commands** — `/plan`, `/ask` (mode switch), `/summarize` (alias `/compress`, context compaction), `/resume`. Mode rotation (Agent → Plan → Ask) also via **Shift+Tab**. **Cloud handoff: a message prefixed with `&` dispatches to a Cursor cloud agent** (e.g. `& refactor the auth module`) **[established]**.
- **Attachments / large paste** — `@` opens a file/folder picker for context (file refs, not raw upload); large content via bracketed paste **[established]**. CLI image/attachment upload is unverified.
- **Important keyboard shortcuts (mobile soft-keys)** —
  - Submit: **Enter**. Newline: **Shift+Enter**, **Ctrl+J**, or **`\`+Enter**.
  - Mode rotate: **Shift+Tab**. Interrupt: **Ctrl+C**. Exit: **Ctrl+D ×2**.
  - History/prev message: **ArrowUp**. Review changes: **Ctrl+R** (then **i** for follow-up instructions; ArrowUp/Down scroll files, ArrowLeft/Right switch files).
  - Menus: **/** opens commands; **@** opens the file picker; **&** prefix = cloud agent.
  - Modifier fidelity: Shift+Tab, Ctrl+J/Ctrl+R/Ctrl+D need accurate Ctrl/Shift bytes; **no Alt/Option-specific bindings observed**.
- **Conflicts / open questions:** Both agree there is no native non-submitting draft prefill and no composer-read surface. The rich shortcut map and `&` cloud handoff are verified additions.

## 7. Agent-state classification

- **State vocabulary** — Map to `working | waiting (needs-user) | done | error | interrupted` (+ idle).
- **Signal sources (authority rank):**
  1. **Hooks** (Cursor 1.7+) — highest authority, structured. Events: `sessionStart`/`sessionEnd`, `beforeSubmitPrompt`, `preToolUse`/`postToolUse`/`postToolUseFailure`, `beforeShellExecution`/`afterShellExecution`, `beforeMCPExecution`/`afterMCPExecution`, `beforeReadFile`/`afterFileEdit`, `subagentStart`/`subagentStop`, `preCompact`, `stop`, `afterAgentResponse`, `afterAgentThought` **[established]**.
  2. **Headless stream-json events** — `system/init` (start), `assistant`, `tool_call` (`subtype: started|completed`), `user`, `result` (turn end). Authoritative for `-p` runs **[established]**.
  3. **Plaintext transcript** `*.jsonl` — `{"role":"user"|"assistant",...}` plus a terminal `{"type":"turn_ended","status":"success"}` line → `done` **[fallback]**.
  4. Process foreground/child presence, output activity, process exit — generic fallbacks **[fallback]**.
  - **Native OSC title carries no state**: the title is the literal static `"Cursor Agent"` for the whole turn and is re-emitted on every redraw. Treat it as a **no-op** — never let it reset synthesized state. There is **no OSC JSON status channel**.
- **Event → state mapping:**
  - `sessionStart` / `beforeSubmitPrompt` / `system.init` → **working**
  - `preToolUse` / `beforeShellExecution` / `beforeMCPExecution` / `tool_call.started` → **working** (treat pre-execution gates as working, not waiting, to avoid notification spam on tool-heavy turns)
  - a pre-execution gate returning/awaiting `"permission":"ask"` (or the TUI showing an approval menu) → **waiting**
  - `postToolUse` / `afterShellExecution` (success) → **working**
  - `postToolUseFailure` / `afterShellExecution` (nonzero) → surface error, stay **working** mid-turn
  - `stop` / `result` / `turn_ended:"success"` → **done**
  - `afterAgentResponse` after a `done` → enrich the final reply but do **not** resurrect to working; otherwise → working
- **"Stopped but needs user" detection** — Distinguished from `done` only via a pre-execution gate awaiting `"permission":"ask"` (`preToolUse`/`beforeShellExecution`/`beforeMCPExecution`/`beforeReadFile`) or the TUI approval menu (screen-scrape) **[established for hook builds; fallback otherwise]**. Note: `stop` carries a `status` — `status !== "completed"` → mark `interrupted: true`; `completed`/absent → clean `done`.
- **Reconciliation** — Authority: hooks > stream-json > transcript > output-activity. Reset the per-turn cache on `beforeSubmitPrompt`/`sessionStart` (new-turn boundary). `stop` fires once per turn; debounce `afterAgentResponse` against it. Generic quiet-window/stickiness on top. **Do not subscribe `sessionStart` as a state driver if its fire-time can race the first `beforeSubmitPrompt`** and reset the just-submitted turn's prompt cache.
- **Sub-agent / nested-task state** — `subagentStart`/`subagentStop` hooks expose nested tasks; correlate via `conversation_id`/`generation_id` in the payload.
- **Latency / debounce** — Hooks fire synchronously in the agent loop (sub-second); stream-json streams live; transcript `turn_ended` is written at turn end. Debounce output-activity ~300ms; dedup repeated working frames; keep hook callbacks best-effort (short connect/total timeouts, fail-open).
- **Conflicts / open questions:** Both agree hooks are authoritative and the native title is uninformative. One characterization treated pre-execution gates strictly as `working` (no distinct waiting state) because it relied on subscribing a narrower hook set and `--yolo` to avoid menus; the richer mapping above is available if you subscribe the gate events and inspect `"permission":"ask"` decisions. Use the gate-aware mapping when you want a true `waiting` state; fall back to "gates = working" when running fully autonomous with `--yolo`.

## 8. Hooks & instrumentation install

- **Supported?** **Yes [established]** (Cursor 1.7+) — managed shell-hook scripts. Each hook is a standalone process: structured **JSON in over stdin**, structured **JSON out over stdout** (+ exit-code semantics). `--plugin-dir <path>` (repeatable) loads local plugin dirs.
- **Install location** — `~/.cursor/hooks.json` (global) or `<repo>/.cursor/hooks.json` (project). No config-hash/trust step is required (unlike Claude Code) — just create the file. Schema:
  ```json
  { "version": 1,
    "hooks": { "<event>": [ { "command": "<cmd>", "type": "command"|"prompt",
                              "timeout": <ms>, "loop_limit": <n|null>,
                              "failClosed": <bool>, "matcher": "<regex>" } ] } }
  ```
  `command` paths are relative to the `hooks.json` location. A top-level `version: 1` is required (stamp it if absent). For robustness across schema drift, an installer can both emit and match `command` at the definition level **and** tolerate a nested `hooks[].command` shape.
- **Event taxonomy + payload fields** — Base stdin fields on every event: `conversation_id`, `generation_id`, `model`, `hook_event_name`, `cursor_version`, `workspace_roots[]`, `user_email` (nullable), `transcript_path` (nullable). Event-specific:
  - `beforeShellExecution` → `command`, `cwd`, `sandbox`
  - `afterShellExecution` → `command`, `output`, `duration`, `sandbox`
  - `afterFileEdit` → `file_path`, `edits[]` (`old_string`/`new_string`)
  - `preToolUse`/`postToolUse`/`postToolUseFailure` → `tool_name`, `tool_input`, `tool_use_id`, `cwd` (+ `tool_output` / `error_message`/`error` on failure)
  - `beforeMCPExecution` → `tool_name`/`tool_input`/`command`/`url`
  - `afterAgentResponse` → `text` (final reply)
  - `stop` → `loop_count`, `status` (completed vs interrupted)
  - prompt text comes from `beforeSubmitPrompt`.
- **Transport back / fail-open** — The hook **process** does the callback: POST to an orchestrator HTTP endpoint with a host/port/token baked into the configured `command` (e.g. `http://127.0.0.1:$PORT/hook/cursor` with an auth-token header). Post the raw fields form-urlencoded rather than hand-building JSON in POSIX shell (workspace/worktree ids can embed filesystem paths unsafe to splice into shell-quoted JSON). Make the script fail-open (`|| true`, `exit 0`; bail silently if port/token unset) and re-source any endpoint file first so a PTY that outlives an orchestrator restart reaches the **current** server. Output JSON governs the agent: permission hooks return `{"permission":"allow"|"deny"|"ask","user_message"?,"agent_message"?}`; `stop` returns `{"followup_message"?}`. **Exit-code semantics:** `0` = proceed, `2` = block (= deny); other codes **fail open** (proceed) unless `failClosed:true`.
- **Lifecycle** — Install = write `hooks.json` (+ scripts); update/uninstall = edit/remove; idempotent (declarative file) — sweep stale managed entries by script-filename match and drop managed entries from no-longer-subscribed events. `matcher` scopes a hook to tool names; `timeout`/`loop_limit` bound runaways. Version-skew: gate on Cursor ≥1.7 (hooks absent in older builds). Remote install over SFTP: write `~/.cursor/hooks.json` + the POSIX hook script (POSIX even when the orchestrator host is Windows), **script-then-config order** for safe partial failure.
- **Conflicts / open questions:** Both agree on the `~/.cursor/hooks.json` mechanism, stdin-JSON in / stdout-JSON out, and fail-open. The full base-payload field set (`conversation_id`, `generation_id`, `transcript_path`, `workspace_roots`, etc.) and the canonical schema (`version`, nested `hooks: {<event>:[...]}`, `matcher`/`timeout`/`loop_limit`/`failClosed`) are the documented shape; an installer should tolerate the flatter "`command` at definition level" variant for forward/backward compatibility.

## 9. Session titles

- **Source of truth** — **Agent/LLM-generated title** from the first turn, stored in `~/.cursor/chats/<md5cwd>/<chatId>/meta.json` → `title` and `store.db` meta `name` (e.g. prompt "hello" → `"title":"Hello There"`) **[established]**.
- **Read / update** — Read `meta.json` (`title`, `createdAtMs`, `updatedAtMs`, `hasConversation`); it is set server/agent-side after the first exchange (`updatedAtMs` advances). No push event — **watch the file**.
- **Fallback / synthetic scheme** — Before a title exists, synthesize from the first prompt (truncate the `<user_query>` text in the transcript) **[fallback]**. For the live terminal/tab title specifically, note the native OSC title is the static `"Cursor Agent"` (§7/§11); if the orchestrator drives its own terminal-title state machine (working spinner / idle / "action required"), it must re-assert that title against the CLI's per-redraw re-emission (see §11) rather than trust the OSC value.
- **Conflicts / open questions:** One characterization derived the tab title from the transcript's first user message and synthesized terminal titles from hook state; the other identifies the authoritative agent-generated `meta.json.title`. Prefer `meta.json.title` once it exists; use the first-prompt truncation only as the pre-title fallback.

## 10. Transcript & history

- **Storage** — Two representations per chat:
  - **Canonical (binary):** `~/.cursor/chats/<md5cwd>/<chatId>/store.db` — SQLite with `meta(key,value)` + `blobs(id TEXT PRIMARY KEY, data BLOB)`, a **content-addressed Merkle DAG**: `blobs.id` = sha256 of the blob; `meta` holds a hex-encoded pointer JSON `{"agentId","latestRootBlobId","name","mode","lastUsedModel",...}`. The root blob is a binary (flatbuffer/protobuf-like) node enumerating sections `system_prompt|tools|rules|skills|mcp|subagents|summarized_conversation|conversation`. Some leaf blobs are plaintext JSON (e.g. `{"role":"user","content":[{"type":"text","text":"<user_query>..."}],"providerOptions":{"cursor":{"requestId":...}}}`), others compressed/binary. **Treat as opaque** unless you need redacted content (see quirks).
  - **Plaintext (recommended for consumers):** `~/.cursor/projects/<slug>/agent-transcripts/<chatId>/<chatId>.jsonl` — newline-delimited JSON, one entry per message/event **[established]**. Verified shapes:
    - `{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\nhello\n</user_query>"}]}}`
    - `{"role":"assistant","message":{"content":[{"type":"text","text":...},{"type":"tool_use","name":"Read","input":{"path":...,"limit":40}}]}}`
    - `{"type":"turn_ended","status":"success"}`
- **Parsing / schema mapping** — Roles `user`/`assistant`. Content blocks: `{"type":"text"}` and `{"type":"tool_use","name","input"}` (tool name + args, e.g. `Read` with `path`/`limit`); tool results land in subsequent entries. Turn boundary = `{"type":"turn_ended","status":...}`. Per-message content can be read from `record.message.content ?? record.content`; the human-readable title is derivable from the first user message as a fallback (§9).
- **Live tail vs historical** — Tail the `*.jsonl` with a file watcher (append-only); historical = read the whole file; ordering = file order; dedup by index+content (no per-line id in plaintext). For **headless** consumers prefer the `stream-json` `assistant`/`tool_call`/`result` events over the file.
- **Consumers** — chat-view = text + `tool_use` blocks; preview/last-message = last `assistant` text; clickable items = `tool_use.input.path` (file refs) and diffs from edit/write tools; state classification = `turn_ended`/tool_use sequence (§7) or, preferably, hooks/stream-json.
- **Transcript ↔ terminal mapping** — The TUI renders its own view; the `*.jsonl` is the structured mirror; reconcile by chatId.
- **Special content types / quirks** — **Privacy/redaction is a major quirk:** with `cli-config.json` `privacyCache.privacyMode:2` / `ghostMode:true`, assistant/thinking text in the **plaintext** transcript is `[REDACTED]` — the real content then lives **only** in the binary `store.db`. Thinking-block display is also gated by `cli-config.json` `display.showThinkingBlocks`; thinking blocks may be present but redacted. Tool calls = `tool_use` blocks; diffs come from edit/write tools. Pasted-image storage via CLI is unverified.
- **Conflicts / open questions:** One characterization parsed only roles + message text + timestamps from the plaintext JSONL (no tool/diff/token mapping); the fuller picture is that the plaintext JSONL also carries `tool_use` blocks and `turn_ended`, and that a binary `store.db` Merkle DAG is the canonical (and only un-redacted) source. Token sums are absent from both representations (§5).

## 11. Terminal rendering & display fidelity

- **PTY → xterm byte path** — Generic: capture the PTY byte stream → xterm.js. The CLI is a full-screen **alt-screen TUI**; do not strip bytes except normal alt-screen chrome handling. The one Cursor-specific filter is at the **title layer**, not the byte layer: neutralize the native `"Cursor Agent"` OSC title as a no-op so per-redraw re-emissions can't reset synthesized state.
- **Resize / reflow** — Send **SIGWINCH** on cols/rows change; the TUI repaints on resize, so a resize nudge doubles as a clean redraw on reattach. Mobile↔desktop breakpoint remount is generic.
- **Scrollback model** — Native TUI alt-screen: the agent owns its history rendering and re-renders on resize; use the agent's own scroll (ArrowUp / the Ctrl+R review view) rather than xterm scrollback. Mouse is forwarded to the TUI.
- **Mouse forwarding** — Forward scroll/click into the TUI while attached (used for review/file nav); generic enable/disable on alt-screen enter/leave.
- **Snapshot/serialize for reattach** — Generic headless-xterm serialize + replay; on reconnect send a resize nudge to force a clean repaint over the cached frame.
- **Local cache → instant render then live reconnect** — Generic: persist the last serialized xterm buffer per session, show it instantly on return, reconnect the live PTY, and SIGWINCH to reconcile. Nothing Cursor-specific.
- **Composer / ready signal** — Composer is a bottom input line; "ready for paste" = after the TUI has drawn its prompt. Use a generic render-quiet-after-bracketed-paste readiness (DECSET `?2004h` then a quiet window, ~1500ms) rather than a source-backed composer glyph. **Working-state render quirk:** because the CLI re-emits its native title on every internal redraw, a single synthesized title frame is overwritten within milliseconds — drive a **persistent animated spinner re-asserted on a short interval (~80ms)** if you want a visible working title. Dim-placeholder composer-ready detection (as with Codex) likely applies but the exact bytes are unverified.
- **Color/theme/OSC quirks** — Standard ANSI/truecolor TUI; the only notable OSC quirk is the static-title no-op above; no OSC status channel.
- **Conflicts / open questions:** Both agree on the alt-screen/SIGWINCH model and the static-title no-op; the persistent-spinner re-assert interval and the exact composer dim-placeholder ready bytes are the implementation-specific/unverified pieces.

## 12. Background / headless invocation

- **Non-interactive** — **Yes, first-class [established].** `cursor-agent -p "<prompt>" [--output-format text|json|stream-json] [--force] [--model <id>] [--workspace <path>] [--trust]`. Prompt via trailing argv or **stdin**. `--print` has full tool access (write/shell) — gate with `--force`/`--sandbox`/permissions. Pass `--output-format` explicitly (help lists default `text`; community/docs note `stream-json` as the streaming default — do not rely on the default).
  - **stream-json events** (NDJSON, each carries `session_id`): `{"type":"system","subtype":"init","model":...}`; `{"type":"user","message":{...}}`; `{"type":"assistant","message":{"content":[...]},"timestamp_ms":...}`; `{"type":"tool_call","subtype":"started"|"completed","tool_call":{"shellToolCall"|"readToolCall"|"editToolCall"|"writeToolCall"|"grepToolCall"|"lsToolCall"|"globToolCall"|"deleteToolCall"|"todoToolCall":{"args":{...},"result":{...}}}}`; final `{"type":"result","subtype":...,"duration_ms":...}`. `--stream-partial-output` emits per-token text deltas (deltas carry `timestamp_ms` but no `model_call_id`). Token/cost fields on `result` are unverified.
  - **json** = single aggregated final object. **text** = plain answer text.
  - The `session_id` from these events is the chat id → feed to `--resume` for follow-ups.
- **Features that can use it** — Commit messages, PR titles/bodies, branch names, summaries, **model discovery** (`models`/`--list-models`), and `generate-rule`. A representative one-shot for plain text: `cursor-agent --print --mode ask --trust --output-format text --model <id> <prompt>`.
- **Auth path for headless** — `CURSOR_API_KEY`/`--api-key` (best for CI/multi-account) or the inherited `~/.config/cursor/auth.json`; add `--trust` for untrusted workspaces.
- **Cost/latency/timeout/caps** — No built-in `-p` timeout flag (wrap with your own). Latency depends on the model (`composer-2.5-fast` is the fast default). Runs locally; `worker` mode runs against Cursor's dispatch (§15). Note: a user-typed `cursor-agent --print ...` is not necessarily auto-classified as a hidden one-shot by a generic headless-command detector — register the binary explicitly if you want that behavior.
- **Conflicts / open questions:** Both agree headless is first-class and prompt-via-argv works. The full `stream-json` event/tool-call schema and `--mode`/`--output-format` matrix are the verified detail; `result`-event token/cost fields remain unverified.

## 13. Capabilities & quirks matrix

| Capability | Cursor Agent CLI |
|---|---|
| Resumable | **Yes** — `--resume [chatId]`, `--continue`, `resume`, `ls` |
| Pre-allocate session id | **Yes** — `create-chat` prints a UUID |
| Hooks | **Yes** — `~/.cursor/hooks.json` / `.cursor/hooks.json`, stdin/stdout JSON, 18+ events (Cursor ≥1.7) |
| Plugins | **Yes** — `--plugin-dir <path>` (repeatable) |
| Draft prefill (non-submitting composer) | **None** (argv/stdin submits; post-ready bracketed-paste fallback) |
| Read live composer text | **None** (screen-scrape only) |
| Trust preset | **Yes** — `.workspace-trusted` file (interactive) + `--trust` flag (headless only) |
| Interactive-prompt selection | TUI arrow/number keys; avoid via `--force`/`--yolo`/`--approve-mcps`/permissions or hook `permission` decisions |
| Title source | Agent/LLM-generated → `meta.json.title` / `store.db` `name` (native OSC title is a static no-op) |
| Transcript format | Plaintext NDJSON `agent-transcripts/<chatId>/<chatId>.jsonl` + binary content-addressed `store.db` (SQLite Merkle DAG) |
| Headless | **Yes** — `-p`/`--print` + `--output-format text\|json\|stream-json` |
| Model listing | **Yes** — `models` / `--list-models` (text only, no JSON) |
| Usage / quota readout | **No** CLI command (only `subscriptionTier` via `about`) |
| Token / cost accounting | **No** in transcripts; `result`-event tokens/cost unverified |
| Pricing | **No** local computation |
| Fast mode | **Yes** — `-fast` model-id suffix + `fast` modelParameter (`composer-2.5-fast` default) |
| Reasoning effort | Model-id suffix (`-low/-medium/-high/-xhigh/-max`, `-thinking-*`) — not a flag |
| YOLO / permission bypass | `--yolo` (= `-f`/`--force`) |
| Sandbox | `--sandbox enabled\|disabled` + config `sandbox.mode`/`networkAccess` |
| Prompt injection | argv (positional) or stdin; `--workspace` sets cwd |
| Worktrees | **Yes** — `-w/--worktree [name]` at `~/.cursor/worktrees/<repo>/<name>`, `--worktree-base`, `.cursor/worktrees.json` |
| ACP server | **Yes** — `cursor-agent acp` (Agent Client Protocol, stdio JSON-RPC) |
| Cloud worker | **Yes** — `worker start` (Cursor-hosted dispatch) |
| MCP | **Yes** — auto-reads `.cursor/mcp.json`/`~/.cursor/mcp.json`; `mcp list/login/list-tools/enable/disable`, `--approve-mcps` |
| Cloud handoff | **Yes** — `&`-prefixed message dispatches a Cursor cloud agent |
| Multi-account isolation | `CURSOR_API_KEY`/`--api-key` per spawn (preferred); per-`HOME` (no `--config-dir`/`--profile`) |
| Remote (SSH) | **Yes** — generic SSH; POSIX hook script + tunneled callback port |

**Special-cases / workarounds:**
- Binary is `cursor-agent`; internal/usage name is `agent` — docs examples may say `agent`.
- `models`/`--list-models` has no JSON output — parse `id - name` lines.
- **Privacy mode redacts the plaintext transcript** (`[REDACTED]`); use stream-json events or the binary `store.db` for full content.
- `create-chat` writes a chat dir on every call — pre-allocate once, reuse, reap empties.
- Two keys for one session: chats dir = `md5(cwd)` (no trailing slash); projects dir = slug (`/`→`-`). Watch both.
- Reasoning effort and fast-mode are **model-id suffixes**, not flags.
- `--trust` is headless-only; interactive trust is the `.workspace-trusted` marker file.
- Native title `"Cursor Agent"` is static and re-emitted per redraw — neutralize it and (optionally) drive a re-asserted spinner for working state.
- Pre-execution gates can be mapped to `working` (autonomous/`--yolo`) or to `waiting` when you inspect `"permission":"ask"`.
- No `--config-dir`/`--profile`; multi-account = `CURSOR_API_KEY` per spawn.

## 14. Failure, exit & recovery

- **Crash/exit detection** — Headless `-p` exits with a process exit code (0 = success); errors print to stderr and the `result` event carries a non-success `subtype` (and likely an `is_error` flag — field name unverified). Plaintext transcript `turn_ended.status` is `"success"` on clean completion; any non-`success` status = error/interrupted. At the hook layer, `stop.status !== "completed"` → `interrupted: true`. Distinguish clean done (`turn_ended:success` / `result` / `stop:completed`) from a crash (nonzero exit, **no** terminal `turn_ended`).
- **Reattach-after-restart healing** — Generic: for PTY sessions, reattach via the multiplexer on daemon restart and heal "exited-but-alive" rows by checking the multiplexer master; the hook script's endpoint re-sourcing lets a surviving PTY resume reporting to the new server. For headless there is no live process — re-`--resume` the chatId. **Reap orphans** left in `~/.cursor/projects/<slug>/` after a crash: stray `worker.sock` and long-running child processes (e.g. a `typescript-language-server` shown in `worker.log`).
- **Error surfacing** — stderr text; nonzero exit; `result.subtype`/`is_error` (unverified); `postToolUseFailure`/`afterShellExecution` (nonzero) hooks → carry `tool_output`/`error_message`/`error` (surface as the last message, state stays working mid-turn); `turn_ended.status != success`. The synthesized "Cursor - action required" title is an attention cue but is only meaningful if you drive a waiting/permission state yourself (§7/§9).
- **Conflicts / open questions:** Both agree on `turn_ended.status` / `stop.status` as the clean-vs-interrupted signal; the `result.is_error`/token fields are unverified.

## 15. Remote / transport

- **Local** — Full support: PTY (interactive) or piped child (headless) **[established]**.
- **SSH (remote worktree)** — Generic SSH transport works: spawn `cursor-agent` on the remote, forward the PTY; auth via the remote `~/.config/cursor/auth.json` or `CURSOR_API_KEY` in the remote env. Install the hook over SFTP (`~/.cursor/hooks.json` + a POSIX hook script, script-then-config order), and **tunnel the hook callback port** back to the orchestrator host so the remote hook's `POST 127.0.0.1:$PORT/hook/cursor` reaches the relay **[established]**.
- **Daemon-subprocess** — Preferred for this orchestrator: the daemon hosts the PTY + multiplexer; hooks POST back to the daemon's injected port/token; headless runs spawn as daemon children with stream-json piped **[established]**.
- **Cursor-native non-PTY transports** — Two first-class alternatives to PTY scraping: **(a) `cursor-agent acp`** — an Agent Client Protocol server over **stdio JSON-RPC**, letting a custom client drive the agent with no terminal (cleanest programmatic integration; schema = the ACP spec). **(b) `worker start`** — a private cloud worker that connects outbound to Cursor and runs agents in your environment, with `--management-addr` exposing `/healthz`,`/readyz`,`/metrics`, pool/shared assignment, labels, and `--auth-token-file`/`--worker-dir` **[established]**.
- **Forwarding ops** — git/fs ops run wherever `cursor-agent` runs (cwd / `--workspace`); instrumentation = hook-process HTTP callbacks (must reach the orchestrator) or stream-json piped over the relay. Remote hook scripts are always POSIX, even when the orchestrator host is Windows.
- **Conflicts / open questions:** Both agree local/SSH/daemon all work with no agent-specific blocker beyond the POSIX-only remote script and the tunneled callback port. The ACP method set defers to the Agent Client Protocol spec.

---

## Open questions / unverified

- Exact `result`-event token/cost field names in `stream-json` (`input_tokens`/`output_tokens`/`total_cost_usd`/`is_error`) — docs did not confirm; verify with one safe `-p --output-format json` capture.
- Whether all config paths honor a redirected `$HOME` for per-account isolation (no `--config-dir`/`--profile` exists; `auth.json` and `~/.cursor` appear `$HOME`-relative on disk).
- CLI image/attachment upload mechanics, and pasted-image storage in the transcript.
- Composer dim-placeholder "ready for paste" exact bytes (Codex-style detection likely applies but unconfirmed).
- The persistent-title re-assert interval needed to defeat per-redraw OSC title re-emission (~80ms observed in practice; tune empirically).
- ACP JSON-RPC method set (defer to the Agent Client Protocol spec).
- Token-refresh client-id/endpoint (only the cached `backendUrl: https://api2.cursor.sh` is observed).
- Whether any in-TUI slash command switches the model mid-session (effort/fast switching mid-session otherwise = pick a different suffixed id in the model picker).
