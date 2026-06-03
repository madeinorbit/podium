# Web UI rebuild — workspace shell

- **Date:** 2026-06-03
- **Status:** Approved (brainstorm) — pending spec review
- **Branch:** `web-ui-rebuild`

## Problem

The prototype merged into `main` (`apps/web/src/App.tsx`, 2,306 lines + `App.css`,
1,271 lines) is a fake "Command Center": entirely mock data, no connection to the real
backend, and an over-built information architecture (streams, attention queues, usage
ledgers, spec studios). It is a dead end. Throw it away and build a small, real UI on
top of the working slice we already have.

The working slice — none of which we rewrite, only re-skin/restructure:

- `@podium/agent-bridge` discovery: `scanAgentConversations` (Claude + Codex history),
  `scanGitRepositories` / `scanGitRepositoriesAtPath` / `findGitWorktrees` (repos +
  worktrees), and `agentLaunchCommand` (fresh vs resume spawn).
- `apps/server` relay + tRPC: `sessions.list/create/resume/kill`, `discovery.scan`
  (conversations), and a WebSocket relay between browser clients and one daemon.
- `apps/daemon`: spawn/kill/input/resize/redraw + conversation `scan`.
- `@podium/terminal-client`: `SocketHub`, `mountSession`, the mobile key toolbar, and
  controller/spectator control transfer.
- `apps/web/src/LiveSessions.tsx` — the real (but bare) component that already lists live
  sessions, creates/resumes/kills them, lists discovered conversations, and mounts a
  terminal. This is the functional reference; its primitives are reused, its UI replaced.

## Goals

Build a responsive web UI that does exactly this, and nothing more for now:

1. **Find repos and worktrees** using the git-discovery library, with an **Add repo**
   action in v1.
2. **Find conversation history** for Claude Code and Codex using the conversation-scanner
   library.
3. **Start a new session** in a chosen worktree for a chosen agent, **or resume** an
   existing conversation — driven in a terminal.

It must work well on desktop and mobile with real handover between them.

## Non-goals (deferred — the model accommodates them, v1 does not build them)

Creating new worktrees/branches; terminal and browser panel *types* (only the agent panel
type ships); full nested tiling (v1 caps at a single 2-way split); auth tokens on the
relay; conversation search/ranking; PR/diff/cost/activity panels; multi-daemon/backend
selection.

## Reference

Conceptual inspiration only from `frenchie4111/harness` (sidebar navigator + tabbed,
tileable main area + first-class mobile + shared-backend handover). **No code is copied
from harness.** We build our own components on our own primitives.

## The model

- **Work panel** — a thing you interact with in the main area. v1 ships one type: an
  **agent panel** (a Claude or Codex session rendered as a terminal). Terminal and browser
  panels are future types the model leaves room for.
- **Workspace** — the main area for the selected worktree: a **tab bar** over a pane
  region holding **one or two panes** (a single row/column split). Each pane has its own
  tab strip; each tab is a panel; one panel is active per pane.
- **Sidebar (navigator)** — `Add repo` button → repos → worktrees (status dot + branch),
  and under each worktree the live agent panels open in it. Selecting a worktree makes it
  the active workspace.
- **New-panel menu** (`+`) — New Claude / New Codex / **Resume…** (matched conversation
  history). Resuming spawns an agent panel in the current worktree.

## Handover principle (the desktop ↔ mobile split)

- **Server-authoritative, shared across all clients:** the repo-root registry; discovered
  repos/worktrees/conversations; and **live sessions** (`SessionMeta`, pushed via
  `sessionsChanged`). Both desktop and phone see the same sessions and can take control —
  `@podium/terminal-client` already implements controller/spectator transfer and redraw.
- **Client-local view state:** selected worktree, the pane split (orientation + 1-or-2),
  and the active tab per pane. Desktop tiles; mobile shows exactly one panel.
- **Derivation, not duplication:** a worktree's tabs = the live sessions whose `cwd`
  equals that worktree's path. No separate "open set" is tracked — opening the app on a
  phone shows the same sessions, arranged in the mobile layout.

