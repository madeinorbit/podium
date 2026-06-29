# Issues sidebar tab — design

**Date:** 2026-06-29
**Branch:** `feat/issues-sidebar-tab`
**Status:** Approved design, ready for implementation plan

## Problem

The sidebar today is a single navigation surface: a fixed top umbrella
(`NEEDS YOUR ATTENTION` / `WORKING` / `PINNED PANELS`) over a
repo → worktree → session tree. Clicking a worktree opens the worktree's
session deck in the main view.

Issues already exist as a first-class server-side concept (`IssueWire`): each
issue is repo-scoped, owns a git worktree once started, and exposes the sessions
running in that worktree. But issues are only reachable through the kanban board
(the tools-row "Issues" button). There's no way to navigate issues and their
sessions the way you navigate worktrees.

## Goal

Add a second sidebar tab — **Issues** — alongside the existing **Worktrees** tab.
The Issues tab mirrors worktree navigation but is keyed on issues: a flat list of
issues, each expandable to the sessions attached to it, each clickable to open
that issue's sessions in the main view exactly as a worktree does today.

## Decisions (locked)

- **Organization:** flat list, sorted by recent activity. Each row shows a small
  muted repo name and the issue's stage.
- **Scope:** show *all* issues (started and unstarted), not just started ones.
- **Click target:** reuse the existing worktree workspace — select the issue's
  worktree so the current `Workspace` renders its sessions. No new main view.
- **Kanban board:** unchanged; it stays as the full triage surface. The sidebar
  tab is quick navigation.

## Non-goals

- No server, protocol, or DB changes. All required data is already on `IssueWire`.
- No issue pinning, drag-reorder, or per-stage grouping in the sidebar (the kanban
  board owns triage). YAGNI for v1.
- No changes to the worktree tab's behavior.

## Architecture

All changes are confined to `apps/web`.

### 1. Tab state (`store.tsx`)

Add a persisted UI field:

- `sidebarTab: 'worktrees' | 'issues'` + `setSidebarTab(...)`, persisted to
  `localStorage` key `podium.sidebarTab`, default `'worktrees'`.

The issue-detail drawer is currently local `useState` inside `IssuesView`. Lift it
into the store so it can be opened from the sidebar too:

- `openIssueId: string | null` + `setOpenIssueId(...)` (ephemeral, not persisted).

`store.issues` (fed by `hub.onIssues`) already holds the full `IssueWire[]`. No new
subscription.

### 2. Derivation (`derive.ts`)

Add, mirroring `sidebarSections`:

```ts
interface IssueNavView {
  issue: IssueWire
  repoName: string        // basename of issue.repoPath
  sessions: SessionMeta[] // issue.sessions, sorted for the sidebar
  activityAt: number      // max session lastActiveAt, fallback issue.updatedAt
}

function issueNavList(
  issues: IssueWire[],
  sessions: SessionMeta[],
  now: number,
): IssueNavView[]
```

- Sort by `activityAt` descending (most recently active first).
- Reuse `sortSessionsForSidebar()` for the per-issue session order.
- Archived issues are excluded (matching the kanban board's default view).

Add a filter helper paralleling `filterSidebarSections`: match the existing
sidebar filter text against issue title, repo name, and stage.

### 3. Sidebar (`Sidebar.tsx`)

**Tab switcher.** Insert a two-segment control (`Worktrees` | `Issues`) directly
below the work-items umbrella and above the tree region. The umbrella
(`NEEDS YOUR ATTENTION` / `WORKING` / `PINNED PANELS`) stays fixed above it and is
rendered regardless of tab.

**Worktrees tab (unchanged):** the existing `WORKTREES` header, sort dropdown,
pinned worktrees/repos, and repo tree. The sort dropdown moves to sit beside the
tab switcher and only shows on this tab.

**Issues tab (new):** render `issueNavList(...)` filtered by the shared filter
input as a flat list of `IssueBlock`s.

**`IssueBlock` (new, mirrors `WorktreeBlock`):**

- **Default collapsed.** A disclosure chevron toggles the attached session rows.
  Collapse state persisted per issue at `podium:sidebar:issue-collapsed:<issue.id>`,
  defaulting to collapsed.
- **Header row** shows: issue title, a small muted repo name (like the
  pinned-worktree repo text), and a stage pill (reusing the stage labels from
  `issue-card.ts` / `ISSUE_STAGES`). Optionally a session count.
- **Click on the header:**
  - If `issue.worktreePath` is set → `selectWorktree(issue.worktreePath)` +
    `view='workspace'` (identical to clicking a worktree).
  - If not started (`worktreePath == null`) → `setOpenIssueId(issue.id)` to open the
    detail drawer so the user can "Start work."
- **Active highlight** when `selectedWorktree === issue.worktreePath`.
- **Session rows** render with the existing `PanelRow`; clicking a session calls
  `selectPanel(issue.worktreePath, session.sessionId)`.

The shared filter input filters the active tab (worktrees today, issues on the new
tab).

### 4. Issue detail drawer (small refactor)

`IssuesView` currently owns the drawer via local `openId` state and renders
`<IssueDetail>` itself. Change so the drawer is driven by `store.openIssueId`:

- Render `<IssueDetail>` once at the app-shell level (or a shared location), driven
  by `store.openIssueId` / `setOpenIssueId`, so it appears over any view.
- `IssuesView` sets `openIssueId` instead of local state; its card click path is
  otherwise unchanged.

This keeps the kanban board behaving exactly as before while making the drawer
reachable from the sidebar.

## Data flow

```
hub.onIssues ──► store.issues (IssueWire[], includes sessions + stage + worktreePath)
                      │
                      ├─ issueNavList(issues, sessions, now) ──► IssueNavView[]
                      │        (filtered by sidebar filter text)
                      │
Sidebar (Issues tab) ─┴─► IssueBlock per issue
        header click ──► worktreePath? selectWorktree(path)+view='workspace'
                          : setOpenIssueId(id)  ──► IssueDetail drawer
        session click ──► selectPanel(worktreePath, sessionId)
```

## Testing

- **`derive.ts` unit tests** (vitest, alongside existing derive tests):
  - `issueNavList` sorts by recent activity, attaches/sorts sessions, derives
    `repoName`, excludes archived.
  - The issue filter matches on title, repo name, and stage.
- **Component-level** (if the existing sidebar has render tests): tab switch
  persists; `IssueBlock` defaults collapsed and toggles; header click on a started
  vs. unstarted issue routes to `selectWorktree` vs. `setOpenIssueId`.
- **Manual / Playwright** per the project's UI-verification practice: switch tabs,
  expand an issue, click an issue to confirm the main view shows its sessions, and
  confirm an unstarted issue opens the detail drawer.

## Files touched

- `apps/web/src/store.tsx` — `sidebarTab`, `openIssueId`.
- `apps/web/src/derive.ts` — `IssueNavView`, `issueNavList`, issue filter.
- `apps/web/src/Sidebar.tsx` — tab switcher, `IssueBlock`, Issues-tab rendering.
- `apps/web/src/IssuesView.tsx` — use `store.openIssueId` instead of local state.
- App-shell component (where `IssuesView`/views mount) — render `<IssueDetail>`
  driven by the store.
- New/updated tests in `apps/web/src/derive.test.ts` (or equivalent).
