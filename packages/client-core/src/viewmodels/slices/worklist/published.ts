/**
 * THE PUBLISHED WORKLIST SLICE (POD-331).
 *
 * POD-330 cut `derive.ts` into slices and built the publication mechanism
 * (`slices/publish.ts` + `react/use-slice.ts`), but nothing consumed it: the
 * worklist derivation still ran once per CONSUMER, threaded between components
 * by hand as a `derivationOverride` prop, with every consumer that did not
 * receive the prop silently deriving its own copy.
 *
 * The measured cost of that, from `apps/web/src/perf/slice-render-count.test.tsx`
 * on the unported tree at 5409a3ac:
 *
 *   one consumer  (SidebarUnified)                 sidebarSections = 1 per publish
 *   two consumers (SidebarUnified + CommandPalette) sidebarSections = 2 per publish
 *
 * A published slice makes that 1 for any number of consumers, and — more to the
 * point than the arithmetic — makes it 1 without anyone having to remember to
 * thread a prop. The override threading was not merely verbose: a consumer that
 * missed the prop got a SECOND, INDEPENDENTLY-CLOCKED derivation, so two
 * surfaces could disagree about the same worklist. `CommandPalette` did exactly
 * that, calling `sidebarSections(..., Date.now(), ...)` with a clock that only
 * advanced when its unrelated memo deps changed.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CLOCK IS IN THE SNAPSHOT AND NOT IN THIS FILE
 * ---------------------------------------------------------------------------
 *
 * `sidebarSections` is a function of time as well as of rows — it feeds `now`
 * to `isSnoozed` and `compareRecency`, so a lapsing snooze reorders the list
 * with no server round-trip. The publisher keys on SNAPSHOT IDENTITY and
 * nothing else, which is what makes it correct across evict and rescope.
 *
 * Those two facts together forbid reading the clock here: `Date.now()` inside
 * `derive` would be captured at whatever moment the snapshot was first read and
 * then memoized against it, so on a quiet system — no sessions moving, no
 * publishes — an overnight snooze would never lapse on screen. That is a
 * behaviour regression against the `useNow(60_000)` these surfaces used to run.
 *
 * The answer is not a second cache key (which would make the wrong cache
 * writable again — see `publish.ts`), but `Store.coarseNow`: the clock is part
 * of the world these views render, so a new minute is a new snapshot, and this
 * derivation stays a pure function of its source.
 *
 * Platform-neutral: mobile reads the same two definitions.
 */
import type { IssueId } from '@podium/model'
import type { PodiumClientApi } from '../../../api'
import type { Store } from '../../../engine/types'
import { allIssueViewModels } from '../../../replica/issue-view-cache'
import type { IssueNavigationModel } from '../issues'
import { defineSlice } from '../publish'
import { groupUnifiedWorkRows, splitPinnedWork, type UnifiedWorkGroup } from './folds'
import { reposVisibleOnMachines } from './machine-scope'
import {
  worklistIssuesEqual,
  worklistMachinesEqual,
  worklistPinsEqual,
  worklistReposEqual,
  worklistSessionsEqual,
} from './material'
import { type SidebarSections, sidebarSections } from './nav'
import type { UnifiedWorkRow } from './row-types'
import { unifiedWorkList } from './rows'

/**
 * Everything the worklist surfaces derive from one snapshot.
 *
 * It is ONE slice rather than three because the three are not independently
 * useful: `allWorktreePaths` is read off `sections`, `work` takes both, and
 * every consumer that wants any of them wants them agreeing with each other.
 * Publishing them separately would let a consumer hold a `work` derived from a
 * different snapshot's `sections` — the exact inconsistency the override
 * threading already produced by hand.
 */
