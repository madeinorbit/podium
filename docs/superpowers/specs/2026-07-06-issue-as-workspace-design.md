# Issue-as-workspace: unified work sidebar + agent self-organization

Status: approved direction (2026-07-06 conversation). Old sidebar stays; new layout ships behind a temporary sidebar tab switcher.

## Goal

One sidebar of "pieces of work," low-friction agent starts, agents self-organize
into the issue tracker, worktrees fade into the background. No new "workspace"
entity: **the issue is the work unit**. Grouping precedence: explicit
`session.issueId` → cwd-derived worktree (fallback for unattached sessions,
shells, legacy).

## Data model (additive)

- `session.issueId: string | null` — explicit attachment; wins over cwd
  containment for sidebar grouping and center tab strip. Set at spawn (draft
  flow) or via the agent capability (attach). Persisted server-side, on the
  session row; broadcast in SessionMeta.
- `issue.origin: 'human' | 'agent'` — whose *intent*. Sidebar + board default
  to human; agent-origin issues are drill-down only (visible under parent /
  via toggle). An agent creating the vessel for a direct human ask marks
  `human`.
- `issue.draft: boolean` — draft issues may have placeholder titles. Draft
  issues appear in the sidebar (that's the point) but not on the kanban board.
  Retitling via the tracker clears `draft`.

No changes to: session cwd semantics, PTY/resume, worktree ownership
(`issue.worktreePath` stays ≤1 per issue), stages.

## Flows

### Low-friction agent start ("New Claude in podium")

1. Top of new sidebar: split button `New <Agent> in <Repo>`; Agent = user's
   default (persisted per-user setting, initialized to last used kind), Repo =
   last-active repo. Dropdown: level 1 = agent kinds, hover reveals level 2 =
   repos (not worktrees). Chevron icon on the button.
2. Click → server creates draft issue (`draft:true, origin:'human'`, stage
   backlog, repoPath=repo, worktreePath=null, placeholder title) + spawns the
   agent session in the repo's **primary worktree** with `issueId` = draft.
3. Sidebar shows the draft row immediately (issue row, agent glyph while
   draft+agent-only). Center tab strip keys off the issue id.

### New issue via `+`

`+` opens NewIssueDialog (make substantially wider). Creating an issue (draft
or full) shows the same row component with the issue glyph. Optionally starts
an agent (existing start-flow) — that agent gets `issueId` stamped.

### Agent self-organization (instruction injected via prime/hook text)

Once the agent has named the user's request it MUST do one of:
- **rename** its auto-draft issue (create path): `podium issue retitle` /
  update — clears `draft`. Issue stays attached; done.
- **attach** to an existing issue: `podium issue attach --id <target>`
  → sets its session.issueId to target; if its previous issue was an
  auto-draft that is now empty (no sessions, no worktree, no children) it is
  deleted server-side in the same op.
- When the user started the agent in a worktree owned by exactly one issue,
  the spawn attaches directly to that issue (no draft). The agent must then
  disambiguate: continuing that issue's work → stay attached; a new piece of
  work → `podium issue attach --new-subissue "<title>"` creates a child issue
  (parent = that issue, origin per intent) and re-attaches to it.

### Sidebar v2 (behind tab switcher)

- Temporary switcher `Classic | Unified` at the top of the aside (localStorage).
- Remove the Command center button in the new layout.
- Order: [New <Agent> in <Repo> ▾][+] on top, then NEEDS YOUR ATTENTION /
  WORKING / PINNED (unchanged), then the work list:
  rows = human-origin issues (draft first-class) ∪ unowned worktrees.
  Row icon: agent glyph (draft, agent-only) / issue glyph / worktree glyph.
- Selecting an issue row → center Workspace keyed by issue: tabs = sessions
  with that issueId (+ file tabs stamped to the issue's worktree when set).
  Selecting a worktree row → today's behavior.

## Non-goals (this iteration)

- Migrating old sessions (issueId stays null → cwd fallback).
- Mobile parity (tracked separately, #95 pattern).
- Removing the old sidebar or the worktree concept.
- Agent-task visibility redesign on the kanban board beyond the origin filter.

## Edge cases

- Draft never named → row persists with session title; user can retitle/kill;
  killing the only session offers draft discard (same 3-condition check).
- Two agents attach to one issue → rows merge trivially (both issueIds equal).
- attach target = own issue → no-op. attach while previous issue non-empty →
  just move, no delete.
- Session exits/archives: issueId kept (history); archived sessions filtered
  from rows as today.
