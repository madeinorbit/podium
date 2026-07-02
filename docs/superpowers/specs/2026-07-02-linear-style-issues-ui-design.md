# Linear-style Issues UI — Design

**Issue:** #9 · **Date:** 2026-07-02 · **Status:** Approved

## Goal

Align the Podium issues UI closely with Linear's UX — not its visual design/colors, its
interaction model: what appears on cards, how lanes work, and above all the issue view
(layout, control placement, inline property editing). Everything maps onto the existing
tRPC `issues` API; **no server or protocol changes**.

## Scope decisions (user-approved)

- Opening an issue → **full issue view** replacing the board (drawer removed), not a peek.
- **Board + list** layouts, toggled via Display options; list is the mobile layout.
- **Core keyboard set** only: `C`, `Esc`, `↑/↓`/`J/K`, `Enter`, `S/P/A/L`, `X` + bulk bar.
  Cmd+K palette and right-click context menu are deferred (file as follow-up issue).

## Approach

Evolve in place. Keep the data flow (tRPC `issues` router, `issuesChanged`/`issueUpdated`
broadcasts into the store, pure view-model helpers) and rebuild the surfaces on those
seams. The view-model files (`issue-card.ts`, `issue-board-filter.ts`,
`issue-detail-fields.ts`) grow/split; new pure helpers stay unit-testable.

## Field mapping (Podium → Linear concept)

| Podium | Linear concept |
|---|---|
| `stage` (backlog/planning/in_progress/review/verifying/done) | workflow status |
| `priority` P0–P4 | priority (P0 = urgent glyph, P1–P3 bar glyphs, P4 = no-priority) |
| `assignee` (free text) | assignee (initials avatar; no user accounts) |
| `labels[]` | labels (pills, +N overflow) |
| `type` | Podium-specific property row + card badge (Linear has no type) |
| `estimateMin` | estimate |
| `dueAt` / `deferUntil` | due date / Podium-specific defer row |
| `deps[]` (blocks/related/parent-child/discovered-from/…) | relations (Blocked by / Blocks / Related / other, grouped by type) |
| `parentId` / `childCount`+`childDoneCount` | parent link / sub-issues section with n/m progress |
| `comments[]` + `activityNotes` | activity feed (notes render as a system entry with Refresh) |
| `needsHuman`/`humanQuestion`, `suggestedStage`/`suggestedReason` | top-of-issue banners (Linear duplicate-banner idiom) |
| `sessions[]`, worktree/branch/PR actions | Podium-specific sidebar sections (Sessions, Git) |

## Surfaces

### 1. View header (board + list)

Left: "Issues" + total count. Right: `Filter` button, `Display` popover, `New issue`.