## Desktop layout

```
┌────────────────┬─────────────────────────────────────────────┐
│ + Add repo     │  ◧ claude 🟢 │ ▭ … │ + │              ⊟ split │  ← tab bar
│ WORKTREES      ├──────────────────────┬──────────────────────┤
│ ▾ podium       │                      │                      │
│  ▾ 🟡 relay ◀  │   pane A (active)     │   pane B (optional)  │
│     ◧ claude 🟢│   terminal            │   terminal           │
│     ＋ new      │                      │                      │
│  ▸ 🟢 main     │                      │                      │
│ ▸ other-repo   │                      │                      │
└────────────────┴──────────────────────┴──────────────────────┘
```

- Status dot reflects session status (`starting` / `live` / `exited`) from `SessionMeta`.
- `⊟ split` toggles a second pane (a **column** split by default — two side by side; a
  row orientation toggle is optional polish). Closing the last tab in a pane removes the
  split.

## Mobile layout

Same backend, folded — no tiling:

- **Header:** worktree-picker button (repo label + branch + chevron) | the active pane's
  horizontal tab strip (status dots) | `+`.
- **Body:** one full-screen agent panel.
- **Key toolbar** above the soft keyboard (esc / tab / ^C / arrows) — provided by
  `@podium/terminal-client`'s toolbar; the existing `--viewport-h` coupling keeps it above
  the keyboard.
- Tapping the worktree name opens a **full-screen picker sheet**: repos → worktrees with
  status dots. `+` opens the same New-panel / Resume menu as desktop.

Responsive switch is a single breakpoint (desktop shell vs mobile shell).

## Backend additions (the only new wiring)

Git discovery exists in the library but is not on the wire. Add a **repos** plane that
mirrors the existing conversation `scan` round-trip exactly.

### `@podium/protocol` (`messages.ts`)

- `GitWorktreeWire` = `{ path, branch?, headSha?, locked?, prunable? }`.
- `GitRepositoryWire` = `{ path, kind, branch?, headSha?, originUrl?, worktrees: GitWorktreeWire[] }`.
- `GitDiscoveryDiagnosticWire` = `{ severity, path, message }`.
- Server→daemon: `ScanReposRequestMessage` = `{ type:'scanReposRequest', requestId, roots: string[] }`
  — add to `ControlMessage`.
- Daemon→server: `ScanReposResultMessage` =
  `{ type:'scanReposResult', requestId, repositories: GitRepositoryWire[], diagnostics: GitDiscoveryDiagnosticWire[] }`
  — add to `DaemonMessage`.
- Codec round-trip tests mirror `messages.test.ts`.

### `apps/daemon` (`daemon.ts`)

- Handle `scanReposRequest`: for each root call `scanGitRepositoriesAtPath(root)`, map
  `GitRepositorySummary`/`GitWorktreeSummary` → wire (drop non-JSON fields like `gitDir`),
  aggregate diagnostics, reply `scanReposResult`. Tolerates unreadable roots (the scanner
  already emits diagnostics rather than throwing). Mirrors the existing `scan` handler.

### `apps/server`

- **Repo-root registry** — a small class persisting an array of absolute path strings to a
  JSON file (default `~/.podium/repos.json`, overridable via `PODIUM_STATE_DIR`). API:
  `list()`, `add(path)` (validate non-empty + absolute, dedupe), `remove(path)`.
- **`SessionRegistry.scanRepos(roots)`** — same pattern as `scan()`: a `pendingRepoScans`
  map keyed by `requestId`, a timeout fallback, and resolution on `scanReposResult`.
- **tRPC** (`router.ts`): `repos.list`, `repos.add({ path })`, `repos.remove({ path })`,
  and `discovery.scanRepos` (reads registry roots → `scanRepos`). `discovery.scan`
  (conversations) is unchanged.

## Front-end plan (`apps/web`, fresh)

