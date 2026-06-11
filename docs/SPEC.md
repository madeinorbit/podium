# Podium — Spec

## 1. What it is

A control plane for running many real agent sessions (Claude Code, Codex CLI, more later) across machines, repos, and worktrees — from desktop or mobile. Podium runs the **native** agent CLIs, reusing your existing subscription/API auth. It manages your agents; it doesn't replace your workflow with a ticketing system.

**One-liner:** mission control for your agents, not a wrapper around them.

## 2. Principles

These are load-bearing. When a decision is ambiguous, these break the tie.

1. **Native, not wrapped.** Run the real CLI (via tmux-style PTY), reusing native auth. No `claude -p`, no abstraction that hides output or blocks direct input. *(Exception: explicit opt-in wrapped modes, e.g. low-bandwidth view.)*
2. **Fit the user's workflow.** Adapt to their existing repos, worktrees, and harnesses. Don't impose scrum/kanban or a new process.
3. **Attention-first.** The product's core job is surfacing *where the human is needed* — ask-user tools, blocked agents, errors, limits.
4. **Mobile is first-class.** Every capability works on mobile; seamless handoff when you move between devices.
5. **Offline-first.** Works under spotty connections; degrades gracefully.
6. **Flexible scale.** One binary on one machine → separate server + many dev machines + many clients, same product.
7. **Open source.**

## 3. Architecture

```
Clients (web: mobile + desktop; native apps later)
        │
     Server  ── API / web backend, sync engine. Can live apart from dev machines.
        │
     Daemon  ── installed per dev machine (mac laptop, Linux VPS…). Interfaces with harnesses.
        │
   Harnesses ── native agent CLIs wrapped in tmux. Full terminal: view, type, scroll.
```

- **Sync engine** powers offline-first; tolerant of bad networks.
- **Later:** cloud sandboxes for agents.

## 4. Core concepts

| Term | Meaning |
|------|---------|
| **Harness** | A native agent CLI (Claude Code, Codex) running in a tmux-wrapped PTY. |
| **Session** | One running agent or shell instance. |
| **Work pane** | A named panel holding a session (agent or shell). Named auto-by-content or by the user. |
| **Stream** | A unit of work spanning multiple tasks/stages (spec → build → bugfix). Multiple agents can share its context. User can pin, ice, or archive a stream even if unfinished. |
| **Superagent** | The always-there orchestrator agent that can start/stop/monitor other agents and reason across all projects. |

## 5. Features

### 5.1 Onboarding & discovery
- Auto-discover installed/configured harnesses on a machine. *(Best-in-class bar: Multica.)*
- From the location of recent conversations, infer active projects/repos and the user's worktree flow; suggest the right worktree settings.

### 5.2 Command Center
The main surface. One place to see where attention is needed. Three modes:

