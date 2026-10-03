# Render cost per click (POD-5428, audit only, 2026-10-03)

**What this is.** A measurement of the part of a click that is not data work: React rendering, React
commit and effects, style and layout, and paint. It covers the mission click, the small (one-row)
mission click and the session click on the synthetic acceptance fixture. It names, for each top cost,
the code (`file:line` at `173041f73c`, `integrate/4286-pilot`) and the likely fix. **No product code was
changed.** The fixes belong to a separate top-level epic (operator direction, 2026-10-03).

## Short answer

At 1× with the pilot on, a mission click spends about 217 ms in data work and the rest in
React render, commit, effects, layout, paint and GC. That second part is about 540 ms and has four causes:

1. **The flight deck draws every row of the mission, not the rows on screen.** Mission `i1766` mounts
   230 task rows, 176 session rows and 13,926 DOM nodes, while 39 rows are visible.
2. **Every row mounts its own Base UI dropdown menu up front.** The row status picker alone mounts
   334 of the 337 `MenuRoot`s per mission click. Menus are about 40% of the render self time.
3. **A session click re-renders the whole deck four times.** The pool deck rebuilds its mission
   computed when the open pane changes. Each rebuild hands every row new props.
4. **Every selection re-renders every mounted sidebar row.** It is 200 rows at 1× and 793 at 4×,
   because two callbacks get a new identity each time. This is the one cost that grows with total data
   while the pilot is on.

The session click also waits 260 ms on purpose before it does anything, to tell a single click from
a double click. That is a product decision, not slow code.

The 100 ms target is out of reach from rendering alone. The data part alone is 217 ms (mission) and
296 ms (session) at 1× with the pilot on. POD-5406 owns 112 ms and 203 ms of that.

## Method

Two instruments, both on flatblock (Chromium 153, headless, 1800×1000, reduced motion, minified
production build, seed 4443; 1× = 4,867 issues, 4× = 19,468 issues).

