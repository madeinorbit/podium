# Agent-harness interaction taxonomy

A reference taxonomy of **every way an orchestrator touches an external coding-agent CLI** ("the harness") — used to drive a remote/web/mobile multi-agent UI. It is the template for per-agent reference docs: produce one document per supported coding-agent CLI, answering every question below.

For each question, the per-agent doc should record one of:
- **method + evidence** — how it's done, with a concrete pointer (file/path/flag/sequence);
- **falls back to generic X** — no agent-specific handling, the generic path applies;
- **not supported** — the agent can't do this / no known method.

Make gaps as visible as implementations. Where multiple methods exist, enumerate *all* of them and note which is authoritative/preferred.

---

## 1. Discovery & identity
*Scope: detecting the binary, its version/capabilities, and finding existing sessions and tying them to a workspace.*
- How is the binary detected (name, aliases, PATH, any rename/remap)? How is "installed?" decided?
- Is version detected? Does behavior gate on version (hook/resume/flag availability)?
- How are *existing* sessions discovered (on-disk session/transcript files, project dirs, a DB)? Exact paths/globs.
- What is the stable session identity (UUID, resume id, transcript path, an id emitted via OSC)? How is it obtained at launch vs. for a pre-existing session?
- How is a session mapped to a repo/worktree/cwd (and back)?

## 2. Launch & process model
*Scope: how the agent is actually started and hosted.*
- Spawn mechanism: direct exec vs. shell-PTY-with-typed-command? What hosts the PTY (local/remote/daemon)?
- Full launch command + default args + env. What env is injected (instrumentation vars, CONFIG_DIR/HOME) and what is stripped (e.g. API keys)?
- Durable backing for survival across restarts/detach (tmux/abduco-style multiplexer)?
- Initial-prompt injection mode: `argv` / `flag-prompt` / `flag-interactive` / `stdin-after-start` / type-after-ready — which, and exact mechanics (quoting, bracketed paste, CR timing)?
- First-run/trust handling: how is the trust/onboarding menu pre-seeded so the first prompt isn't eaten (pre-written config/markers, trust presets)?
- Permission/YOLO/sandbox modes: which flags, defaults, how exposed.
- **Model, reasoning-effort, and fast-mode selection at launch:** how each is passed (flag/env/config). Does this agent have a "fast mode" concept, and how is it toggled? (Model *listing* is covered in §5.)

## 3. Resume & reattach
*Scope: re-entering an existing session and surviving orchestrator restarts.*
- Does the agent support resume? Exact flags/ids (`--resume`, `--continue`, session id) and where the id comes from.
- What state is restored on resume vs. lost (history, model, cwd, permissions)?
- How does the orchestrator reattach to a still-running PTY after a daemon/server restart? Any redraw/replay needed?
- Idempotency/race hazards to guard against on reattach.

## 4. Auth & subscription
*Scope: how this agent authenticates and how the orchestrator reuses it.*
- Credential location(s): file path(s), Keychain/secret-store service names, env vars.
- Reuse model: spawn-and-let-CLI-auth vs. orchestrator-managed multi-account (capture/store/materialize/switch)? Which path applies?
- Token refresh: who refreshes, against which endpoint/client-id, write-back behavior.
- Env hygiene: which inherited keys are stripped to force the CLI's own creds.
- Multi-account support: how distinct accounts are isolated and selected.

## 5. Models, usage & accounting
*Scope: enumerating models, and reading usage/quota/cost.*
- **Model listing for a settings UI:** how does the orchestrator enumerate the models this agent supports (a `models`/`--list-models` subcommand, config file, provider API)? Output format and freshness.
- Runtime model / reasoning-effort / fast-mode switching mid-session (vs. launch-time in §2): possible? how?
- **Usage windows / quota / rate-limits:** can the orchestrator read remaining quota, reset windows, rate-limit status? Endpoint/file, auth used, fields available.
- **Token accounting for analytics:** are per-turn / per-session input/output/cache/reasoning token counts available? From where (transcript fields, hooks, API response headers)?
- **Pricing / cost:** is cost computed or exposed anywhere? Source of pricing data; per-model rates.

## 6. Driving & input — two-way control
*Scope: programmatically steering a live session.*
- Send a new user message mid-session: exact transport (type into PTY? bracketed paste? CR vs. separate submit? single- vs multi-line semantics, newline key).
- Read the agent's current input-box contents (for chat↔composer draft sync): possible? how (screen scrape, OSC, transcript, dim-placeholder detection)?
- Pre-fill / set the input box from the orchestrator (draft sync the other way): flag, env var, typed paste, or none.
- Answer interactive prompts / AskUser / permission menus: how a choice is selected (arrow keys, number keys, specific byte sequences), how the *set of options* is read, how the prompt is detected as present.
- Interrupt / cancel / escape the current turn (Ctrl+C, ESC, double-tap) — exact keys and effect.
- Slash commands / special in-agent commands the orchestrator issues.
- Attachments (files/images) and paste of large content.
- **Important keyboard shortcuts & modifier keys** (so the orchestrator can surface the right soft-keyboard keys on mobile): enumerate the shortcuts that matter — submit, newline, interrupt, history nav, menu/option nav, slash, mode toggles, accept/reject — and their key bytes. Note any that require Alt/Option/Meta fidelity.

