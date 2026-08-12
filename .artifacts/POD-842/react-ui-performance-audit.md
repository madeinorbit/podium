# React web UI performance audit

Audit date: 2026-08-12  
Baseline: local `main` at `491520736` (`main` was two commits ahead of and two commits behind `origin/main`)  
Scope: `apps/web`, the browser-facing parts of `packages/client-core`, `packages/model`, `packages/commands`, terminal packages, the production bundle, and relevant queued UI branches

> **Post-review correction (2026-08-12).** A Claude Fable 5 high-effort reviewer rechecked every finding at parent-worktree tip `311130a1b`. All nine findings still reproduce and should proceed. The implementation plan now keeps terminal/xterm lifecycle work entirely in POD-847, keeps Workbox offline-precache semantics unchanged, and serializes overlapping children. POD-781 and POD-782 are already on the current tip; POD-802 remains the live chat overlap. A fresh branch-local build produced a 2,897,116-byte main script (835,720-byte precompressed gzip, 663,877-byte Brotli) and a 52-entry / 5,817.30 KiB raw precache. The full adversarial review is attached separately.

## Executive result

The largest likely gains are not small React micro-optimizations. They come from stopping high-frequency state from waking unrelated mounted surfaces, avoiding duplicate whole-issue projection work, putting a real memory budget around hidden warm panels, and keeping cold code/data out of the startup graph.

The top findings are:

1. **A composer keystroke wakes unrelated panels and the Flight Deck.** The engine replaces the global drafts object per keystroke. The Flight Deck, every mounted AgentPanel, and every mounted ChatView select that whole object. With the desktop warm-set cap, one keystroke can wake up to eight hidden AgentPanels and their chat surfaces.
2. **The “shared” issue world is only partly shared.** The base issue snapshot is shared per replica, but every `useIssueViewModels` caller loops over every projection and derives every issue rollup again. The current web has 35 production files calling `useReplicaIssues`, and even the nominal single-issue hook builds the whole map.
3. **Warm panels are heavyweight residents, not lightweight caches.** Up to eight desktop sessions stay mounted behind `display:none`. A live chat-mode panel can retain both a 5,000-line xterm/WebGL terminal and a transcript UI/subscription window.
4. **The startup script is 2.89 MB minified / 662 KB Brotli.** Settings, several routes, every right-dock panel, terminal/xterm, and test-only motion UI are in the eager graph. Source-map attribution also exposes large policy/audit registries that a browser screen does not need.
5. **Kanban drag is a board-wide React update at pointer frequency.** Every `pointermove` stores coordinates in board state, rerendering all mounted columns/cards at 60–120 Hz on typical pointing devices.
6. **The persistent navigation surfaces still respond too broadly to live state.** Full-session-array changes invalidate the entire worklist projection and Flight Deck mission projection; both then rebuild large animated row trees.

Nine independent follow-up issues were filed from this audit. The recommended starting pair is POD-845 (scoped session/draft subscriptions) and POD-846 (one shared issue model projection).

## What was measured

### Production bundle baseline

Command:

```sh
/usr/bin/time -v bun run --cwd apps/web build
```

The build succeeded. Relevant emitted sizes:

| Asset | Minified/raw | gzip | Brotli |
|---|---:|---:|---:|
| eager main JavaScript | 2,890,909 B | 834,028 B | 662,024 B |
| eager main CSS | 290,793 B | 48,010 B | 38,292 B |
| `comments` chunk | 725,068 B | 218,519 B | 183,143 B |
| `native` chunk | 429,053 B | 82,210 B | 57,958 B |
| lazy Specs JavaScript | 269,765 B | 73,460 B | 61,941 B |
| lazy Specs CSS | 218,429 B | 34,770 B | 28,694 B |
| lazy FilePanel JavaScript | 76,610 B | 24,930 B | 22,161 B |

`index.html` immediately loads the single 2.89 MB main script, its CSS, and a tiny preload helper. The generated service worker precaches 52 entries totaling 5.8 MiB before transfer encoding. The font output contains 29 WOFF/WOFF2 files totaling 509 KB; 309 KB are WOFF2 and eligible for the current precache glob.

The build itself peaked around 1.69 GB RSS and took 74 seconds. That is tooling/build memory, not evidence of browser RAM consumption, so it is deliberately excluded from the UI-memory ranking.

