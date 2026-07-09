# App-wide Cmd+K Command Palette + Issue Context Menu — Design

Issue: #49 (expanded from issues-only palette to app-wide by user decision, 2026-07-06)

## Goal

1. An app-wide command palette (Cmd/Ctrl+K) for navigation and actions, hand-rolled
   (no `cmdk` dependency — new deps crash-loop the live redeploy), but taking
   inspiration from cmdk (MIT) where its patterns make sense: score-based fuzzy
   filtering, group headers that hide when empty, roving keyboard selection,
   `Escape` layering.
2. A right-click context menu on issue cards/rows mirroring issue actions
   (Linear parity), cloned from the existing `SessionContextMenu` pattern.

## Palette

### Shell

- `CommandPalette.tsx` rendered at app-shell level (alongside where
  `SessionContextMenu` portals live), inside a Base UI Dialog styled as a
  centered top-third panel: input on top, grouped scrollable results below.
- Open: global `keydown` listener for Cmd/Ctrl+K registered at shell level
  (before IssuesView's handler; that handler already ignores meta-chords, and
  its dialog-open guard `[role="dialog"]` makes it inert while the palette is
  open). Close: Escape, outside click, or executing a command.
- Store: `paletteOpen: boolean` + setter in `store.tsx` so other surfaces
  (e.g. a toolbar button later) can open it.

### Command model

```ts
type PaletteCommand = {
  id: string
  group: 'navigate' | 'global' | 'session'
  label: string
  keywords?: string[]     // extra match terms
  icon?: ReactNode
  hint?: string           // right-aligned annotation (e.g. stage, repo)
  run: () => void | Promise<void>
}
```

Pure helper module `command-palette.ts` (unit-testable, no React):
- `scoreCommand(query, command): number` — cmdk-inspired subsequence scorer:
  continuous-run bonus, word/boundary-start bonus, label > keywords weight.
- `filterCommands(query, commands): PaletteGroup[]` — score, sort per group,
  drop empty groups, cap per-group results (navigate: 8, others: uncapped).

### Sources (v1 groups, in order)

1. **Navigate** — jump to:
   - Sessions & worktrees: from store state already in the client (label =
     session title, hint = worktree/repo). Selecting focuses that session
     (same path the sidebar row click uses).
   - Issues: local match over the store's live issues list first; when the
     query is ≥2 chars also merge server results from `trpc.issues.search`
     (debounced ~150ms, same source SearchView uses). Selecting opens the
     issue (`setOpenIssueId` + view switch).
2. **Global** — static commands: New issue, New session/agent, Switch view
   (Home/Issues/Settings/Usage), Toggle sidebar mode, Theme, Settings.
3. **Session** (only when a session is focused) — actions on the current
   session, gated by the existing `sessionMenuEligibility()`: snooze, detach,
   restart agent, copy id — same operations the session context menu offers.

### Free-text fallback

Always rendered as the **last row** (and the only row when nothing matches):

> `↵ New agent: “<typed text>”`

Executing it creates a new agent exactly like the "New Claude in Podium"
button in the unified view — same target resolution (current worktree /
current context) and same defaults — with the typed text sent as the first
prompt. Implementation: reuse the same handler that button calls (extract it
if it's currently inline) rather than duplicating spawn logic.

Selection default: highlight the top result; if the query matches nothing,
the fallback row is highlighted so plain Enter creates the agent.

### Keyboard behavior (cmdk-inspired)

- ArrowUp/Down (and Ctrl+N/P) move a roving highlight across group
  boundaries; Enter runs the highlighted command; typing always goes to the
  input (input keeps focus; list is aria `listbox`/`option` with
  `aria-activedescendant`).
- Escape: clears the query if non-empty, closes the palette if empty
  (cmdk-style two-stage escape).

## Issue context menu

- `IssueContextMenu.tsx` cloned from `SessionContextMenu.tsx`: cursor-anchored
  `createPortal`, viewport-clamped, dismissed on outside click / Escape /
  scroll.
- Wired via `onContextMenu` on issue rows/cards in `IssuesView` board cells and
  `IssueListView` rows. Right-clicking an unselected issue re-focuses it
  (updates `keyState.focusId`); right-clicking within a multi-selection keeps
  the selection and the menu acts on all selected issues (matching the bulk
  action bar semantics).
- Items (mirroring existing mutations; multi-select-capable ones marked ✻):
  Open, Set stage ▸ ✻, Set priority ▸ ✻, Assign agent ▸, Labels ▸ ✻,
  Close (done) / Close (wontfix), Snooze/defer, Pin, Duplicate, Delete ✻.
  Submenus reuse the existing `DropdownMenu`/`PropertyMenu` option lists where
  practical; otherwise flat second-level flyouts like SessionContextMenu.
- Pure `issueMenuEligibility(issue(s))` helper module gates items
  (e.g. no "Close" on already-closed, no merge-only actions here), unit-tested
  like `sessionMenuEligibility`.

## Data flow / errors

- All actions go through existing tRPC mutations; failures surface via the
  existing `sonner` toast pattern. Palette closes optimistically on execute;
  errors toast afterward.
- Server search failures degrade silently to local-only navigate results.

## Testing

- Unit (vitest, run from `apps/web`): `scoreCommand`/`filterCommands` ranking
  and grouping; fallback-row selection logic; `issueMenuEligibility`.
- Playwright against the built app (per standing rule: interactive UI needs
  real-click verification): open palette with Cmd+K, type to filter, Enter
  navigates to an issue; free-text fallback spawns an agent; right-click an
  issue row shows the menu and "Set stage" mutates it.
- Fresh worktree needs `bun run build` before Playwright.

## Out of scope (deferred)

- Issue actions *inside the palette* (act-on-focused-issue commands) — the
  context menu covers issue actions in v1.
- Recents/frecency ranking, nested palette pages (cmdk "pages"), file search.