export interface WorklistSlice {
  sections: SidebarSections
  allWorktreePaths: string[]
  work: UnifiedWorkRow[]
  /**
   * The PINNED section — rows that moved out of their project group (POD-166).
   *
   * Published rather than left to each consumer for the same reason `work` is:
   * the split is a pure function of the rows, so two surfaces computing it
   * separately can only ever agree by coincidence.
   */
  pinned: UnifiedWorkRow[]
  /**
   * THE PROJECT-GROUP STRUCTURE (POD-407) — the tree the sidebar renders: one
   * group per repo, each with its open rows and its snoozed and closed folds.
   *
   * This is the "tree building comes from the slice, not the component" half of
   * POD-331's brief. It used to be a `useMemo` inside `WorkSections`, which meant
   * the rail, the command palette and mobile either re-derived it or did without.
   *
   * ONE CAVEAT, AND IT IS DELIBERATE. `groupUnifiedWorkRows` takes a selection
   * argument — which closed row is selected and whether it was folded at the
   * moment it was clicked — which keeps a row in the lane it was clicked in.
   * That latch is a transient property of one interaction on one screen, not
   * of the world, so it is not a derive input and cannot re-derive here (POD-4420
   * S2: `sourceEqual` below ignores `selectedIssueId`). This slice therefore
   * publishes the grouping for the unselected case, and selection placement is
   * the memoized {@link placeWorklistSelection} post-pass over this output —
   * same lanes as grouping with the selection, none of the derivation. The
   * latched consumer (`WorkSections`, and any reader holding a folded click)
   * applies the post-pass with its latch instead of re-grouping by hand; a
   * latched re-grouping with `selectedIssueWasFolded: true` is lane-identical
   * to this baseline, so that path returns this value untouched.
   */
  groups: UnifiedWorkGroup[]
  /** The clock this slice was derived against. Consumers that need `now` for
   *  their own time-dependent rendering read it HERE rather than starting a
   *  private interval, so a row and its timestamp can never disagree. */
  now: number
}

/**
 * The issues the worklist renders.
 *
 * Unread left `IssueWire` (POD-797) and is derived on the replica from `readAt`
 * versus issue/session activity. Flight Deck already reads those view models
 * via `useReplicaIssues`. The published worklist must use the same builder —
 * `store.issues` no longer carries `unread`, so row emphasis and the read/
 * unread menu would otherwise stay stuck on "read" (POD-843).
 *
 * IT READS THE SHARED CACHE, NOT THE BUILDER (POD-1053). This used to call
 * `issueViewModelsFromReplica` directly, which re-derived the whole issue world
 * from the replica AND rebuilt every model — a second, uncached copy of the work
 * `useReplicaIssues` had already done for the same three inputs on the same
 * store snapshot. `allIssueViewModels` is the imperative reader over that memo:
 * the same function, one generation, shared. It is imported from
 * `replica/issue-view-cache.ts` rather than the hook module precisely so this
 * platform-neutral slice keeps its promise not to import React.
 *
 * Stubs without a replica or projections keep the legacy array so clock-only
 * slice tests and surface fixtures that inject `unread` still derive.
 */
function buildIssuesOf<TApi extends PodiumClientApi>(store: Store<TApi>): IssueNavigationModel[] {
  const replica = store.replica
  const projections = store.issueProjections
  if (!replica || !projections || projections.length === 0) return store.issues
  const models = allIssueViewModels(replica, projections, store.issues)
  return models.length > 0 ? models : store.issues
}

/**
 * The models this slice derived for one store snapshot, remembered so the
 * dependency guard below can ask whether they MOVED rather than whether their
 * source arrays did.
 *
 * Keyed on the snapshot OBJECT — the one key `slices/publish.ts` argues is safe,
 * because an evict, a rescope and an ordinary update are indistinguishable to
 * it. It holds an answer, never a row, and a snapshot that is unreachable takes
 * its entry with it.
 */
const issueModelsBySnapshot = new WeakMap<object, IssueNavigationModel[]>()