Reuse `trpc.ts` and `@podium/terminal-client` (`SocketHub`, `mountSession`, toolbar).
Delete `App.tsx`, `App.css`, `LiveSessions.tsx`; update `index.html` title/description.
New, focused modules (our code — harness is conceptual reference only):

- `ConnectScreen` — enter relay URL (`?server=ws://…` preserved); the v1 connection model.
- `store` — connects the hub + tRPC; holds server feeds (repos, worktrees, conversations,
  sessions) and derives the worktree↔session↔conversation relationships; holds client view
  state (selected worktree, split, active tabs).
- `AppShell` — responsive desktop/mobile switch.
- `Sidebar` — repos → worktrees → live agent panels; `Add repo` (path input + Add); status
  dots.
- `Workspace` — tab bar + 1–2 pane split; `+` → `NewPanelMenu`.
- `AgentPanel` — mounts a terminal for a session via `mountSession`; `Take control`.
- `NewPanelMenu` — New Claude / New Codex / Resume… (lists matched conversations).
- `MobileApp` — header (picker button + tab strip + `+`), single panel, picker sheet.

### Conversation ↔ worktree matching

`discovery.scan` returns conversations with `projectPath` and `git`. For a worktree, a
conversation matches when `projectPath === worktree.path`. The worktree's Resume list shows
its exact matches. The repo's Resume fallback shows any conversation whose `projectPath` is
under the repo root but matched no worktree (deduped). Unmatched-everywhere conversations
are reachable from a repo-level "Resume…" so none are lost.

## Resolved decisions

- **Styling:** lightweight plain CSS + design tokens (CSS variables), dark theme. No
  Tailwind / toolchain change.
- **Repo registry persistence:** server-side JSON file, so the repo list is shared and
  survives — required for handover (add on desktop, see on phone).
- **Connection:** keep the `?server=ws://…` connect screen for v1 (no auth token yet).
- **Add repo input:** a text field for an absolute path on the daemon machine (no native
  file picker in a remote browser; a remote file browser is future work).

## Edge cases

- Unreachable/empty roots → diagnostics surfaced quietly; the rest of the list still
  renders.
- A worktree with no sessions → empty workspace with the New-panel affordance.
- A resumed session whose `cwd` matches no known worktree → still appears as a session;
  grouped under an "Unknown location" bucket rather than dropped.
- `exited` sessions remain visible (status dot) until killed, matching current relay
  behavior.
- Mobile with zero worktrees / zero repos → empty state pointing at `Add repo`.

## Testing

- **Protocol:** codec round-trip tests for the new repo messages (mirror `messages.test.ts`).
- **Daemon:** `scanReposRequest` handler with an injected scan fixture (mirror the existing
  `scan` test).
- **Server:** registry `add/remove/list` + `scanRepos` round-trip via a fake daemon link
  (mirror `relay.test.ts`).
- **Web:** a structure test for the new shell + matching/derivation logic as pure
  functions, replacing `apps/web/test/App.structure.test.ts` (which asserts the deleted
  shell). Terminal mounting is covered by the existing e2e harness and is out of scope for
  new unit tests.

## File-level change list

- **Remove:** `apps/web/src/App.tsx`, `apps/web/src/App.css`, `apps/web/src/LiveSessions.tsx`,
  `apps/web/test/App.structure.test.ts` (replaced by a new-shell structure test).
- **Add (web):** the modules above + a small `styles.css` (tokens + layout).
- **Modify:** `apps/web/src/main.tsx` (mount `AppShell`), `apps/web/index.html` (title).
- **Add (protocol):** repo wire types + two messages + codec tests.
- **Modify (daemon):** `scanReposRequest` handler + mapper + test.
- **Modify (server):** repo registry, `scanRepos`, tRPC `repos.*` + `discovery.scanRepos`
  + tests.
- **Keep unchanged:** `@podium/agent-bridge`, `@podium/terminal-client`, `trpc.ts`, the
  session relay/data plane.

## Out-of-scope confirmation

Worktree creation, extra panel types, full tiling, auth, search, and analytics panels are
explicitly **not** in this build. They are compatible with the model and can be layered on
later.