## 7. Agent-state classification
*Scope: deciding working / idle / waiting-on-user / blocked / done / error.*
- What state vocabulary does this agent map into (e.g. `working|blocked|waiting|done` + interrupted)?
- Enumerate **every signal source** and its authority rank: hooks (which events), OSC title, an OSC JSON status channel, transcript events, process foreground/child-process presence, process exit, output activity.
- Exact event→state mapping table (e.g. tool-start→working, permission-request→waiting, stop→done).
- "Stopped but needs the user" detection specifically (permission request, AskUser, plan approval) — how distinguished from "done."
- Reconciliation: dedup / quiet-window / stickiness rules; how conflicting signals resolve.
- Sub-agent / nested-task state and identity inheritance.
- Latency: how fast each signal fires; debounce.

## 8. Hooks & instrumentation install
*Scope: the machinery that makes §7 authoritative.*
- Does this agent support hooks/plugins/extensions? Which mechanism: managed shell-hook script, in-process JS plugin, in-process TS extension, none?
- Where is the hook installed (settings file path, plugins dir, config), and what trust steps are required (e.g. config-file hash entries)?
- Hook event taxonomy emitted by this agent + payload fields worth extracting.
- Transport back to the orchestrator (HTTP callback with injected port/token, file, socket) and fail-open behavior.
- Lifecycle: install/update/uninstall, idempotency, version-skew handling.

## 9. Session titles
*Scope: naming a session/tab.*
- Source of truth: agent-generated title, OSC title sequence, first-prompt regex/truncation, or LLM-generated?
- How/when read and updated; eventing.
- Fallback when none exists; any "synthetic title" scheme.

## 10. Transcript & history
*Scope: structured conversation data behind the terminal.*
- Storage: path/format (JSONL schema, SQLite, etc.); one file per session?
- Parsing: message roles, tool calls, thinking/reasoning, diffs, errors — schema mapping.
- Live tail vs. historical read: mechanism, how new entries are detected, ordering/dedup.
- Consumers and what each needs: chat-view rendering, last-message/preview, clickable items (file refs, tool calls, diffs), state classification.
- Mapping transcript ↔ terminal display (reconciling the two views).
- **Special content types & per-agent quirks:** how are images, file attachments/references, diffs, tool outputs, thinking blocks, and redacted/internal entries represented? Call out agent-specific handling (e.g. how a given CLI stores pasted images or file refs).

## 11. Terminal rendering & display fidelity
*Scope: making the PTY render correctly in a browser xterm across devices.*
- PTY capture → stream → xterm.js: byte path, any filtering (alt-screen chrome stripping, OSC interception).
- Resize/reflow: how cols/rows changes are sent (SIGWINCH), redraw nudges for TUIs that only repaint on resize, mobile↔desktop breakpoint remount handling.
- Scrollback model: native TUI alt-screen (mouse forwarded, agent re-renders) vs. xterm scrollback (orchestrator-owned) — which does this agent use, and how is scrolling the agent's own history vs. the input box driven/signaled?
- Mouse forwarding (scroll/click) into the TUI; when enabled/disabled.
- Snapshot/serialize for reattach (headless xterm + serialize): what's persisted/replayed.
- **Local cache for instant render then live reconnect:** can the orchestrator persist the last serialized buffer/screen so a returning user sees content *instantly*, then transparently reconnect the live PTY and reconcile/update? What is cached, where, and how is the cached→live handoff done without flicker or duplicated output?
- Composer/cursor specifics (dim-placeholder detection, ready-signal for paste, cursor positioning).
- Color/theme/OSC handling quirks.

## 12. Background / headless invocation
*Scope: using this agent for the orchestrator's own one-shot LLM work.*
- Can the agent be invoked non-interactively? Exact one-shot argv + output format + prompt delivery (stdin/flag).
- Which features could use it (commit msg, PR title/body, branch name, summaries, model discovery)?
- Auth path for headless (inherited account, env prep).
- Cost/latency/timeout/output caps; local vs. remote execution.

## 13. Capabilities & quirks matrix
*Scope: the per-agent feature/flag truth table that drives all the above.*
- A boolean/enum matrix: resumable? hooks? draft prefill (flag/env/none)? trust preset? interactive-prompt selection? title source? transcript format? headless? model listing? usage/quota? fast mode?
- Known agent-specific special-cases and workarounds (binary remaps, arg sanitization, unsupported-flag stripping, composer-ready signals, etc.).

## 14. Failure, exit & recovery
*Scope: what happens when things go wrong.*
- Crash/exit detection: exit codes, how distinguished from clean completion.
- Reattach-after-restart healing (exited-but-alive rows, orphan/zombie reaping).
- Error surfacing to the user (which signals indicate error state).

## 15. Remote / transport
*Scope: where the harness can run.*
- Local vs. SSH (remote worktree) vs. daemon-subprocess: which transports support this agent and any agent-specific limitations.
- How PTY/git/fs ops and instrumentation callbacks are forwarded over the relay for remote sessions.