- **Timeline partition (RUN, offline).** POD-5093's 240 retained click recordings (issue artifact 23 on
  POD-5093; frozen product `c38a12b360`; 20 samples per action, arm and scale) were split into
  exclusive buckets: data (POD-5093's own data classifier), React render, React commit, React passive
  effects (from the React frames in the sampled stack), forced style and layout (layout events nested
  inside a JS task), ordinary style and layout, paint, GC, idle and other. The window is trusted
  pointerdown → first Chromium Paint after the expected DOM change. A sample counts as data when any
  data frame is on its stack, even inside a React render, so render buckets here are React's own work.
  Values are per-click means in ms.
- **Render census (RUN, new).** A DevTools-shaped commit hook, installed before React loads, walks
  each commit the way React DevTools does: only fibers React cloned in that commit, and a function
  component counts as rendered only when React set `PerformedWork` on it. It runs in a minified build
  with names kept and React's profiling renderer. For each component it records renders, mounts, its
  own render time, and why it rendered: which props changed identity, `(equal props)` when the parent
  re-rendered it with equal values, or `(state/context)`. It also counts host nodes mounted, commits
  and the rows on screen. It is untimed: its "self ms" is profiling-build time and is only used to rank
  components. It ran on the current tip `173041f73c`, two samples per action after one warmup.

The census source, the analyzer and every output file are issue artifacts on POD-5428. They are not
committed.

## Where the click time goes (timeline partition)

Per-click means in ms. "Layout (forced)" is layout run synchronously inside JavaScript. "Wall" is the
sum of the buckets, which is the mean input → paint time.

| 1× | Wall | Data | React render | Commit | Effects | Layout (forced) | Layout / style | Paint | GC | Idle |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Mission, off | 657 | 144 | 182 | 98 | 26 | 96 | 11 | 34 | 30 | 0 |
| Mission, on | 795 | 217 | 185 | 113 | 35 | 95 | 13 | 37 | 59 | 0 |
| Small, off | 234 | 100 | 62 | 29 | 5 | 7 | 3 | 5 | 9 | 0 |
| Small, on | 217 | 119 | 37 | 13 | 4 | 7 | 3 | 5 | 13 | 0 |
| Session, off | 746 | 224 | 126 | 56 | 5 | 8 | 2 | 17 | 28 | **232** |
| Session, on | 885 | 296 | 160 | 70 | 5 | 8 | 4 | 20 | 46 | **220** |

| 4× | Wall | Data | React render | Commit | Effects | Layout (forced) | Layout / style | Paint | GC | Idle |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Mission, off | 2,462 | 1,325 | 528 | 185 | 44 | 138 | 13 | 46 | 102 | 0 |
| Mission, on | 2,796 | 1,734 | 278 | 152 | 45 | 123 | 15 | 43 | 322 | 0 |
| Small, off | 1,596 | 1,129 | 251 | 93 | 15 | 10 | 3 | 9 | 30 | 0 |
| Small, on | 1,885 | 1,523 | 80 | 25 | 10 | 10 | 5 | 9 | 163 | 0 |
| Session, off | 3,304 | 2,326 | 369 | 133 | 16 | 14 | 13 | 47 | 105 | 174 |
| Session, on | 4,434 | 3,291 | 218 | 80 | 6 | 15 | 13 | 41 | 489 | 182 |

Columns omit "program" (native, 28–80 ms) and other JS (3–29 ms), so rows do not add exactly to Wall.
Natural layout and paint are small. The large layout cost is the forced layout in the mission click
(see cost 5). With the pilot on, GC doubles at 1× and is three to five times higher at 4×. That
allocation is the data layer's, so it is listed under the data lanes, not here.

## What redraws per click (render census, current tip)

Medians of two clicks. "Renders" counts every component render, mounts included. "Rows on screen"
counts issue, task and session rows inside the viewport after the click.

| Pilot on | Renders 1× → 4× | Mounts 1× → 4× | DOM nodes added 1× → 4× | Commits 1× → 4× | Rows on screen |
|---|---:|---:|---:|---:|---:|
| Mission click | 20,825 → 24,414 | 8,361 → 8,501 | 13,926 → 14,010 | 20 → 40 | 39 / 40 |
| Small click | 3,551 → 6,417 | 212 → 194 | 346 → 336 | 19 → 20 | 23 / 21 |
| Session click | 35,291 → 35,955 | 72 → 0 | 145 → 15 | 16 → 21 | 39 / 35 |

With the pilot off (legacy store), every action's render count also grows with total data:
mission 30,002 → 58,897, small 11,948 → 40,249, session 42,111 → 157,003. That path is being removed,
so it is not analysed further.

Top components, 1×, pilot on (renders, mounts, profiling self ms, main reason):

| Click | Component | Renders | Mounts | Self ms | Why it rendered |
|---|---|---:|---:|---:|---|
| Mission | `Button` | 1,838 | 836 | 59 | mounted; `children`/`onClick` new |
| Mission | `MenuTrigger` (Base UI) | 1,138 | 337 | 58 | mounted; `render` prop new |
| Mission | `MenuRoot` (Base UI) | 802 | 337 | 65 | mounted; `children` new |
| Mission | `IssueStatusPicker` | 774 | 334 | 16 | mounted; `onPick` new |
| Mission | `TaskRow` | 460 | 230 | — | mounted, then re-rendered with a new `source` |
| Mission | `SessionRow` | 352 | 176 | — | mounted; `onOpen` new |
| Mission | `PoolMotionRow` (sidebar) | 200 | 0 | 4 | `settle`, `discardExit` new |
| Session | `TaskRow` | 920 | 0 | — | 690× `byId`/`presentation`/`rails`/`inMission`/`nameOf` new; 230× `activeSessionId` |
| Session | `SessionRow` | 704 | 0 | — | `onOpen` new (not memoised) |
| Session | `MenuRoot` + `MenuTrigger` | 1,425 each | 1 | 192 | `children`/`render` new |
| Session | `IssueStatusPicker` | 1,390 | 0 | 22 | `onPick` new |
| Session | `FlightDeckContent` | 4 | 0 | 20 | `source` new, 4 of 4 times |
| Small | `motion.div` | 432 | 0 | 9 | `transition`, `animate`, `children` new |
| Small | `PoolMotionRow` (sidebar) | 200 | 0 | 4 | `settle`, `discardExit` new |
| Small | `WorklistMeasureLayout` | 220 | 0 | 0 | `transition`, `children` new |

At 4× the sidebar rows dominate the growth: `PoolMotionRow` renders 793 times per small or mission
click, `motion.div` 1,620 times and `WorklistMeasureLayout` 815 times.

## Top costs, with code and likely fix

Ranked by time at 1× with the pilot on. Each one is a mechanism observed in the census or the profile
above, not a guess from reading code.

### 1. The deck renders the whole mission, not the screen

- **Cost:** most of the mission click's React render (185 ms), commit (113 ms), effects (35 ms),
  forced layout (95 ms) and paint (37 ms). For mission `i1766` that is 8,361 component mounts and
  13,926 DOM nodes for 39 rows on screen (230 task rows and 176 session rows mounted).
- **Where:** `apps/web/src/app/FlightDeck.tsx:4199` (`visibleRows.map` → `TaskRow`) and `:1462`
  (`HungRows` → `SessionRow` for every session of every row).
- **Likely fix:** window the spine. Render the rows in and near the viewport, using a variable-height
  virtual list with measured rows, or mount offscreen rows as sized placeholders on first approach.
  The reveal path (`FlightDeck.tsx:3486-3519`, which scrolls to `[data-flight-session]` after a rAF)
  must then scroll by index rather than query the DOM. Expect render, commit, layout and paint for the
  deck to scale with the viewport, about a tenth of today's work for `i1766`.

### 2. Every row mounts a Base UI menu before anyone opens it

- **Cost:** about 40% of render self time on a mission click (`MenuRoot` 65 ms, `MenuTrigger` 58 ms,
  `IssueStatusPicker` 16 ms and the wrappers; 337 menus, 334 of them status pickers). Their effects and portal set-up are in
  the commit and effects buckets.
- **Where:** `apps/web/src/features/issues/IssueStatusPicker.tsx:89` (`<DropdownMenu>` per glyph),
  used per row at `FlightDeck.tsx:1780` and `:1956`. The same picker is drawn in the board list, the
  sub-task list, the panel Work rows and the explorer.
- **Likely fix:** draw the inert trigger (the same span, label and title) and mount the menu on first
  intent (pointer enter, focus or key). One menu per hover replaces one per row. This needs a check
  that keyboard focus survives the swap.

### 3. A session click rebuilds the mission four times and re-renders every row

- **Cost:** session click React render 160 ms and commit 70 ms at 1× (pilot on). That is 920
  `TaskRow`, 704 `SessionRow`, 1,390 `IssueStatusPicker` and 1,425 menu re-renders, while two rows
  change.
- **Where:**
  - `apps/web/src/app/FlightDeckPool.tsx:52`: the mission reader's dependencies include `paneA`,
    `paneB` and `split`, which are used only to wait for the pane's session to load. A new reader makes
    a new `computed` (`:55`), so the whole mission view is rebuilt and `source` (`:56`) is new on each
    of the four renders.
  - With a new `source`, `byId` and `rowPresentation` are new maps, and the memos keyed on rows
    (`FlightDeck.tsx:3196` names, `:3411` session ids, rails and guides) are new. `TaskRow`'s memo
    (`:1873-1893`) therefore fails for every row.
  - `TaskRow`'s memo also compares `activeSessionId` (`:1889`; passed at `:4217`), so any change of
    the open session re-renders every row even when the props are stable.
  - `SessionRow` is not memoised, and `HungRows` passes it a new `onOpen` closure (`:1471`).
    `IssueStatusPicker` gets a new `onPick` closure (`:1780`, `:4234`), which re-renders its menu.
- **Likely fix:** keep the mission computed keyed on (selected issue, mode, view), and check pane
  readiness in a separate small computed. Pass each row only its own active session (null when the
  open session is not one of its own). Memoise `SessionRow` and make the per-row handlers stable, or
  have the comparator ignore them, as `TaskRow` already does for its own handlers.

### 4. A selection re-renders every mounted sidebar row (grows with total data)

- **Cost:** 200 `PoolMotionRow`, 432 `motion.div` and 220 `WorklistMeasureLayout` renders per click
  at 1×. At 4× the counts are 793, 1,620 and 815. This is the only pilot-on census count that grows
  with the corpus (small click 3,551 → 6,417 renders).
- **Where:** `apps/web/src/lib/motion/useRowTransitions.ts:100` (`settle`) and `:124`
  (`discardExit`) are new functions on every render. They are passed to every row at
  `apps/web/src/features/worklist/pool-sidebar.tsx:353-354`, so the `observer` row re-renders. Each
  row's motion wrapper then gets a new `transition` and `animate`.
- **Likely fix:** make `settle` and `discardExit` stable (`useCallback` with the functional
  `setItems` they already use), and keep the motion props stable per row. Separately, the sidebar
  mounts every row of the list (793 at 4×, 21 on screen), so windowing the sidebar is the larger
  follow-up.

### 5. The new page's first layout runs inside the commit (forced layout)

- **Cost:** 86 ms forced layout and 7 ms forced style per mission click at 1× (pilot on). The other
  forced layouts together are under 3 ms.
- **Where:** `packages/client-core/src/react/use-dom-transcript-scroll.ts:203` (a layout effect) →
  `reconcileLayout` reads `scrollHeight` and `clientHeight` (`:150`). The chat transcript pins to its
  tail before paint, which makes the browser lay out the whole document, including the freshly
  mounted deck.
- **Likely fix:** this is not wasted layout; it is the frame's layout pulled forward, and its size
  follows the DOM. Fixing cost 1 shrinks it. Skipping the read when the transcript's geometry inputs
  have not changed (the effect also runs on `rowsToRender` identity) would stop it on clicks that do
  not change the conversation.

### 6. The session click waits 260 ms before it starts

- **Cost:** 220 ms idle inside the session-click window (pilot on), 232 ms off.
- **Where:** `apps/web/src/app/click-intent.ts:20` (`DOUBLE_CLICK_MS = 260`) and `:44`. The session
  row's click goes through it at `FlightDeck.tsx:1243`. A single click is held back to see whether a
  second click follows (one click previews, two keep the tab).
- **Likely fix (product decision):** open the preview on the first click at once, and promote it on
  the second, the way editors do with preview tabs. Without that, a session click cannot paint in
  under 260 ms.

### Smaller costs

- **Many commits per click:** 16–40, from separate store publications in one gesture. Not attributed
  further.
- **Chat panel:** `ChatView` renders 18–23 times and `AgentPanel` 14–20 times per click, mostly with
  equal props. Memoising them on their inputs is cheap.
- **`Workspace`** renders 4 times per click, from its store subscriptions (`(state/context)`).

## What this means for the 100 ms target

| 1×, pilot on | Today (wall) | Data (not this audit) | Deliberate wait | Rendering, layout, paint, GC |
|---|---:|---:|---:|---:|
| Mission click | 795 | 217 | 0 | about 540 |
| Small click | 217 | 119 | 0 | about 80 |
| Session click | 885 | 296 | 220 | about 310 |

Removing costs 1–5 would take most of the rendering column. The data column still has to fall
(POD-5406 holds 112 ms of the mission data and 203 ms of the session data), and the double-click wait
has to go, before any of the three clicks can reach 100 ms.

## Guard the fix epic should add

The census is the per-click component-render count the brief asked for. It cannot rely on the 4×/1×
ratio alone: the mission click's ratio passes (1.17), because the 4× corpus has more missions, not
bigger ones, while the deck still mounts 230 rows to show 39. The gate needs two checks:

- the 4×/1× render ratio must not exceed the 4×/1× ratio of rows on screen (catches costs 4 and the
  legacy path);
- mounted list rows per click must stay within a small multiple of the rows on screen (catches
  costs 1 and 2).

Today's pilot-on result: red on the small click (ratio 1.81 against 1.25 allowed). The second check
would be red on the mission click.

## Evidence

Issue artifacts on POD-5428:

- `render-census.ts`: census collector (flatblock; `bun apps/web/harness/render-census.ts`)
- `census-why-pilot-on.json`: per-click census with reasons, 1× and 4×, pilot on
- `census-matrix-on-off.json`: the earlier census for both arms at 1× and 4×. It counts a
  `memo(fn, compare)` component twice (wrapper and inner fiber) and has no reasons.
- `analyze-render.ts` and `analyze-render-maps.ts`: offline timeline partition of POD-5093's
  recordings
- `trace-partition-1x.json` and `trace-partition-4x.json`: partition means, top components, top leaf
  frames
- `forced-layout-1x-mission-on.json`: the forced-layout attribution behind cost 5