function issuesOf<TApi extends PodiumClientApi>(store: Store<TApi>): IssueNavigationModel[] {
  const cached = issueModelsBySnapshot.get(store)
  if (cached !== undefined) return cached
  const models = buildIssuesOf(store)
  issueModelsBySnapshot.set(store, models)
  return models
}

/**
 * The whole worklist: nav sections, the worktree-path index and the unified
 * work rows, derived once per snapshot for every reader.
 *
 * ONE definition, deliberately. A `worklist.sections` slice alongside this one
 * — for the consumers that only want the nav tree, like CommandPalette — would
 * call `sidebarSections` a second time per snapshot and hand back the
 * per-consumer cost this exists to remove, just under a tidier name. A consumer
 * that needs only `sections` reads this and ignores the rest; the work is
 * shared either way, and the numbers in the probe are what settle it.
 */
export const worklistSlice = defineSlice<Store<PodiumClientApi>, WorklistSlice>({
  name: 'worklist',
  // Guard the inputs, never the derived rows. Membership/order changes always
  // miss; unrelated terminal and machine reporting frames keep all readers at
  // the same published value. The coarse clock still owns snooze/decay lapses.
  //
  // POD-4420 S2: selection is NOT a derive input — it only ever moved one
  // settled row between lanes (see `placeWorklistSelection` below), so every
  // click re-derived the whole worklist for a regroup. REVERT PATH: restore
  // the `selectedIssueId` comparison as one guard line here (and the
  // `store.selectedIssueId` argument in `derive`) to go back to per-click
  // derivation.
  sourceEqual: (previous, next) => {
    if (previous === next) return true
    if (
      previous.coarseNow !== next.coarseNow ||
      !worklistReposEqual(previous.repos, next.repos) ||
      !worklistMachinesEqual(previous.machines, next.machines) ||
      !worklistSessionsEqual(previous.sessions, next.sessions) ||
      !worklistPinsEqual(previous.pins, next.pins)
    )
      return false
    // Resolve against the correct snapshot, including after a guard hit. The
    // old fallback skipped replica-only changes when no earlier model was read.
    return worklistIssuesEqual(issuesOf(previous), issuesOf(next))
  },
  // An identical output keeps the previous identity, so a derivation that
  // changed nothing observable does not wake readers. Deliberately
  // reference-based: a value comparison would re-litigate `sourceEqual` on
  // every derive and risk holding stale rows. Selection wake-prevention lives
  // one layer down — `placeWorklistSelection` returns the base identity when
  // placement is unchanged, which is the ordinary click.
  isEqual: (a, b) =>
    a === b ||
    (a.now === b.now &&
      a.sections === b.sections &&
      a.allWorktreePaths === b.allWorktreePaths &&
      a.work === b.work &&
      a.pinned === b.pinned &&
      a.groups === b.groups),
  derive: (store) => {
    const issues = issuesOf(store)
    // The repo/project tree is bounded by machine SEE before it is built (POD-407):
    // repos and worktrees are per-machine facts and inherit that machine's scoping
    // rather than carrying their own. See `machine-scope.ts` for why an unstamped
    // row and an empty machine list both mean "not scoped", not "hide it".
    const sections = sidebarSections(
      reposVisibleOnMachines(store.repos, store.machines),
      store.sessions,
      store.pins,
      store.coarseNow,
      issues,
    )
    const allWorktreePaths = [...sections.pinnedRepos, ...sections.repos].flatMap((repo) =>
      repo.worktrees.map((worktree) => worktree.path),
    )
    const work = unifiedWorkList(
      sections,
      issues,
      store.sessions,
      allWorktreePaths,
      store.coarseNow,
    )
    // Placement, once, for every reader. `splitPinnedWork` first: pinned rows
    // leave their project group entirely, so grouping must see the remainder.
    // POD-4420 S2: the baseline is UNSELECTED — selection never re-derives,
    // it is placed by `placeWorklistSelection` over this output.
    const { pinned, rest } = splitPinnedWork(work)
    return {
      sections,
      allWorktreePaths,
      work,
      pinned,
      groups: groupUnifiedWorkRows(rest, null, false, store.coarseNow),
      now: store.coarseNow,
    }
  },
})