### Main-chunk source-map attribution

I attributed spans in the generated minified main script to source-map segments. This is an approximation of minified ownership, not a promise that deleting a source saves the same number of compressed bytes, but it is good at revealing unexpected browser graph occupants.

| Source/package group | Approx. mapped minified bytes |
|---|---:|
| `@xterm/xterm` | 287,035 |
| `@podium/client-core` | 218,790 |
| `@podium/commands` | 202,267 |
| `@podium/model` | 199,660 |
| `@base-ui/react` | 182,228 |
| `react-dom` | 175,209 |
| web issue features | 172,000 |
| web app shell | 121,317 |
| `@xterm/addon-webgl` | 98,295 |
| web settings features | 93,015 |
| web chat features | 92,738 |
| `motion-dom` | 92,012 |
| `zod` | 56,853 |
| `marked` | 41,315 |
| dnd-kit core | 38,663 |
| `sonner` | 32,604 |
| `lucide-react` | 32,070 |
| `framer-motion` | 29,041 |
| `dompurify` | 26,430 |

Two exact sources stand out:

- `packages/model/src/annotations/matrix.ts`: about **126,045 minified bytes** by itself.
- the xterm core plus WebGL addon: about **385,330 minified bytes** in the eager main graph.

### Static fan-out counts

- 35 production files call `useReplicaIssues()` on the reviewed current tip.
- 32 production files select the full `sessions` array from the client store.
- Three high-cost surfaces select the full `drafts` record: Flight Deck, AgentPanel, and chat surface assembly.
- Only `ChatBlockView` uses `React.memo`/`memo` in production web source. Memoization is not a universal answer, but this confirms that whole-tree invalidations generally flow all the way into component render functions.

## Ranked findings

### 1. Keystroke and session updates have world-sized subscriptions

Impact: **very high interaction latency risk**  
Confidence: **high; direct update and subscription path is visible in code**  
Follow-up: **POD-845 Scoped session state subscriptions**

The draft update path is intentionally one action per keystroke, but it replaces the whole record:

- `packages/client-core/src/engine/runtime.ts:937-940` spreads `drafts` and publishes a new object.
- `apps/web/src/features/terminal/AgentPanel.tsx:161-180` selects `s.drafts`, then reads only `drafts[sessionId]`.
- `apps/web/src/features/chat/use-chat-surface.ts:158-194` selects the whole drafts object and full sessions array, then reads only the addressed session draft.
- `apps/web/src/app/FlightDeck.tsx:1660-1688` selects the whole drafts object even though it displays only the root/focused session draft.

This makes a keystroke in session A observable to every mounted panel for sessions B–H. AgentPanel also selects full `sessions`, `machines`, and all issue models, so a rerender does much more than read a text value: it scans sessions, resolves issue colors/stamps, refreshes refs, creates a large header/content tree, and may render ChatView. If the Flight Deck is open, its large mission tree render also runs on each draft-object identity change even when the edited draft is irrelevant to its focused/root session.

The same pattern exists at lower frequency for live session metadata: 32 production files select the entire sessions array. Several need one session, one count, or one active-worktree result. A change to one session therefore wakes unrelated surfaces. A simple example is `apps/web/src/app/AppShell.tsx:223`, which retains the full array to answer an onboarding/session-count question; selecting the boolean/scalar would remain stable across ordinary session field updates.

Recommended shape:

- Add keyed selectors/readers such as `useSession(sessionId)` and `useSessionDraft(sessionId)`, backed by stable entity indexes rather than repeated array scans.
- Put focused/root draft subscriptions in small leaf components instead of subscribing the entire Flight Deck.
- Select scalar facts when that is the real dependency (`sessions.length`, `machines.length`, addressed draft text).
- Make unrelated entity updates preserve the selected object identity.
- Add a render-count test: with eight warm sessions, 50 keystrokes in A should render the A composer and necessary A leaves, not seven hidden panels, their ChatViews, or Flight Deck rows for another mission.
- Add the analogous test for a metadata update to session B.

This should be the first implementation because it targets the highest-frequency user action directly.

### 2. Issue view models are rebuilt once per consumer, not once per replica state

Impact: **very high at large issue/session counts**  
Confidence: **high; derivation placement and call-site count are explicit**  
Follow-up: **POD-846 Shared issue model projection**