- **Filter** adds a filter-chip row below the header (replaces today's three Selects).
  Chips: text search, Priority, Type, Status(open/closed/ready/blocked/deferred), Labels,
  Stage. AND-composed; chip shows `property: value`, click to edit, x to remove.
  Pure logic extends `filterBoardIssues`.
- **Display** popover: layout toggle List/Board; ordering (priority / last-updated /
  last-created; per-column manual order is out of scope); per-property show/hide toggles
  for card badges (labels, type, estimate, due date, sessions).
- Layout, ordering, and visible-property choices persist to localStorage
  (`podium.issues.display`).

### 2. Board

- Columns = the 6 stages, fixed order. Lane header: **state glyph + name + count + `+`**
  (opens composer pre-set to that stage). State glyphs, Linear-style: dashed circle
  (backlog), open circle (planning), fractional-fill circles (in_progress ⅓, review ⅔,
  verifying ¾ — one visual family increasing in fill), check circle (done).
- **Card** (Linear anatomy, no description text on cards):
  - Top row: `#seq` muted left · assignee avatar top-right (initials; click → assignee
    dropdown without opening the issue).
  - Title, max 2 lines.
  - Badge row: priority icon · type badge · label pills (+N overflow) · sub-issue
    progress `n/m` (when children) · blocked/blocking flag icons (derived from deps) ·
    needs-human flag · session-count badge. Visibility per Display options.
  - Removed from card: description/activity-notes preview, suggested-stage line,
    hover trash delete (delete moves to the issue page `…` menu).
- Drag-and-drop between columns stays native HTML5 (`kanban-dnd.ts`), sets `stage` via
  `issues.update`.

### 3. List view (new)

- Rows grouped by stage, sticky group headers: glyph + name + count + hover `+`.
- Row, left→right: priority icon · `#seq` (fixed-width, muted) · title (truncates) ·
  right-aligned: label pills · needs-human flag · due date · updated-at (short, muted) ·
  assignee avatar.
- Click row → issue page. Same filter chips/ordering as board.
- **Mobile** (`MobileApp`) renders the list view; board is desktop-only.

### 4. Issue page (replaces the drawer)

Navigation stays store-driven: when `view === 'issues'` and `openIssueId` is set, the
issues area renders the issue page instead of board/list. `Esc`/breadcrumb goes back;
prev/next chevrons step through the **current filtered+ordered list**. `IssueDetailHost`
overlay is removed; sidebar `selectIssue` for unstarted issues navigates here instead of
opening a drawer.

- **Header:** breadcrumb `repo › #seq` · copy-ID button · prev/next chevrons · `…` menu
  (Delete with confirm, Copy branch name, Supersede with…, Duplicate of…, Open in Linear
  when linked).
- **Banners** at top of main column: suggested-stage (reason + Approve/Dismiss),
  needs-human (question + Resolve). Same mutations as today.
- **Main column:**
  1. **Title** — inline editable (click to edit, Enter/blur commits via `update`).
  2. **Description** — inline editable markdown (click → textarea, Cmd+Enter/blur
     commits). Today read-only; `update` already accepts it.
  3. **Sub-issues** — children listed with stage glyph + title + assignee; `+ Add
     sub-issue` inline title input → `create` with `parentId` + repo inherited; click
     navigates to the child. Shows `childDoneCount/childCount` progress.
  4. **Activity** — comments + activity-notes system entry (with Refresh via
     `refreshAssistant`), composer at the bottom (`addComment`, Cmd+Enter submits).
- **Right properties sidebar** — every row is click-to-open dropdown with type-ahead
  (shadcn Command/Popover), in order: **Status** (6 stages; plus Close: done / Close:
  wontfix entries → `close`; reopen for closed issues), **Priority**, **Assignee**
  (free-text with recent-values suggestions), **Type**, **Labels** (multi, add/remove →
  `setLabels`), **Estimate** (minutes), **Due date** (date input), **Defer until** (date
  + Undefer → `defer`). Then:
  - **Relations:** grouped Blocked by / Blocks / Related / other dep types; each entry
    hover-x removable (`depRemove`); `+ Add relation` → type select + fuzzy issue search
    (`depAdd`). Parent issue link row (and `reparent` via its dropdown).
  - **Sessions** (Podium): attached sessions (click → jump to workspace, as today);
    `+ Session` / `+ Shell` when a worktree exists, else `Start work` (`start`).
  - **Git** (Podium, when worktree): branch + parentBranch, primary action per
    `gitWorkflow.mergeStyle` (Open PR or FF-merge) + Rebase + the non-primary, PR link.
- Toast/error surface stays local to the page.

### 5. Composer (`C` / New issue button / lane `+`)

Linear-style modal: title input, description textarea, **property pill row** (Stage,
Priority, Type, Labels, Assignee, Repo, Parent branch, Agent, Start-work toggle) — each
pill opens its dropdown, pre-set to defaults (stage from lane `+`, repo = last used).
Linear-import stays as a collapsible section. Footer: **`Create more` toggle** (keeps
modal open, clears title/description, keeps properties) + Create button; Cmd+Enter
submits; Esc closes (no draft persistence — out of scope).

### 6. Keyboard (core set)

Active when the issues view is focused and no input/dialog is capturing:

- `C` → composer. `Esc` → close menus → back to board/list → clear selection.
- `↑/↓` and `J/K` → move focus (list: rows; board: within column, `←/→` across columns).
  `Enter` → open focused issue.
- `S` / `P` / `A` / `L` → open status/priority/assignee/labels dropdown for the focused
  issue (board/list) or the open issue (issue page).
- `X` → toggle multi-select on focused issue; selection checkboxes appear on hover
  (list rows) / cards. A **bottom bulk bar** appears with: Stage, Priority, Delete
  (confirm), count, and Clear. Bulk ops loop `issues.update`/`delete`.
- Focus/selection/keyboard logic implemented as a pure reducer (`issues-keys.ts`) for
  unit testing.

### 7. Sidebar Issues tab

Unchanged behavior except: rows get the stage glyph instead of the uppercase text pill,
and unstarted-issue clicks navigate to the issue page (not a drawer).

## Error handling

Same posture as today: mutations are fire-and-refetch-free (server broadcasts state);
failures surface in a local toast on the page/board. Optimistic UI is out of scope —
dropdowns close and the row updates when the broadcast lands (LAN latencies make this
fine today).

## Testing

- **Unit (pure helpers):** card view-model badges, list grouping/ordering, filter chips,
  keyboard/selection reducer, display-options persistence codec.
- **Playwright real-click e2e** (per repo convention, same-origin harness):
  board↔list toggle; open issue page from card; edit stage via sidebar dropdown; add a
  comment; create a sub-issue; `C` composer with Create-more; `J/K`+`Enter` navigation;
  `X` + bulk stage change. Existing two `issues.browser.e2e.ts` tests updated for the
  new card/page anatomy.

## Out of scope (follow-up issues)

- Cmd+K command palette; right-click context menu.
- Swimlanes/sub-grouping; manual (drag) ordering within columns; saved views.
- Draft persistence for the composer; comment threads/reactions; description history.
- Real user accounts/avatars for assignee.