/**
 * SELECTION PLACEMENT AS A CHEAP POST-PASS (POD-4420 S2).
 *
 * What `selectedIssueId` ever did to this slice: `closedFoldEligible` in
 * `folds.ts` keeps exactly one row out of the closed fold — the selected
 * settled-but-unremarked closure, which stays in the lane it was clicked in
 * until focus moves. Every other row's lane, every group key/label/order and
 * the pinned split are selection-independent, so a selection change re-places
 * at most that one row and rebuilds at most its owning group. This runs that
 * regroup over the already-derived rows — no sections, no row construction —
 * memoized on (derived output, selection), and returns the BASE identity when
 * placement is unchanged, which is the ordinary click on live work.
 *
 * TWO FAST PATHS, both proven equal rather than assumed:
 * - nothing selected: grouping with `null` IS this baseline.
 * - `selectedIssueWasFolded: true`: `closedFoldEligible(id, X, true)` is
 *   `(id !== X || true)`, i.e. true for every row, exactly like the baseline's
 *   `(id !== null)` — so the latched re-grouping the sidebar used to run by
 *   hand is lane-identical to this value. That call site can pass its latch
 *   here instead of calling `groupUnifiedWorkRows` itself.
 *
 * The clock is the base's clock (`base.now`), never `Date.now()`: time stays
 * an explicit input, so a quiet snooze still lapses only from a real tick.
 */
export interface WorklistSelection {
  selectedIssueId: IssueId | null
  selectedIssueWasFolded?: boolean
}

const placedByBase = new WeakMap<WorklistSlice, Map<string, WorklistSlice>>()

function placedKey(selection: Required<WorklistSelection>): string {
  return `${selection.selectedIssueId ?? ''}|${selection.selectedIssueWasFolded ? '1' : '0'}`
}

function sameLaneRows(a: readonly UnifiedWorkRow[], b: readonly UnifiedWorkRow[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false
  return true
}

export function placeWorklistSelection(
  base: WorklistSlice,
  selection: WorklistSelection = { selectedIssueId: null },
): WorklistSlice {
  const selectedIssueId = selection.selectedIssueId ?? null
  const selectedIssueWasFolded = selection.selectedIssueWasFolded ?? false
  if (selectedIssueId === null || selectedIssueWasFolded) return base
  let bySelection = placedByBase.get(base)
  if (!bySelection) {
    bySelection = new Map()
    placedByBase.set(base, bySelection)
  }
  const key = placedKey({ selectedIssueId, selectedIssueWasFolded })
  const hit = bySelection.get(key)
  if (hit !== undefined) return hit
  // The exact legacy grouping for this selection, over the derived rows.
  // Untouched groups keep their identity, so readers holding them stay cold;
  // when every lane matches this returns the base identity itself.
  const { rest } = splitPinnedWork(base.work)
  const regrouped = groupUnifiedWorkRows(rest, selectedIssueId, false, base.now)
  let unchanged =
    regrouped.length === base.groups.length &&
    regrouped.every((group, index) => base.groups[index]?.key === group.key)
  const groups = regrouped.map((group, index) => {
    const previous = base.groups[index]
    if (
      previous !== undefined &&
      previous.key === group.key &&
      previous.label === group.label &&
      sameLaneRows(previous.rows, group.rows) &&
      sameLaneRows(previous.snoozedRows, group.snoozedRows) &&
      sameLaneRows(previous.closedRows, group.closedRows)
    )
      return previous
    unchanged = false
    return group
  })
  const placed = unchanged ? base : { ...base, groups }
  bySelection.set(key, placed)
  return placed
}