`packages/client-core/src/replica/use-issue-views.ts:61-127` correctly creates one weakly keyed store per replica and shares the base snapshot. It invalidates when any of four joined collections changes: projections, dependencies, repositories, or sessions.

The flat render-model layer then loses that sharing:

- `useIssueViewModels` at `use-issue-views.ts:237-278` uses a component-local `useMemo`.
- On every invalidated snapshot it creates legacy and session indexes, loops every projection, merges shapes, and calls `deriveIssueRollups` for every issue.
- `useReplicaIssues` at `apps/web/src/app/store.tsx:119-128` then copies that Map to a fresh array in every consumer.
- `useIssueViewModel(replica, issueId)` at `use-issue-views.ts:281-283` still calls `useIssueViewModels(replica)` and only then performs `.get(issueId)`, so the nominal single-entity API is not a fine-grained derivation.

The source comment says the flat models are “re-derived once per settled replica state.” They are re-derived once **per mounted hook instance per state**, which is a very different cost model. The reviewed tip has 35 production files calling the array adapter. Warm AgentPanels, chat/composer leaves, top bar, shell, sidebar, Flight Deck, dock surfaces, issue views, and miniviews can all participate.

Session rows are especially costly because any session collection invalidation clears the shared issue snapshot. That may be necessary for membership/rollup correctness, but it should not cause every reader to rebuild every issue model independently.

Recommended shape:

- Move the flat `Map<id, IssueViewModel>` and stable ordered array into the per-replica shared store.
- Reuse the snapshot's on-demand rollup cache or maintain rollups per affected issue instead of computing every rollup for every consumer.
- Expose separate all-issues, id-index, and by-id subscriptions with stable identities.
- Make `useIssueViewModel` genuinely entity-scoped.
- Split invalidation domains where possible: a repository prefix change, one dependency edge, and a session activity tick should not all have identical whole-world consequences.
- Extend the existing 674-issue / 530-session fixture with derivation counters and render counts. One settled delta should build the shared model set once, regardless of mounted reader count.

This compounds finding 1: broad session subscriptions create renders, and each issue reader then pays whole-world model construction.

### 3. Warm panels retain full UI/resource stacks

Impact: **highest RAM/GPU-risk finding; also background CPU/subscription cost**  
Confidence: **high for retained resources, unmeasured for exact MB**  
Follow-up: **POD-847 Warm panel residency budget**

`apps/web/src/features/terminal/use-warm-set.ts:5-35` keeps up to eight desktop sessions or three mobile sessions mounted. `apps/web/src/app/PanelDeck.tsx:81-160` renders those panels as a flat keyed list and hides inactive ones with `display:none`.

That achieves fast session switches, but the resident unit is a complete AgentPanel:

- A live terminal remains mounted across chat/native toggles (`AgentPanel.tsx:451-464`, `938-958`).
- `TerminalView` creates xterm with `scrollback: 5000` (`packages/terminal-client/src/terminal-view.ts:175-205`).
- WebGL is attempted by default and retained as an addon/context (`terminal-view.ts:400-430`).
- A chat-mode AgentPanel also mounts ChatView, which reads an initial 200 transcript items, renders up to 300 rows, retains loaded pages, and maintains a live transcript subscription.
- AgentPanel independently maintains a second transcript subscription for terminal file-link paths (`AgentPanel.tsx:585-604`).
- `active=false` correctly gates focus, sizing, and the six-second foreground transcript heartbeat, but it does not turn the hidden React/DOM/xterm instance into a lightweight cache.

Thus a user who moves through sessions can hold eight xterm buffers, canvases/DOM renderers, WebGL contexts where available, observers/listeners, transcript arrays/derived rows, and store/hub subscriptions. In chat mode the panel can retain both transcript UI and hidden native terminal resources.

Recommended shape:

- Separate **data warmth** from **mounted DOM/resource warmth**. Transcript data and terminal scrollback snapshots can stay cached after the full view is parked.
- Keep only the active pane(s) plus a small number of very recent full residents; park or dispose heavy resources after a short idle threshold.
- Consider distinct caps for chat and native terminals, and react to `document.visibilityState`, `navigator.deviceMemory` where available, and observed WebGL context pressure.
- Preserve the 51 ms-class warm-switch target documented by the existing switch tracing, but compare it with heap, DOM node, local hub callback, WebSocket/PTY claim, and GPU-context counts.
- Test 1, 3, 8, and 20 visited sessions, force GC where the harness permits, and compare retained heap after eviction.

