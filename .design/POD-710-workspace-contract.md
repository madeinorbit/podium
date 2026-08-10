# POD-710 — Editor-style task workspaces: the shared contract

This file is the **single source of truth** for the four parallel workstreams on
POD-710. Every agent codes against the types and semantics here. If you need to
change something in this file, **ask the orchestrator first** — someone else is
already building against it.

Branch: `issue/710-editor-style-task-workspaces`, worktree `.worktrees/POD-710`.
Base: local `main` @ `25b195e31` + `a6ab76004` (mission gauge extracted to its own module).

---

## 0. What we are building

The tab area becomes a **classic file-editor workspace** (VS Code / Zed / Cursor):

1. **Temporary vs permanent tabs.** Selecting a session in the flight deck opens a
   *preview* tab, rendered in italics. Selecting another session **reuses that same
   preview tab** — you cycle through one temporary tab. It becomes permanent when
   the operator *interacts with the session* or *double-clicks it in the flight deck*.
2. **Tabs are decoupled from sessions.** A tab is a **view**, nothing more. Closing a
   tab closes the view and never touches the session. The lock icon goes away.
   Session lifecycle (kill / archive / snooze / hibernate / handoff / rename …) moves
   to the **flight deck**, which is where sessions actually live.
3. **Workspaces are scoped to the task selected in the left sidebar.** Each task
   remembers its own open tabs, active tab, preview tab and split layout, and
   restores them exactly — across task switches *and* across browser reloads.
4. **Splitting and moving tabs** (vertical + horizontal, drag between panes) stays
   behind the existing `tab-splitting` experimental flag.

Operator decisions already locked in (do not re-litigate):

| Question | Answer |
|---|---|
| What promotes a preview tab? | **Any input into the session** (keystroke / paste / send) **or a double-click in the flight deck.** Nothing else — not scrolling, not merely opening a second tab, not dragging. |
| Coming back to a task | **Restore exactly, and survive reload.** |
| Single click on a *task* row in the deck | **Toggle its fold *and* open a preview tab for its lead session.** |
| One unit of work in the progress bar | **A task (sub-issue) in the mission.** |

---

## 1. The model — `packages/client-core/src/viewmodels/workspace-layout.ts` (NEW)

Pure, dependency-free, exhaustively unit-tested. No React, no store.

```ts
/** Identity of a tab. Today: a sessionId, or a `file:<scope>:<path>` id. */
export type TabId = string

/** Which workspace we are in — the task selected in the left sidebar. */
export type WorkspaceKey = string

export type PaneId = string

export interface Pane {
  id: PaneId
  /** Strip order within this pane. */
  tabs: TabId[]
  activeTabId: TabId | null
}

/** Split tree. Only ever deeper than a single leaf when `tab-splitting` is on. */
export type SplitNode =
  | { kind: 'leaf'; paneId: PaneId }
  | { kind: 'split'; axis: 'row' | 'column'; children: SplitNode[]; sizes: number[] }

export interface WorkspaceLayout {
  key: WorkspaceKey
  panes: Record<PaneId, Pane>
  root: SplitNode
  focusedPaneId: PaneId
  /** The ONE temporary tab in this workspace. Italic in the strip. */
  previewTabId: TabId | null
}
```

`axis: 'row'` = panes side by side (a **vertical** split line, "split right").
`axis: 'column'` = panes stacked (a **horizontal** split line, "split down").
Name them in the UI the way editors do — "Split Right" / "Split Down" — not by axis.

### Reducers (all pure, all return a new layout, all no-ops when the input is invalid)

```ts
emptyWorkspace(key: WorkspaceKey): WorkspaceLayout

/** The one function the flight deck calls. */
openTab(ws, tabId, opts: { permanent: boolean; paneId?: PaneId }): WorkspaceLayout
//  permanent: false → if a preview tab exists in the target pane, REPLACE it in place
//    (same strip position); otherwise append. previewTabId = tabId. Tab becomes active.
//    Opening the tab that is ALREADY the preview is just an activate.
//    Opening a tab that is already open as a PERMANENT tab just activates it and
//    leaves the existing preview alone.
//  permanent: true → if tabId is the current preview, clear previewTabId (promote in
//    place, no move); if not open, append as permanent; either way activate it.

promoteTab(ws, tabId): WorkspaceLayout        // preview → permanent, no reorder
activateTab(ws, tabId): WorkspaceLayout       // also moves focusedPaneId to its pane
closeTab(ws, tabId): WorkspaceLayout          // neighbour-right, else neighbour-left, becomes
                                              // active; an emptied non-last pane collapses
moveTab(ws, tabId, toPaneId, toIndex): WorkspaceLayout   // reorder within, or across panes
splitPane(ws, paneId, axis, opts?: { tabId?: TabId }): WorkspaceLayout
closePane(ws, paneId): WorkspaceLayout        // its tabs migrate to the previous leaf
focusPane(ws, paneId): WorkspaceLayout
resizeSplit(ws, path, sizes): WorkspaceLayout

/** Drop tabs whose underlying session/file no longer exists. Called on every sync. */
pruneWorkspace(ws, knownTabIds: ReadonlySet<TabId>): WorkspaceLayout
```

