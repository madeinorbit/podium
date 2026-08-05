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
import type { PodiumClientApi } from '../../../api'
import type { Store } from '../../../engine/types'
import type { IssueNavigationModel } from '../issues'
import { defineSlice } from '../publish'
import { groupUnifiedWorkRows, splitPinnedWork, type UnifiedWorkGroup } from './folds'
import { reposVisibleOnMachines } from './machine-scope'
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
   * ONE CAVEAT, AND IT IS DELIBERATE. `groupUnifiedWorkRows` takes a second
   * selection argument — whether the SELECTED closed row was folded at the moment
   * it was clicked — which keeps a row in the lane it was clicked in. That latch
   * is a transient property of one interaction on one screen, not of the world,
   * so it is not store state and cannot be derived here. This slice therefore
   * publishes the grouping for the unlatched case, which is the state the app is
   * in except during the brief window after clicking a settled closed row; the
   * one consumer holding such a latch re-groups for exactly that window and says
   * so at the call site.
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
 * The web store carries two issue shapes — `issues` (server broadcast) and the
 * replica-projected view models behind `useReplicaIssues`. The slice takes the
 * store's own `issues`, which is what `useSidebarDerivation` already derived
 * from before this port; keeping that identical is the single-user parity
 * guard, and changing it is a separate, arguable change rather than something
 * to smuggle into a mechanism port.
 */
function issuesOf<TApi extends PodiumClientApi>(store: Store<TApi>): IssueNavigationModel[] {
  // `IssueNavigationModel` is `IssueWire` minus `commentCount` plus three
  // OPTIONAL fields, so this is an ordinary widening rather than a cast.
  return store.issues
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
  // Worklist derivation is one of the largest client-side projections. The
  // store also carries transcript, connection, approval and host-metric
  // updates that cannot affect this slice, so keep the published value across
  // those snapshots. Every field named here is read by `derive` above; rows
  // and collections remain identity-keyed so an eviction/rescope always
  // invalidates the worklist.
  sourceEqual: (previous, next) =>
    previous.repos === next.repos &&
    previous.machines === next.machines &&
    previous.sessions === next.sessions &&
    previous.pins === next.pins &&
    previous.issues === next.issues &&
    previous.coarseNow === next.coarseNow &&
    previous.selectedIssueId === next.selectedIssueId,
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
    const { pinned, rest } = splitPinnedWork(work)
    return {
      sections,
      allWorktreePaths,
      work,
      pinned,
      groups: groupUnifiedWorkRows(rest, store.selectedIssueId, false, store.coarseNow),
      now: store.coarseNow,
    }
  },
})