Do not simply lower the cap blind: the correct result is an explicit latency-versus-residency budget with evidence.

### 4. Policy/audit package barrels put avoidable data in the browser

Impact: **high startup parse/eval and code-memory cost**  
Confidence: **high for graph presence and mapped size**  
Follow-up: **POD-848 Lean browser package entrypoints**

The browser needs selected model types/runtime helpers and one settings write planner. It receives much more:

- The only runtime web import from `@podium/commands` found in this audit is `applySettingsPatch` / `planSettingsWrite` in `apps/web/src/features/settings/save-settings.ts:23`.
- `packages/commands/package.json:8-13` exposes only the root entry.
- `packages/commands/src/index.ts` re-exports all account, approval, automation, cloud, fleet, host, issue, workflow, and other command contracts/registries.
- Source-map attribution assigns about 202 KB of the eager minified main to `@podium/commands`.

The model package has the same structural problem:

- `packages/model/package.json:11-16` exposes only the root entry.
- `packages/model/src/index.ts:121-131` exports the ownership/audit annotations beside browser runtime models.
- `packages/model/src/annotations/matrix.ts:2824-2843` constructs the full ownership matrix, builds a Map, and mutates `MATRIX_INDEX_HOLDER.index` at module initialization.
- That one source accounts for about 126 KB minified in the main chunk, including extensive audit prose.

The side-effectful global binding makes it harder for the bundler to prove the matrix can be dropped even when a screen never reads it.

Recommended shape:

- Add explicit subpath exports for browser runtime models and the settings write planner.
- Move audit matrices, registry validation, and policy prose to audit/server/test entrypoints.
- Remove global initialization side effects; pass indexes explicitly or initialize them only in the composition roots that require them.
- Add `sideEffects` metadata only after modules are actually safe to shake.
- Add a source-map-aware main-chunk budget that fails when policy/audit-only sources enter the browser graph.

As an immediate partial win, lazily loading Settings should move most of `@podium/commands` out of initial parse. The package boundary still deserves fixing because opening Settings should not parse every unrelated contract registry either.

### 5. Cold UI surfaces are eager, and precache erases part of code-splitting's network benefit

Impact: **high cold-start and update/install cost**  
Confidence: **high for dependency graph and emitted sizes**  
Follow-up: **POD-849 Lazy web surface loading**

The startup graph is broader than the initial screen:

- `apps/web/src/app/main.tsx:3-7` eagerly imports LoginGate, SetupGate, the whole AppShell, and an E2E-only MotionDemo.
- `AppShell.tsx:8-60` eagerly imports Settings, Onboarding, Usage, sidebar, Flight Deck, dock, command palette, workspace, and related surfaces.
- `apps/web/src/app/routes.tsx:1-14` lazily loads only Specs; Issues, Workflows, and Automations are eager.
- `apps/web/src/app/RightDock.tsx:21-28` imports every dock panel although only one can be open.
- Terminal/xterm is in the eager main graph even on login/setup, issue-board, settings, and other screens that may not show a terminal.

Good split boundaries already exist for Specs and FilePanel. Apply that pattern to real UI boundaries:

- Settings and Usage utility sheets.
- Each secondary route.
- Individual right-dock panels.
- Flight Deck and command palette when disabled/folded/closed.
- Terminal implementation on first terminal-resident panel, with a light panel shell/fallback.
- MotionDemo only inside its E2E condition via dynamic import.

There is an important PWA nuance. `apps/web/vite.config.ts:99-105` precaches every JS/CSS/HTML/SVG/PNG/ICO/WOFF2 file and raises Workbox's per-file ceiling to 5 MiB because the main chunk exceeded the default. Splitting code reduces initial parse/evaluation and immediate heap, but the service worker still downloads and stores all cold chunks during install/update. If network/update/storage cost matters, cold chunks need an intentional runtime-cache strategy rather than unconditional precache.

Recommended budgets:

- main entry compressed and uncompressed size;
- code parsed before login/setup resolves;
- code parsed for the default authenticated view;
- PWA install/update transferred bytes and cache storage;
- startup long tasks and time-to-first-interaction on a mid-range laptop and throttled mobile CPU.

Raising Workbox's ceiling fixed a build failure; it should not serve as the bundle-growth policy.