Invariants the tests must pin:

- Exactly **≤1 preview tab per workspace**, and it is always a member of some pane.
- `focusedPaneId` always names an existing leaf pane; `root` always contains ≥1 leaf.
- A tab id appears in **at most one** pane.
- `closeTab` on the last tab of the last pane leaves a valid empty workspace, never
  a layout with no panes.
- `pruneWorkspace` clears `previewTabId` when the preview was pruned.

### Serialization

```ts
serializeWorkspaces(all: Record<WorkspaceKey, WorkspaceLayout>): string
deserializeWorkspaces(raw: string | null): Record<WorkspaceKey, WorkspaceLayout>
```

`deserializeWorkspaces` must be **total** — malformed, truncated or older-shaped JSON
returns `{}` rather than throwing. Version the blob (`{ v: 1, workspaces: {…} }`).

### The workspace key

Today's ordering key is computed inline at `apps/web/src/app/Workspace.tsx:186-190`.
**Move it** into this module, unchanged in behaviour, and have everyone import it:

```ts
export function workspaceKeyFor(sel: {
  missionRootId?: string | null
  issueId?: string | null
  worktreePath?: string | null
}): WorkspaceKey    // `mission:<rootId>` | `issue:<id>` | `wt:<path>` | 'none'
```

---

## 2. Engine wiring — `packages/client-core/src/engine/*`

- `state.ts`: add `workspaces: Record<WorkspaceKey, WorkspaceLayout>`, seeded `{}`.
- Persistence: **device-local**, one new key `podium.workspaces` in
  `packages/client-core/src/ui-state.ts` (add to `CLIENT_DEVICE_LOCAL_UI_KEYS`).
  Precedent: `podium.paneA/paneB/split` are already device-local because "split
  geometry is a property of this screen". The whole layout travels with them.
- Actions (`actions.ts` + `types.ts`):

```ts
openSessionTab(sessionId, opts?: { permanent?: boolean; paneId?: PaneId }): void
openTabInWorkspace(tabId, opts?): void
promoteWorkspaceTab(tabId): void
activateWorkspaceTab(tabId): void
closeWorkspaceTab(tabId): void
moveWorkspaceTab(tabId, toPaneId, toIndex): void
splitWorkspacePane(paneId, axis, opts?): void
closeWorkspacePane(paneId): void
focusWorkspacePane(paneId): void
```

Every one of them resolves the **current** workspace key and rewrites only that entry.

> **CORRECTION (post-landing).** §2 originally said "from `selectedIssueId` /
> `selectedWorktree` via `workspaceKeyFor`", which disagreed with §1 — `workspaceKeyFor`
> takes a `missionRootId`, and a selected issue is not its mission root. A view passing
> `issueId` while the engine passed `missionRootId` would have read a workspace nobody
> writes, i.e. a permanently empty strip. **The resolved rule: `workspaceKeyForState(st)`
> in `engine/state.ts` is the single key resolver — it derives the mission root from
> `state.issues` (mission wins over the bare issue), matching what `Workspace.tsx` used to
> do inline. Never recompute the key yourself.** Also note `workspaceKeyFor`'s worktree
> case returns `wt:<path>`, not the bare path the old inline code used; harmless (a new
> key namespace, nothing migrated) but not literally "unchanged in behaviour".

### `paneA` / `paneB` / `split` stay, as DERIVED MIRRORS — this is load-bearing

`paneA` has consumers well outside the tab strip: the `?pane=` route param
(`ui-state.ts:524,881-887`), `userFocus` PTY-relay priority (`state.ts:184-197`),
the warm set, `use-unified-work.ts`, `FlightDeck.tsx`. **Do not rip them out.**

Make the new layout the source of truth and keep the old scalars in sync on every
layout write:

- `paneA` = active tab of the **first** leaf pane
- `paneB` = active tab of the **second** leaf pane (or `null`)
- `split` = the layout has ≥2 leaf panes
- `focusedPane` = `'A' | 'B'` from `focusedPaneId`

`setPane('A' | 'B', id)` becomes a thin adapter over `activateWorkspaceTab` /
`openTabInWorkspace`, so existing call sites keep working unchanged. Beyond two
panes the mirrors simply describe the first two — they are a compatibility shim,
not the model.

### Retiring `tabOrders`

The strip no longer auto-derives from "every session in the mission", so the
server-side `tabOrders` overlay (`Workspace.tsx:199-209`, `tabs.setOrder`) loses its
job — pane order **is** the order now. Stop reading it in the strip. **Leave the
server API and the `tab_order` table alone** (removal is a separate follow-up); just
stop writing file ids into it. Do NOT migrate old orders into the new layout.

---

## 3. Ownership — who may edit what

Concurrent agents in ONE worktree. **Editing a file you do not own is a merge hazard
— don't.** If you need a change in someone else's file, message the orchestrator.

| Stream | Owns (exclusive write access) |
|---|---|
| **CORE** | `packages/client-core/src/viewmodels/workspace-layout.ts` (+ test), `engine/state.ts`, `engine/actions.ts`, `engine/types.ts`, `engine/runtime.ts`, `packages/client-core/src/ui-state.ts`, `viewmodels/index.ts` barrel |
| **STRIP** | `apps/web/src/app/Workspace.tsx`, `PanelDeck.tsx`, `panel-deck.ts`, `workspace-tabs.ts`, `workspace-close.ts` (+ their tests), `apps/web/src/lib/SessionContextMenu.tsx` |
| **DECK** | `apps/web/src/app/FlightDeck.tsx`, `FoldedFlightDeckBar.tsx`, `apps/web/src/app/operator-focus.tsx` (+ their tests) |
| **GAUGE** | `apps/web/src/app/MissionGauge.tsx` (+ test), `packages/client-core/src/viewmodels/mission.ts` (+ `mission.test.ts`), `apps/web/src/features/worklist/row-progress.tsx` |
| **orchestrator** | `apps/web/src/styles.css`, `apps/web/src/index.css`, `packages/protocol/src/features.ts`, this file, all integration |

`styles.css` is shared — **do not edit it.** Send the orchestrator the exact CSS
block you want appended and it will be applied. Tailwind utility classes inline in
your own components are yours and need no coordination.

---

## 4. Behavioural spec per stream

### CORE
Build §1 and §2. Ship with thorough unit tests on the reducers. You are the
critical path — land the types first and tell the orchestrator the moment
`workspace-layout.ts` compiles, even if the engine wiring is still in flight.

### STRIP — the tab strip and panes

- Render the strip from the **current workspace's focused pane**, not from "every
  session in the mission". A session that is running but has no tab is **not** in
  the strip — it is in the flight deck. This is the decoupling.
- **Preview tab is italic** (`italic` on the label). Nothing else changes about it —
  no extra badge, no different colour. DESIGN.md §5 "Tabs" still governs: the 7×7px
  issue-colour square and the 1px issue-colour inset top line when active.
- **Every tab gets a ✕**, session tabs included. **Delete the lock icon** at
  `Workspace.tsx:615-628` and its `Lock` import. Closing a tab calls
  `closeWorkspaceTab` and **must not** kill, archive or otherwise touch the session.
- `Cmd+W` (`workspace-close.ts`) now closes **any** active tab, session or file, and
  still returns `true` so the Tauri shell keeps suppressing its window-close
  fallback (`apps/desktop/src-tauri/src/main.rs:600-612`).
- **Remove the session context menu from the tab** (`Workspace.tsx:577-584,643-653`).
  DECK is standing it up in the flight deck instead. Keep `SessionContextMenu.tsx`
  itself intact and exported — DECK imports it. The tab's own right-click menu, if
  any, is view-scoped only: Close, Close Others, Close All, Keep Open (promote),
  and Split Right / Split Down when the flag is on.
- Keep inline **double-click-to-rename** on the tab (`Workspace.tsx:576`) — renaming
  a session is view-adjacent and the operator already knows it.
- **Promotion on interaction.** Add a seam in the panel wrapper: any `keydown` that
  is not a bare modifier, plus `paste`, plus a composer submit, inside the active
  panel's subtree promotes that panel's tab if it is the preview. Scrolling,
  clicking and focus alone must NOT promote. Put this in one small hook so there is
  exactly one place that decides.
