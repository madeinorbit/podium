# Mobile: sidebar work list as home, issue panels as the header dropdown

Issue #227.

## Problem

The old mobile view still navigates the way Podium did before issue-as-workspace:
its home view is the Command center (a session-triage board), and its header's
main dropdown picks a **worktree**, with a second dropdown listing that
worktree's sessions. Desktop has moved on: the unified sidebar is a single
status-ordered list of work (WORKING / PINNED / WORK), and the selected thing is
an **issue**, whose sessions and file panels are its contents.

Mobile should follow, without waiting for the new native apps.

## Goals

1. Mobile home renders approximately the desktop sidebar: the
   `New <Agent> in <Repo>` spawn row, WORKING, PINNED, and the attention-ordered
   WORK list.
2. The header's main dropdown selects a **panel of the selected issue** —
   every panel: agent sessions, shells, open file tabs — instead of a worktree.

Non-goals: changing desktop behavior; changing the work-list ordering or the
row designs; a mobile issue *page*.

## Design

### Extraction

`SidebarUnified.tsx` today is one component doing three things. Split it into
three exports, each owning its own dialog state:

| Export | Contents |
| --- | --- |
| `NewWorkRow` | `New <Agent> in <Repo>` button + agent/repo/machine menu + `+` new-issue button; owns `NewIssueDialog` |
| `AppToolsRow` | Usage / Settings / Search / Add-repo icon buttons; owns `RepoScanFlow` |
| `WorkSections` | WORKING, PINNED, WORK — including `UnifiedIssueRow`, `UnifiedWorktreeRow`, and the `selectIssue` / `selectWorktree` / `selectPanel` handlers |

`SidebarUnified` then composes `NewWorkRow` → nav links → `AppToolsRow` →
`WorkSections` → `HostIndicators`, which is byte-for-byte what it renders now.

The select handlers already call `setView('workspace')`, so on mobile a tap on
an issue row selects the issue, opens a pane, and navigates to the workspace
with no mobile-specific code.

### Mobile home

`MainViewOutlet` gains an optional `home` prop. `MobileApp` passes
`<MobileHomeView/>` = `NewWorkRow` + `AppToolsRow` + `WorkSections` in a
scrolling column; desktop passes nothing and keeps `HomeView`. The mobile
header's Home button retitles from "Command center" to "Work".

The `WORKTREES` bottom sheet (`pickerOpen`, `pickWorktree`, `SheetRepo`,
`SheetWorktree`, `PickerSection`, `PinToggle`) is deleted. Its Search / Usage /
Settings / Add-repo buttons are what `AppToolsRow` provides on home.

### Header dropdown

The worktree button and the Sessions button collapse into one control.

**Label.** Selected issue's title (`draftIssueLabel` for drafts) on the main
line, its branch on the muted line above. With no issue selected but a worktree
selected, the branch is the main line and the repo name the muted line — today's
rendering. With neither, "Select work".

**Contents.** The panels of the selection:

- issue selected → `sessionsForIssueNav(issue, sessions, allWorktreePaths, { includeShells: true })`
  plus every `fileTab` whose `worktreePath` is the issue's;
- else worktree selected → `sessionsForWorktree(...)` plus that worktree's file tabs.

Session entries keep their status dot, `WorkerLabel`, pin toggle, and kill
button. File entries show the file's basename and a close button
(`closeFileTab`). Selecting either sets `paneA` and returns to the workspace.

A panel list built this way picks up any future panel kind that lands in
`fileTabs` or `sessions` without further change.

### Pane keeping

`MobileApp`'s keep-pane-valid effect currently bounces `paneA` to `tabs[0]`
whenever the pane is absent from the selected worktree's tabs. It is rebound to
the new panel list, preserving both existing escapes: a live `file:` pane stays,
and a just-opened session the store hasn't broadcast yet stays.

## Testing

Vitest from `apps/web` (`bunx vitest`, not `bun test`):

- Mobile home renders WORKING / PINNED / WORK rows.
- The header dropdown lists a selected issue's sessions **and** its file tabs.
- Choosing a panel sets `paneA` and switches `view` to `workspace`.
- The existing `SidebarUnified` suites still pass across the extraction.