### 6. Kanban drag reconciles the entire board on every pointer sample

Impact: **high, directly visible gesture jank on populated boards**  
Confidence: **high; hot path is explicit**  
Follow-up: **POD-850 Frame-bounded Kanban dragging**

`apps/web/src/features/issues/IssuesKanban.tsx:114-165` installs a window `pointermove` listener. Once armed, every event calls `setDrag` with new coordinates and a newly resolved drop target. That state is then passed to every IssueColumn (`IssuesKanban.tsx:177-202`).

Each board render:

- rebuilds the drag object and proxy;
- invokes `elementFromPoint`, `closest`, a column lookup, and planned-drop-index work;
- rerenders all columns because `drag` identity changes;
- maps every mounted visible card and recreates card props/callback relationships;
- performs selection membership checks and session resolution per card.

There are no memoized IssueColumn or IssueCard boundaries. Pointer streams commonly arrive at 60–120 Hz, and can exceed display refresh frequency.

Recommended shape:

- Move proxy coordinates to an imperative `transform` or an animation value that does not require React reconciliation.
- Coalesce hit-testing in one `requestAnimationFrame` callback.
- Publish React drop state only when `{stage,index}` changes.
- Stabilize callbacks and memoize card/column leaves after their props have stable identities.
- Avoid array `selected.includes` in each card; use a stable Set at the board boundary.
- Profile a five-second drag after revealing a representative large board; set a React commit-count and frame-time budget.

This is independent of the already-landed POD-781 sidebar optimism work. POD-850 concerns the issue-board drag implementation.

### 7. Sidebar and Flight Deck rebuild animated trees on broad live-state changes

Impact: **medium-to-high persistent-shell cost**  
Confidence: **high for invalidation/render mechanics; exact layout cost needs profiling**  
Follow-up: **POD-851 Stable animated worklist rows**

The worklist has already improved substantially by publishing one shared slice, but its source equality at `packages/client-core/src/viewmodels/slices/worklist/published.ts:130-145` invalidates on any sessions-array identity change. The derivation creates fresh row/group structures.

`apps/web/src/features/worklist/SidebarUnified.tsx` then:

- creates transition targets for all rows;
- builds an issue index;
- repeatedly scans transition rows for each group at lines 432-454;
- renders every row inside Framer Motion `layout="position"` wrappers and a LayoutGroup at lines 466-532.

The Flight Deck is similarly broad:

- it subscribes to full sessions, drafts, and all issue models (`FlightDeck.tsx:1660-1690`);
- it builds the mission tree, membership, progress, departures, session names, proposal sets, filtered rows, and guide geometry across many memos;
- even when a memo can reuse a value, the large component function and child element construction still run when an unrelated selected object changes.

Framer Motion layout animation is valuable when row placement actually changes. It should not be asked to re-measure a whole navigation tree because one unrelated session field or draft changed.

Recommended shape:

- Land POD-845 first so irrelevant drafts/session entities no longer enter these roots.
- Publish stable keyed worklist and mission rows, retaining row identity when their visible fields are unchanged.
- Partition grouped rows once rather than repeated `find`/`filter` passes.
- Move per-row changing facts behind memoized leaf subscriptions.
- Enable layout animation only for actual placement/arrival/exit changes, not status-only updates.
- Measure React commits and browser layout time for one background session tick, one active-session tick, and one draft keystroke.

POD-781's final SidebarUnified shape is already on the parent baseline; optimize that result rather than the pre-optimism implementation.

### 8. Progressive issue rendering is grow-only, not bounded virtualization

Impact: **medium RAM/DOM growth in long-lived large lists**  
Confidence: **high for retained-node behavior**  
Follow-up: **POD-853 Bounded issue list virtualization**

The issue board starts sensibly at 16 cards per stage. `IssuesKanban.tsx:303-341` increases the reveal count when a sentinel intersects. The visible list is always `issues.slice(0, limit)`; rows revealed earlier are never removed while the view stays mounted.

IssueListView and IssueExplorer use related grow/slice patterns. These protect first paint, but a user who scrolls through hundreds of issues eventually retains hundreds of card/row subtrees. That increases heap, style/layout scope, and the cost of finding 6 above.

Use bounded windowing/virtualization with explicit preservation of focused/selected rows, scroll anchoring, keyboard navigation, and per-column scroll state. The existing 674-issue fixture is appropriate for a DOM-node and retained-heap budget.