- `composeDeck` / warm-set behaviour stays as it is — mount lifetime is orthogonal
  to tab membership, and a warm foreign panel is still not a tab.
- The "N archived" reveal toggle (`Workspace.tsx:395-407`) belongs to the flight
  deck now; drop it from the strip.

### SPLIT (wave 2, after STRIP — do not start unprompted)
Vertical + horizontal splitting, drag a tab between panes, pane focus, resizers.
All of it behind `useFeature('tab-splitting')`; with the flag off the layout is
forced to render its first leaf pane only, and an already-split layout is preserved,
not discarded — exactly how `visibleSplit` behaves today (`Workspace.tsx:99-100`).

**Handed to you by CORE and STRIP — start here:**

- **`toggleSplit` is still a raw mirror write** (`actions.ts` does `rt.apply({ split: !split })`)
  while `split` is otherwise derived from the layout's leaf count. With the flag on, the
  strip's `Columns2` button sets `split: true` against a single-leaf layout and the next
  layout write derives it straight back to `false`. **Your first job is to replace
  `toggleSplit` with an adapter over `splitWorkspacePane` / `closeWorkspacePane`.** It must
  not ship in this state behind an enabled flag.
- CORE's compatibility clause: a write whose layout neither has nor just had ≥2 leaves
  mirrors `paneA`/`focusedPane` only, leaving legacy `paneB`/`split` alone (three cases in
  `store-viewstate.test.tsx` depend on it). Once splitting is real, revisit whether that
  clause can go.
- `moveWorkspaceTab(tabId, toPaneId, toIndex)` already exists and the strip's dnd-kit
  drag uses it within a pane; extend it to cross-pane drags. `splitPane(ws, paneId, axis,
  { tabId })` opens a not-yet-open tab in the new pane.
- The strip's tab menu already renders **Split Right** (`axis: 'row'`) and **Split Down**
  (`axis: 'column'`) under the flag — wire them, don't rebuild them.
- Panes have no resizer today (both `flex-1`). The shell's `ResizableColumn`
  (`AppShell.tsx`, e.g. `storageKey="podium:superagent:width"`) is the existing primitive.
- `setFocusedPane` has no UI caller at all today — clicking into a pane does not move
  reported focus unless it went through `setPane`. Fix that as part of pane focus.

### DECK — the flight deck

1. **Click semantics** on the tree:
   - session row, single click → `openSessionTab(sid, { permanent: false })`
   - session row, double click → `openSessionTab(sid, { permanent: true })`
   - task row, single click → toggle its fold **and** open a preview tab for its
     lead session (the existing `coordinator ?? loneMember ?? mostRecentlyActive`
     pick at `FlightDeck.tsx:1377-1380`)
   - task row, double click → same lead session, `permanent: true`
   - A single click must not fire twice on a double click — debounce the single
     action by the double-click interval, or promote on the second click.
   - Keyboard: `Enter` = permanent open, matching double-click.
2. **Default fold state.** Today `collapsed` is a single set and empty means
   "everything expanded" (`FlightDeck.tsx:1210`, `readFolds/writeFolds:130-143`).
   Replace it with a **three-valued** persisted map — explicitly opened, explicitly
   closed, or unset → fall back to the default rule:
   - a task whose entire payload is **exactly one session and no descendant tasks**
     defaults to **closed** (so its strip is one clean click target)
   - every other task with a payload defaults to **open**
   Migrate the old format (a JSON array of collapsed ids) to "explicitly closed"
   rather than dropping it. The fold-all / expand-all control keeps working and
   writes explicit values for everything foldable.
3. **Session management moves here.** Right-click (and a `⋯` affordance on hover) on
   a session row opens the existing `SessionContextMenu` — import it from
   `@/lib/SessionContextMenu`, do not fork it. Rename, mark read/unread, snooze,
   hibernate, resume, handoff, archive, kill. This is now the *only* place those
   live. Also surface the archived-sessions reveal that the strip is dropping.
4. **Proposed actions area.** Pull `stage === 'proposed'` rows **out of the tree**
   and render them in their own section **below** it, headed `PROPOSED ACTIONS`
   (label styling per DESIGN.md §3: 8.5px Geist Mono, 0.12em, uppercase, Label
   Grey). They keep their `IssueNoteChip` shape chip and their `StageGlyph`; they
   lose their rail, elbow and indent — they are no longer in the tree, so nothing
   may draw a guide into them. Structure the JSX so a sibling section can sit below
   yours (POD-679 is landing `DepartureTicks` there; leave it room and do not
   reimplement it).