- **Dev mode** — configurable terminal grid (tmux-like; bar: Dorothy's "Terminals"). Recent sessions listed at top. One click to browser (testing) or diff/code (manual edits).
- **Product mode** — *what* you're working on: status, what's next, plan. Each task shows running/done; click into the terminal. Superagent reads each agent's outcome and keeps a concise status per stream — reuse the agent's own recaps where possible (Claude emits `away_summary`, shown as "recap: …", in the transcript). Organized by **Stream**.
- **Spec mode** — meta-chats about product/specs. Main view is a markdown/HTML doc you can jump into discussion on. The agent always has context for where in the doc you are; instructed to research decisions and ask you questions. The mode where the human supplies context and makes executive calls, then agents run.

Cross-mode: see every active session; see where human attention is needed; group work into projects/epics/features (lightweight, names TBD — traditional scrum terms may not fit); visualize memory pressure and one-click-stop idle agents.

### 5.3 Superagent (orchestrator)
- Starts, stops, monitors agents. Full cross-project context, so it can start new projects.
- Context adapts to where the user is — a cross-agent "/btw" you can drop into any area, active agent, or ticket.
- Discuss new features or whole project ideas with it to drive progress; it handles chores (worktree setup, server debugging).
- One click to start an agent **at the right altitude**: superagent (all projects) → repo/worktree → a specific code directory.
- Configurable harness / model / subscription / provider.

### 5.4 Harness terminal
The hard technical bar. Split into **fidelity** (must work) and **intelligence** (smart layer). **All of this works on mobile and desktop.**

**Fidelity — must work:**
- Scroll back through conversation history.
- Copy/paste **both directions** — agent → local machine, and local → any agent input field (mouse-select on desktop, finger-select on mobile).
- No zoom issues (e.g. no accidental mobile zoom when tapping an input).
- Explicit spectate ↔ control switch where needed.
- Take over the terminal's name (Claude `/rename`, tmux equivalents) as the work-pane name; generate one if unset.
- *(Stretch)* image paste.
- *(Optional)* toggle native ↔ parsed view.

**Intelligence — the smart layer:**
- **Accurate state detection** — distinguish: ask-user tool, agent waiting (optionally summarize the question), server error (rate limit / capacity / 500), usage-limit stop.
- Clickable source-file links → jump to the cited line.
- Inline screenshot/image viewing — Claude marks these with `[image]` / `[file]` tags (verify structure; see the 2026-06-02 15:23 message); show an icon inline, open on click.
- History minimap (Sublime-style) and/or quick-jump to the last user prompt.
- Stop an agent at a cost limit or session-% limit.
- Auto-retry on errors (rate limits etc.).
- **Browser-open hijack** — agents/shells on the remote server try to open URLs (e.g. auth). Intercept the OS open mechanism, show a "app tried to open a URL" popup so the user can complete auth; let them paste the callback link for us to curl server-side.
- **Low-bandwidth mode** — locally cached, high-fidelity history view (Claude/ChatGPT-app quality) for bad connections or mobile reflow failures, plus a native input field that writes through to the harness.
- *(Acknowledged-risk feature)* **Scheduled / after-hours start** — kick a task at a set time, or "after hours" (evening in user's TZ + 4h idle). Gated behind explicit acknowledgement: we start an *interactive* session to be picked up (not `claude -p`), but the terms are ambiguous about this.

### 5.5 Conversation history & search
- Index **every** conversation found on any attached machine — unified across Claude Code, Codex, future agents. Backed up and tracked.
- Hybrid full-text + semantic search across all content.
- Read old conversations **without** starting the agent. Resume easily; restart/continue in **another** agent via a cross-agent handoff bundle (summary, repo state, relevant files, prior decisions, open tasks).
- Auto-generated good titles + topic/status summaries.
- Grouping by task/goal, project, code area, files touched, or intent.
- Relationship graph: forks, spawned subagents, resumed/follow-up sessions; detect duplicates/related sessions and merge into one thread.
- Extracted artifacts: files, commands, branches, commits, PRs, issues, plans, todos.
- Status signals: completed / blocked / abandoned / awaiting review / dirty workspace / failed tests.
- Curation: pins, tags, favorites, archive.
- Privacy: ignored paths, redaction, local-only indexing, "do not summarize" flags.
- Surface "similar past work" in the sidebar when starting a new session.

### 5.6 Context management
When starting work (feature/project): inject concise starting context auto-distilled from existing conversations; fork full context; merge results back into the parent agent.

### 5.7 Skills & MCP management
Cross-harness. Install once, toggle access per harness, including credential management (env-var injection).

### 5.8 Notifications
- Reliable across harnesses; not fooled by auto mode.
- Smart per-platform routing (desktop/mobile): if you're active on desktop and saw it there, don't also push to mobile.

### 5.9 Analytics & usage
- Subscription usage/limits at a glance; **burn meter** across all active sessions, projecting whether you'll hit the session/weekly limit before reset (smart projection, not naive current-rate).
- Projected cost if off subscription; cost per behavior; projected cost under a different agent/model.

### 5.10 Process & resource management
Auto-hibernate inactive sessions to save memory; browse history while hibernated; one-click resume.

### 5.11 IDE essentials (minimal)
- Small code viewer/editor — for the rare `.env` edit or quick look.
- Git: diff view (toggle to tree view), submodule support.

### 5.12 Shell access
Direct access to the work server's default shell; progress indicator while a command runs.

## 6. Cross-cutting requirements

- **Sticky / restored state.** On reload or when switching worktrees, return to where you were: same panes selected, same worktree, same UI state. Same on mobile. Sticky URL ties to the same shell/agent.
- **Mobile parity** for every feature above.
- **Offline-first** behavior throughout.

## 7. Vibes
Slightly playful and opinionated, but clearly for serious work. No Starship-Enterprise holodeck futurism.

## 8. Podium-specific touches
- On the user's **second day**, non-intrusively (no popup/block) ask for a GitHub star.
- A playful **About** page.