### 9. Transcript file-link indexing copies and retains a growing set

Impact: **medium allocation pressure in long/high-rate sessions; smaller than findings 1–7**  
Confidence: **high for duplicate copying and retention**  
Follow-up: **POD-852 Incremental transcript path index**

For every mounted AgentPanel, `AgentPanel.tsx:585-604` subscribes to transcript deltas to find file paths. `accumulateFileLinkPaths` at `apps/web/src/features/chat/chat.ts:121-137` clones the entire previous Set for each delta. AgentPanel then immediately clones that fresh Set again before `view.setFileLinks`.

The set retains every path seen since reset, even if the corresponding transcript items are no longer in the loaded/rendered window. For ordinary sessions the set is small; for long tool-heavy sessions it creates allocation proportional to all known paths on every incoming delta, multiplied by warm mounted panels.

Prefer incremental additions into a terminal-owned index or a versioned immutable structure, avoid the second defensive copy through a clear ownership contract, and align retention with a documented transcript/path cap.

## Lower-priority observations that are not current top findings

- The active live ChatView runs a six-second heartbeat that rereads 200 transcript items and performs identity/content comparison. It is gated by `active`, live status, initial load, and paging state, and preserves the old array when unchanged. The code includes prior measured server costs. Do not optimize this ahead of the fan-out findings without a network/CPU trace showing it matters.
- Minute/second clocks are generally gated or shared. Worklist timestamps use the engine's shared coarse clock, and the board uses one minute clock for all cards. Some warm AgentPanels still own minute timers, but their timer wakeups are minor compared with the render/subscription fan-out.
- Polling in Settings, Usage, host metrics, merge queue, and message ledger is mostly component-mounted and cleans up. Code-splitting those cold surfaces provides a cleaner first win than rewriting each timer.
- Hidden source maps are large on disk but are not referenced by the production scripts, so browsers do not fetch them in ordinary use.
- React StrictMode does not double-render production builds; it is not a production performance finding.
- The audit did not find a credible unbalanced production event-listener/interval leak in the reviewed hot paths. The resource issue is deliberate continued mounting, not missing cleanup after unmount.

## Existing work that is already good

Several important safeguards should be preserved:

- The catastrophic prior ownership lookup freeze has been fixed. Historical profiling recorded 330 s to first paint and 116.5 s idle blocking, dominated by `worktreeForCwd`. Current main contains `buildWorktreeRootIndex` / `worktreeForCwdIndexed` from commit `08b7679bc`; this audit does **not** reopen that solved cause.
- `useIssueViews` already has a correct shared per-replica external-store foundation. POD-846 should extend it rather than invent a second state system.
- The worklist is a published slice and ignores unrelated transcript/connection/metric store changes.
- Transcript initial load is 200 items and initial rendered rows are bounded at 300; unchanged heartbeat reads preserve array identity.
- ChatBlockView is memoized, avoiding markdown reparse for unchanged blocks.
- The issue board's 16-card progressive first-paint bound is useful even though grow-only retention needs a second stage.
- Specs/BlockNote and FilePanel already demonstrate viable lazy boundaries.
- Terminal focus/sizing/heartbeat work is gated by active state even though resources remain mounted.
- Existing source-mapped CPU profile scripts and switch marks provide a good measurement base.

## Queued/review work and overlap

The audit baseline is local main. I inspected issue metadata and branch diffs for active/review UI work without modifying or merging them.

| Issue | State / relevant overlap |
|---|---|
| POD-781 Optimistic sidebar mutations | Done and present on the reviewed parent tip. POD-851 must work from its final SidebarUnified/overlay shape; it does not solve Kanban pointer-rate renders. |
| POD-782 Superagent chat parity and reliability | Done and present on the reviewed parent tip, including ChatView, use-chat-surface, transcript rendering, SuperagentView, and client-core state. The fresh build baseline above includes it. |
| POD-802 Retractable queued transcript messages | In review; 29 files, +547/-14, overlapping ChatView, transcript feed, send/surface hooks, and chat slice. It is another reason to land or rebase POD-845 carefully. |
| POD-821 Calm Markdown reading mode | In progress; concerns the already-lazy FilePanel/Markdown path. Recheck the FilePanel chunk and PWA precache after landing, but it does not change the top main-thread findings. |
| POD-827 Stale read receipt cleanup | In review; primarily outbox/recovery and no central React hot path in its current branch diff. |
| POD-750 Cold start flight deck | In review as a concept artifact. If adopted, evaluate its initial surface against POD-849's startup graph and POD-851's Flight Deck subscription budget. |