5. Do **not** edit `mission.ts` — GAUGE owns it. Partition proposals in
   `FlightDeck.tsx` from the rows you already get. If you truly need a viewmodel
   change, ask the orchestrator.

> **DECIDED during implementation** (orchestrator-confirmed, all five stand):
> 1. **A double click does not toggle the fold.** The pending single is cancelled, so
>    promoting a session never costs you the branch you just opened.
> 2. **A proposal that has sub-tasks stays in the tree.** Only proposed *leaves* move to
>    the section — pulling out a parent would orphan its children under a row that is no
>    longer rendered.
> 3. **The mission header title takes the same preview/promote gesture** (round 3 §4 makes
>    it the root's strip). Native subagent rows open as a preview plus
>    `setPanelMode(…, 'native')`.
> 4. **`SessionContextMenu.onRename` requires the host to own an inline editor** — the deck
>    mounts the shared `SessionNameEditor` from `@/lib/WorkerLabel`, the same one the
>    sidebar and the tab strip use. Ownership hazard to remember: that menu is STRIP's
>    file, so a prop change there breaks the deck's call site.
> 5. **The archived-sessions reveal is its own `ARCHIVED SESSIONS` section** below
>    `PROPOSED ACTIONS`, same section idiom, leaving POD-679's departure-ticks slot below
>    both.

### GAUGE — the mission progress bar

The complaint: *"if there is only one task, it still shows two points of information
(for example, saying one is not done and one is being processed)."*

The cause is documented at `mission.ts:226-228` — **`missionProgress` counts the
mission root as a task**, so a root with one child is `total = 2`. `run` picks up the
root *and* the child. `ROW_PROGRESS_MIN_TASKS = 2` in
`apps/web/src/features/worklist/row-progress.tsx:100-107` encodes the same
assumption and must move with it.

- **One unit of work = one task in the mission.** When the mission root has real
  members besides itself, the root is the **container being measured** and must not
  also be a segment. When the root stands alone, it is the single unit. Land that as
  a stated rule in the docstring, with tests for: root alone; root + 1 child; root +
  N children; archived/deleted members excluded.
- Redesign the bar itself. **Bold and dev-style**, per `apps/web/DESIGN.md`.
  Constraints that are not negotiable:
  - Motion for running work must gate on the **same predicate** the existing sweep
    gates on (DESIGN.md §5 "The predicate, not the device") — and honour
    `prefers-reduced-motion`.
  - Blocked work keeps a **hueless** treatment. `--warning` *is* `--attention`
    (`#f5c518`) in Superade; a warning-toned segment would spend the one signal
    colour on work that is asking nothing. Relate it to the existing `.deck-hatch`
    (`styles.css:5627-5650`) rather than inventing a second idea.
  - No green anywhere. Done takes `--success` (Accent Blue), running takes `--live`.
  - Live/agent presence stays **outside** the track — `MissionGauge.test.tsx`
    asserts `track.contains(liveChip) === false`. Keep that true.
  - It is a meter, i.e. data, not decoration (DESIGN.md §5 "Chips / Meters").
- **Run the `/impeccable` skill** and produce **2–3 visual options** as a
  self-contained HTML artifact at `.design/POD-710-mission-gauge.html`, showing each
  option across the real states: 1 task running · 3 tasks, 1 done 1 running 1 blocked
  · 8 tasks mixed · all done · nothing started. Hand the file back to the
  orchestrator **before** you commit an implementation — the operator picks.
  Any CSS you need in `styles.css` goes to the orchestrator as a block to apply.

---

## 5. House rules for every stream

- Read `apps/web/DESIGN.md` and `apps/web/PRODUCT.md` before touching any UI.
- `bun run typecheck` and `bun run test` are **cached** — run them, trust a cache
  hit, and never force a recompute. See `CLAUDE.md`.
- Testing policy is in `CLAUDE.md`: smallest focused set that protects the changed
  behaviour; extend existing tests over adding parallel suites. The pure reducers in
  §1 and the fold-default rule in §4 genuinely warrant tests. Wiring and types do not.
- **Do not use the offer system** (`podium offer`). If you need a decision, ask the
  orchestrator and wait.
- Do not commit. Report back; the orchestrator integrates and commits.
- Do not run the dev server or touch the live instance on `:18787`. Runtime
  verification happens once, centrally, via the `/verify` skill.