The measured local `main` was two commits ahead and two behind `origin/main`. While this report was being written, shared `main` advanced from `491520736` to `789a487bc` through two mobile-offer commits; their only non-mobile production changes are client-core action/API surface additions, not the state publication, React web, issue projection, terminal, or bundle paths ranked above. The two origin-only commits concern client API ID branding and deletion of a hub-provenance chip. None reverses the findings, but the bundle numbers should still be regenerated on the eventual merged tip.

## Recommended delivery order

### Wave 1: stop high-frequency fan-out

1. POD-845 — scoped session/draft subscriptions.
2. POD-846 — shared issue model projection and true by-id hooks.

These two remove multiplicative work from typing, session activity, and replica deltas. They also make every later profile easier to interpret.

### Wave 2: cut startup parse/evaluation

3. POD-848 — lean package entrypoints; isolate policy/audit data.
4. POD-849 — lazy routes/dock/settings/terminal and intentional PWA caching.

Do the package graph and UI boundaries together or sequentially with a size report after each. Otherwise a route split can hide a package problem in a cold chunk without actually shrinking total install/update cost.

### Wave 3: put a budget on resident UI

5. POD-847 — measure and redesign warm-panel residency.
6. POD-852 — make transcript path indexing incremental/bounded.

The current baseline includes POD-782. Re-measure after POD-802 if it lands before final integration because it changes chat residency.

### Wave 4: bound large rendered collections and gestures

7. POD-850 — frame-bounded Kanban drag.
8. POD-851 — stable sidebar/Flight Deck rows, built on the landed POD-781 shape.
9. POD-853 — bounded issue-list virtualization.

## Measurement plan for the fixes

Use the repository's existing source-mapped CDP profile and switch-trace infrastructure. Add narrow, repeatable scenarios rather than one vague “app feels faster” run:

1. **Typing fan-out:** eight warm sessions, Flight Deck open, 50 characters typed in one Chat composer. Record React commit count, commit time, long tasks, and which session components rendered.
2. **Session delta fan-out:** update one non-focused session at realistic activity frequency. Assert unrelated AgentPanels, AppShell, issue leaves, and mission trees do not render.
3. **Large replica:** 674 issues / 530 sessions. Count issue snapshot/model derivations per settled delta and compare 1 versus 30 mounted readers.
4. **Warm residency:** visit 1, 3, 8, and 20 sessions; capture heap/DOM/listener/WebGL counts after settling and after eviction/GC. Record cold and warm switch p50/p95.
5. **Kanban gesture:** reveal a large board and drag for five seconds. Record pointer events, rAF callbacks, React commits, scripting/layout time, and missed frames.
6. **Cold load:** empty HTTP cache with no installed service worker, then installed/warm PWA. Record transferred bytes, parsed/evaluated JS, long tasks, heap after first interaction, and service-worker install/update bytes.

Suggested acceptance budgets should be set from the current measured baseline in each issue, not guessed here. The structural targets are clear even before exact thresholds: one addressed keystroke/delta should not render unrelated entities; one replica delta should not rebuild the same issue world once per reader; hidden-session memory should plateau at the explicit residency cap; pointer coordinates should not produce one full-board React commit each.

## Audit method and limitations

- Reviewed React component composition, selectors, published slices, memo boundaries, timers/effects, transcript/terminal lifecycle, list rendering, package exports, Vite/PWA configuration, and build artifacts.
- Used the generated hidden source map to attribute minified spans to packages and exact sources.
- Compared relevant in-progress/review branches with `main...branch` and read their issue briefs for coordination constraints.
- Consulted the repository's previous client-freeze and live-loop measurements to distinguish solved causes from current risks.
- Per repository guidance, I did not browser-drive ordinary UI rendering. No interaction boundary changed, and this audit produced no runtime code change. Exact browser heap/React commit magnitudes therefore remain acceptance measurements for the follow-up issues, not fabricated numbers in this report.
- No test suite was run: the only repository file added is this Markdown audit artifact, which cannot affect runtime. The production web build was the measurement command and completed successfully.
