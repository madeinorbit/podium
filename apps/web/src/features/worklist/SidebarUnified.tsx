import {
  groupUnifiedWorkRows,
  isDraftAgentVessel,
  planReorderKeys,
  reuseUnifiedWorkRows,
  rowAwaitsTuck,
  rowCanBringBack,
  splitPinnedWork,
  type UnifiedIssueRow as UnifiedIssueRowView,
  type UnifiedWorkRow,
} from '@podium/client-core/viewmodels'
import { asIssueId, type IssueId, isIssueDeferred } from '@podium/model/browser'
import { LayoutGroup, MotionConfig, motion, useReducedMotion } from 'motion/react'
import type {
  CSSProperties,
  JSX,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { MobilePromoCard } from '@/features/mobile-handoff/MobilePromoCard'
import { issueColorHex } from '@/lib/issueColors'
import { type RowTransitionTarget, useRowTransitions } from '@/lib/motion'
import type { ContextMenuAnchor } from '@/lib/session-context-menu'
import { cn } from '@/lib/utils'
import { type SidebarDerivation, useSidebarDerivation } from './derivation'
import { FoldedRowMenu } from './FoldedRowMenu'
import { PINNED_FOLD_KEY, projectFoldKey } from './fold-keys'
import { MAX_ROW_SHORTCUTS, type RowShortcutTarget, useRowShortcuts } from './row-shortcuts'
import { useCollapsedKeys } from './sidebar-common'
import { AppToolsRow, NewWorkRow } from './spawn-row'
import { UnifiedIssueRow } from './UnifiedIssueRow'
import { UnifiedWorktreeRow } from './UnifiedWorktreeRow'
import { useUnifiedWork } from './use-unified-work'
import { useRowDrag } from './useRowDrag'
import { WorkListEmpty } from './WorkListEmpty'
import { matchesWorkQuery, normalizeWorkQuery } from './work-filter'
import {
  ClosedIssueFold,
  FoldedWorkRow,
  FoldPanel,
  PinnedSectionLabel,
  ProjectGroupLabel,
  ROW_LAYOUT_TRANSITION,
  SECTION_GAP_CLASS,
  SnoozedIssueFold,
  type TransitionWorkRow,
  type WorkPlacement,
} from './work-folds'
import { useWorkFilter, WorkFilterEmpty, WorkFilterFootnote, WorkSearchField } from './work-search'

function withStableRow(placement: WorkPlacement, row: UnifiedWorkRow): WorkPlacement {
  if (placement.lane === 'closed' || placement.lane === 'snoozed') {
    return row.kind === 'issue' ? { ...placement, row } : placement
  }
  return { ...placement, row }
}

/**
 * The work sidebar, as the 3a design draws it (POD-1057): the spawn row over ONE
 * list of work rows, grouped by project under section BANDS that fold, each row
 * a number, a title, a fixed meta column and one mono status line.
 *
 * The pieces are exported separately because the collapsed rail shares their
 * hooks and row behavior.
 */

export function SidebarUnified(): JSX.Element {
  const derivation = useSidebarDerivation()
  // The filter's pool is every LIVE row the column holds — pinned first, then
  // each project group's open rows. The tail folds are out: a closed archive is
  // not what "12/40" is counting, and a fold cannot show a hit without opening.
  const filterPool = useMemo(
    () => [...derivation.pinned, ...derivation.groups.flatMap((group) => group.rows)],
    [derivation],
  )
  const filter = useWorkFilter(filterPool, derivation.now)
  return (
    <>
      <NewWorkRow sections={derivation.sections} />
      {/* The filter sits BETWEEN the spawn row and the list, outside the
          scroller (3b): it narrows what is below it, so it cannot be a thing
          that scrolls away while you are typing into it. */}
      <WorkSearchField filter={filter} />
      {/* NO COLUMN-WIDE STATUS INSTRUMENT (POD-516 round 3). A "12/40 done · 5
          running" meter summarising the whole column was cut: "there's now a
          overall progress section in the header of the sidebar. This was
          uncalled for." Progress belongs to the rows (`RowProgressMeter`).

          NO SPACER, AND NO NOTCH HEAD-ROOM (POD-1057, the 3a design). The 9px
          gap is gone: the list opens on a SECTION BAND that draws its own top
          hairline, and a spacer above it would push that rule off the seam.
          The head-room went with the bridge notch — the selected row paints
          nothing past its right edge now, so there is nothing to reserve, and
          with it goes the sideways scroll POD-761 had to chase.
          `overflow-x-clip` stays, so a long unbroken title cannot bring it
          back. Rows are FULL-BLEED and own their 13px text inset. */}
      <div
        data-testid="work-scroll"
        className="scroll-none flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto pb-2.5"
      >
        <WorkSections derivation={derivation} query={filter.query} />
      </div>
      {/* The phone pitch stands on the column's FLOOR, outside the scroller and
          directly over the tools row — the last thing you pass on the way out,
          not a row among the work. It gates itself on the first task and
          dismisses for good (POD-1320). */}
      <MobilePromoCard />
      {/* Footer: the 3a design's 34px strip — 35 with its rule, which is
          outside the 34 in a content-box mock (POD-1253) — at the column's 13px inset, on the
          same `--muted` ground as the section bands — the column's two chrome
          ends read as one tone and the list floats between them. We keep muted
          icon controls where the mock writes `new task` / `search` as words. */}
      <AppToolsRow className="h-[35px] flex-none border-t border-hairline-bar bg-muted px-[13px]" />
    </>
  )
}

/**
 * The work list: ONE list of issue/worktree rows, always grouped by project
 * (repo), banded urgency order inside each group. The old WORKING / PINNED
 * sections and the group toggle are gone (#41) — state is carried per-row by
 * the square language, the amber pill and the motion-grammar meta.
 * The caller owns the scroll container.
 */

export function WorkSections({
  derivation,
  /** The inline filter's raw query (POD-1078). Empty — the default, and what
   *  every caller that has no field of its own passes — keeps every row. */
  query = '',
}: {
  derivation?: SidebarDerivation
  query?: string
} = {}): JSX.Element {
  const {
    work,
    pinned,
    groups: publishedGroups,
    sessions,
    issues,
    allWorktreePaths,
    now,
    paneA,
    selectedIssueId,
    selectedWorktree,
    selectIssue,
    selectPanelForIssue,
    selectWorktree,
    selectPanel,
    openIssuePage,
    renameIssue,
    archiveIssue,
    applySortPatches,
    setIssueTucked,
  } = useUnifiedWork(derivation)
  const shouldReduceMotion = useReducedMotion()
  const layoutGroupId = useId()
  const [selectedClosedPlacement, setSelectedClosedPlacement] = useState<{
    issueId: IssueId
    folded: boolean
  } | null>(null)
  /**
   * WHY THE ROW LEFT, not whether it may leave (POD-781).
   *
   * This used to be the archive's whole optimism: the id went in on the click,
   * the row was FILTERED OUT of the transition targets by this set, and it came
   * back out if the server said no — a fourth optimism mechanism beside the
   * three #263 collapsed into the overlay, and one that only knew about this one
   * screen (the same archive from the context menu or the palette painted
   * nothing).
   *
   * `archiveIssue` is outboxed now, so the queued entry paints `archived: true`
   * over the replica row and the worklist drops it before this component runs.
   * Hiding is no longer this set's job. What is left is presentation and only
   * presentation: an exit caused by THIS button gets the quick archive exit
   * rather than the ordinary one, and nothing else can tell those apart. Ids are
   * pruned as their exits finish, so the set tracks live exits and never grows.
   */
  const [quickArchiveExitIds, setQuickArchiveExitIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const stableRowsRef = useRef<UnifiedWorkRow[]>([])
  const stablePlacementsRef = useRef(new Map<string, WorkPlacement>())
  useEffect(() => {
    setSelectedClosedPlacement((placement) =>
      placement && placement.issueId !== selectedIssueId ? null : placement,
    )
  }, [selectedIssueId])

  // Tuck-away (POD-293): a finished row folds into Closed only when the operator
  // dismisses it (or after the finished-grace backstop) — not the instant it
  // finishes — so completed work stops vanishing out from under them. Read and
  // idle sessions are not required for the control.
  //
  // The dismissal is SERVER state (POD-333): `issue.tuckedAt`, read by the
  // derivation straight off the row. It used to be a `podium:sidebar:tucked:<id>`
  // key in this browser's local ui-state, which meant the fold reset on a new
  // browser or machine and two open clients disagreed about what was tucked.
  // The server also owns the clear-on-reopen rule now, so a reopened issue
  // cannot inherit a tuck from a prior close. `setIssueTucked` is optimistic
  // (outbox overlay) — the row folds on the press, before the round-trip.
  const tuck = (id: string) => {
    void setIssueTucked(id, true)
  }
  // And back out again (POD-1188). Same store action with the flag flipped, so
  // the row leaves the fold on the press through the same outbox overlay that
  // put it there — nothing here is a second mechanism.
  const bringBack = (id: string) => {
    void setIssueTucked(id, false)
  }
  /**
   * WHICH FOLDED ROW IS RIGHT-CLICKED. Column state, not row state: the folded
   * rows are rendered by `renderWorkRow`, which is a function rather than a
   * component and so has nowhere to keep a `useState` of its own — the same
   * reason the Flight Deck hosts one menu for its whole spine. The row is
   * addressed by id and looked up at render, so an untuck (or an archive, or a
   * reopen from anywhere else) cannot leave the panel describing a stale row.
   */
  const [foldedMenu, setFoldedMenu] = useState<{
    issueId: string
    anchor: ContextMenuAnchor
  } | null>(null)
  const closeFoldedMenu = useCallback(() => setFoldedMenu(null), [])
  const openFoldedMenu = (issueId: string, event: ReactMouseEvent): void => {
    event.preventDefault()
    setFoldedMenu({ issueId, anchor: { x: event.clientX, y: event.clientY } })
  }
  const selectedWasFolded =
    selectedClosedPlacement?.issueId === selectedIssueId && selectedClosedPlacement.folded
  const forgetQuickArchive = (ids: readonly string[]): void => {
    if (ids.length === 0) return
    setQuickArchiveExitIds((current) => {
      if (!ids.some((id) => current.has(id))) return current
      const next = new Set(current)
      for (const id of ids) next.delete(id)
      return next
    })
  }
  const archiveClosedIssue = (id: string): void => {
    setQuickArchiveExitIds((current) => new Set(current).add(id))
    // The overlay repaints the list; a refusal drops it and the row returns, at
    // which point the exit never happened and the marker must not linger to
    // restyle some later, unrelated exit of the same row.
    void archiveIssue(id).catch(() => forgetQuickArchive([id]))
  }

  // The pinned split and the project-group tree come from the PUBLISHED slice
  // (POD-407) — derived once per snapshot for every reader, rather than once per
  // consumer here. See `WorklistSlice.groups`.
  //
  // The one exception is the lane-stickiness latch: while a settled CLOSED row is
  // selected and was folded when clicked, it must stay folded, and that latch is
  // a property of this interaction on this screen, not of the world. So the
  // grouping is recomputed for exactly that window and read straight off the
  // slice the rest of the time. The condition is the whole cost — when no closed
  // row is latched (the ordinary case, and every other consumer, always) this is
  // a read.
  const targetGroups = useMemo(
    () =>
      selectedWasFolded
        ? groupUnifiedWorkRows(splitPinnedWork(work).rest, selectedIssueId, true, now)
        : publishedGroups,
    [publishedGroups, selectedWasFolded, work, selectedIssueId, now],
  )
  // NO PROPOSED FOLD (POD-516 round 2, left sidebar item 3). A previous round
  // derived an intake queue here from the raw issue list and rendered it as a
  // third fold. The operator's verdict: "dont put proposed section in here. not
  // needed! we only have the tucked away stuff + suspended." So it is gone
  // rather than hidden, and untriaged work does not reappear anywhere else in
  // this column — the worklist slice already drops `stage === 'proposed'` at
  // the row level (`rows.ts`: "the unified list is live work, not a tree"),
  // which is exactly why that derivation had to exist locally to begin with.
  // The only folds left are snoozed and closed.
  // The prune that used to live here — clearing an id once its row left
  // `closedRows` — is gone with the hiding it belonged to (POD-781). The overlay
  // takes the row out of `closedRows` on the press, so this effect fired BEFORE
  // the exit animation and would now clear the quick-exit marker just as the
  // marker was needed. Pruning moved below, to where the exits actually finish.
  const transitionTargets = useMemo<RowTransitionTarget<WorkPlacement>[]>(() => {
    const raw: Array<RowTransitionTarget<WorkPlacement>> = []
    const add = (key: string, placement: string, value: WorkPlacement): void => {
      raw.push({ key, placement, value })
    }
    for (const row of pinned) {
      add(row.kind === 'issue' ? `issue:${row.issue.id}` : `wt:${row.worktree.path}`, 'active', {
        lane: 'pinned',
        groupKey: 'pinned',
        groupLabel: 'Pinned',
        row,
      })
    }
    for (const group of targetGroups) {
      for (const row of group.rows) {
        add(row.kind === 'issue' ? `issue:${row.issue.id}` : `wt:${row.worktree.path}`, 'active', {
          lane: 'open',
          groupKey: group.key,
          groupLabel: group.label,
          row,
        })
      }
      for (const row of group.snoozedRows) {
        if (row.kind !== 'issue') continue
        add(`issue:${row.issue.id}`, `snoozed:${group.key}`, {
          lane: 'snoozed',
          groupKey: group.key,
          groupLabel: group.label,
          row,
        })
      }
      // NO ARCHIVE FILTER (POD-781): an archived row is already absent from
      // `group.closedRows` — the outbox overlay paints `archived: true` and
      // the worklist derivation drops it. Filtering here as well would be a
      // second hiding rule racing the first, and the one that lost would
      // decide whether the exit animation ever ran.
      for (const row of group.closedRows) {
        if (row.kind !== 'issue') continue
        add(`issue:${row.issue.id}`, `closed:${group.key}`, {
          lane: 'closed',
          groupKey: group.key,
          groupLabel: group.label,
          row,
        })
      }
    }

    const stableRows = reuseUnifiedWorkRows(
      stableRowsRef.current,
      raw.map((target) => target.value.row),
    )
    stableRowsRef.current = stableRows
    const stableByKey = new Map(
      stableRows.map((row) => [
        row.kind === 'issue' ? `issue:${row.issue.id}` : `wt:${row.worktree.path}`,
        row,
      ]),
    )
    const activeSlots = new Set<string>()
    const stableTargets = raw.map((target) => {
      const slot = `${target.key}\u0000${target.placement}`
      activeSlots.add(slot)
      const row = stableByKey.get(target.key) ?? target.value.row
      const nextValue = withStableRow(target.value, row)
      const previous = stablePlacementsRef.current.get(slot)
      const value =
        previous &&
        previous.lane === nextValue.lane &&
        previous.groupKey === nextValue.groupKey &&
        previous.groupLabel === nextValue.groupLabel &&
        previous.row === nextValue.row
          ? previous
          : nextValue
      stablePlacementsRef.current.set(slot, value)
      return { ...target, value }
    })
    for (const slot of stablePlacementsRef.current.keys()) {
      if (!activeSlots.has(slot)) stablePlacementsRef.current.delete(slot)
    }
    return stableTargets
  }, [pinned, targetGroups])
  const { items: transitionRows, settle, discardExit } = useRowTransitions(transitionTargets)

  // Prune the quick-exit markers once their rows are gone from the transition
  // list — the exit has played and the styling has nothing left to style. Kept
  // as an effect over what is actually on screen rather than a timer: the exit's
  // duration is the motion layer's business, not this component's.
  useEffect(() => {
    // GUARD THE CALL, NOT JUST THE UPDATE — and the difference is a whole render
    // pass (POD-330 probe: 3.2 commits per publish against a 2.2 ceiling).
    //
    // The identity-preserving arm below stops this effect LOOPING, which is what
    // its old comment claimed and all it ever claimed correctly. It does not stop
    // the first extra render: React only takes the eager-bailout path on a no-op
    // setState while the fiber is quiescent, and since POD-781 (9162bb687) re-keyed
    // this effect from `targetGroups` to `transitionRows` it runs in the passive
    // phase of `useRowTransitions`' own nested update — never quiescent. So every
    // publish paid for a third render to be told nothing had changed.
    //
    // The set is empty in every frame except the few between an archive press and
    // its exit finishing, so returning early is the steady state.
    if (quickArchiveExitIds.size === 0) return
    const onScreen = new Set(transitionRows.map((item) => item.key))
    setQuickArchiveExitIds((current) => {
      if (current.size === 0) return current
      const next = new Set([...current].filter((id) => onScreen.has(`issue:${id}`)))
      return next.size === current.size ? current : next
    })
    // `quickArchiveExitIds` is a real dependency — the guard above reads it — and
    // naming it costs one extra run when the set itself changes, on the archive
    // press only. The updater stays in functional form against a stale closure.
  }, [transitionRows, quickArchiveExitIds])

  // Grip-drag manual sort (POD-168): drops persist fractional sortKeys through
  // issues.update; crossing the PINNED boundary toggles `pinned`. Outboxed
  // (POD-781), so the drop's own overlay repaints the order and the hook keeps no
  // preview of its own. Reordering never touches row KEYS — so useArrivals stays
  // silent (no arrival one-shot on a drag, only on genuinely new rows).
  const issueById = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])
  const { startDrag, dragging } = useRowDrag({
    allowedTargets: (sourceScope, movedId) => {
      if (sourceScope === 'pinned') {
        // NARROWING AT THE DISCRIMINANT, not an adapter cast: `useRowDrag` hands
        // back ids read out of `data-drag-key` DOM attributes and stays generic
        // over row kinds by design. `sourceScope === 'pinned'` IS the proof that
        // this particular id is an issue id, so the brand is applied where that
        // fact is known rather than at the hook's declaration.
        const moved = issueById.get(asIssueId(movedId))
        return moved ? [`group:${moved.repoId ?? moved.repoPath}`] : []
      }
      if (sourceScope.startsWith('group:')) return ['pinned']
      return [] // children scopes: strictly within the parent
    },
    onDrop: ({ sourceScope, targetScope, movedId, order }): Promise<unknown> => {
      // Same DOM-attribute origin and same narrowing as `allowedTargets` above:
      // every scope this sidebar drags within is an issue row scope.
      const patches = planReorderKeys(order, movedId, (id) => issueById.get(asIssueId(id))?.sortKey)
      const crossedPinned = sourceScope !== targetScope
      // RETURNED, not fire-and-forget: the hook holds the gesture's transforms
      // until the enqueue settles, which is the one frame between the release and
      // the overlay's repaint. No `.catch` beyond that — the queue owns the write
      // from here, and a definitive refusal drops the overlay and toasts rather
      // than silently reverting a row nobody was told about.
      return applySortPatches(
        patches.map((p) => ({
          ...p,
          ...(crossedPinned && p.id === movedId ? { pinned: targetScope === 'pinned' } : {}),
        })),
      )
    },
  })
  const onGripDown = (e: ReactPointerEvent, issueId: IssueId) => startDrag(e, issueId)

  // Motion's layout feature otherwise measures every mounted row whenever the
  // sidebar receives an unrelated store update. Feed it a structural revision
  // derived only from row slots; content/clock updates keep the same revision,
  // while insertion, removal, lane changes, and reordering opt the measurement
  // back in for the affected frame.
  //
  // AND IT STANDS STILL FOR THE WHOLE OF A DRAG (POD-1191). This revision is the
  // only thing in the app that makes Motion measure — `layoutDependency` is what
  // `MeasureLayout` gates `willUpdate` on, every `layout` site in the sidebar
  // passes this one value, and nothing else here uses `layoutId` or
  // `AnimatePresence`. So holding it still IS the suspension `useRowDrag`
  // requires: no measure pass, and therefore nothing writing `style.transform`
  // on the rows the gesture has taken ownership of.
  //
  // Freezing the SIGNATURE with it matters as much as freezing the number. The
  // drop's own repaint arrives while `dragging` is still true, so the reorder
  // lands with no layout animation at all — which is exactly right, because the
  // preview already put every row where the new order wants it, and the
  // alternative was Motion measuring its "before" boxes THROUGH the gesture's
  // transforms and animating 300ms from a place no row had ever been. When the
  // transforms come off and the flag drops, this bumps once, Motion measures a
  // settled DOM, finds no delta, and stays quiet.
  const layoutSignature = transitionTargets
    .map((target) => `${target.key}:${target.placement}`)
    .join('|')
  const layoutRevisionRef = useRef({ signature: '', revision: 0 })
  if (!dragging && layoutRevisionRef.current.signature !== layoutSignature) {
    layoutRevisionRef.current = {
      signature: layoutSignature,
      revision: layoutRevisionRef.current.revision + 1,
    }
  }
  const layoutRevision = layoutRevisionRef.current.revision

  // SECTION BANDS FOLD (POD-1057): `Pinned`, and one band per project. Read
  // here rather than inside each band because the list itself has to consult it
  // — see the shortcut numbering below.
  const bandKeys = useMemo(
    () => [PINNED_FOLD_KEY, ...targetGroups.map((group) => projectFoldKey(group.key))],
    [targetGroups],
  )
  const [collapsedBands, toggleBand] = useCollapsedKeys(bandKeys)
  const pinnedCollapsed = collapsedBands.has(PINNED_FOLD_KEY)
  const groupCollapsed = (groupKey: string): boolean => collapsedBands.has(projectFoldKey(groupKey))

  // ⌘-hold row shortcuts (POD-790). The order is the column's own reading order
  // — pinned first, then each project group's live rows — taken from the SETTLED
  // groups rather than from `transitionRows`, so a row on its way out cannot
  // renumber the rows above it mid-animation.
  //
  // Only live issue rows are numbered. A SHUT BAND is skipped whole, for the
  // same reason the folds are: a digit pointing into collapsed content selects
  // something the operator cannot see. Worktree rows are skipped because they
  // are roster BANDS, not tasks — the thing being counted here is "the missions
  // in my column".
  const activateRow = (row: UnifiedIssueRowView): void => {
    setSelectedClosedPlacement({ issueId: row.issue.id, folded: false })
    // Exactly what clicking the row does, draft carve-out included: a draft
    // whose only content is its agent opens the session, not the empty issue.
    const first = row.sessions[0]
    if (isDraftAgentVessel(row.issue, row.sessions) && first)
      selectPanelForIssue(row.issue, first.sessionId)
    else selectIssue(row.issue)
  }
  const shortcutRows: UnifiedIssueRowView[] = []
  for (const group of [
    { rows: pinnedCollapsed ? [] : pinned },
    ...targetGroups.map((group) => ({ rows: groupCollapsed(group.key) ? [] : group.rows })),
  ]) {
    for (const row of group.rows) {
      if (row.kind === 'issue' && shortcutRows.length < MAX_ROW_SHORTCUTS) shortcutRows.push(row)
    }
  }
  const { numbers: shortcutNumbers } = useRowShortcuts(
    shortcutRows.map<RowShortcutTarget>((row) => ({
      id: row.issue.id,
      activate: () => activateRow(row),
    })),
  )

  // THE FILTER NARROWS THE LIST; IT DOES NOT REBUILD IT (POD-1078). It is applied
  // below, to the rows the transition layer already settled, rather than upstream
  // of the placements: a query is a VIEW of the column, and rebuilding the
  // placement set per keystroke would run every hidden row through the entering/
  // exiting machinery — thirty rows flying out on `w`, back in on backspace.
  // Read HERE, above the row renderer, because the grip consults it too — see
  // `draggable`.
  const filtering = normalizeWorkQuery(query).length > 0

  const renderWorkRow = (item: TransitionWorkRow, animate = true) => {
    const { row, lane } = item.value
    const folded = lane === 'closed' || lane === 'snoozed'
    const arriving = animate && item.phase === 'entering'
    const exiting = item.phase === 'exiting'
    const quickArchiveExit =
      exiting && row.kind === 'issue' && quickArchiveExitIds.has(row.issue.id)
    // WHAT MAY CARRY A GRIP IS ALSO WHAT MAY BE A NEIGHBOUR (POD-1102). The drop
    // reads the scope's new order straight back out of `data-drag-key`, so this
    // one predicate decides two things at once, and the two rows below belong in
    // neither role:
    //
    //  - AN EXITING ROW is on screen only until its animation finishes. It has
    //    already left the list the order describes, so counting it plans a
    //    sortKey write against a row that is gone (archived, closed, moved to
    //    another band) and mints the moved row's key against a neighbour the
    //    operator can no longer see.
    //  - A FILTERED COLUMN is not the scope. `data-drag-key` is only on the rows
    //    a query left standing, so the order read at the drop is a SUBSET —
    //    every hidden row between the visible ones is invisible to the plan, and
    //    the backfill path renumbers the whole visible set, which for a filtered
    //    column means renumbering a sample and scattering the rest. Manual order
    //    is a statement about the whole scope; it is only offered over one.
    const draggable =
      row.kind === 'issue' && !exiting && !filtering && !isIssueDeferred(row.issue, now)
    const inner =
      folded && row.kind === 'issue' ? (
        // Closed / suspended issues drop to one dim line (POD-293) — no chrome,
        // no unread, just how the work ended and a click back into it.
        <FoldedWorkRow
          issue={row.issue}
          lane={lane as 'closed' | 'snoozed'}
          now={now}
          active={selectedIssueId === row.issue.id}
          onSelect={() => {
            setSelectedClosedPlacement({ issueId: row.issue.id, folded })
            selectIssue(row.issue)
          }}
          // Only the CLOSED lane (POD-1188): the one thing this menu offers is
          // the inverse of Tuck, and a snoozed row was never tucked — its own
          // inverse is Unsnooze, which the live row's menu already carries.
          onContextMenu={
            lane === 'closed' ? (event) => openFoldedMenu(row.issue.id, event) : undefined
          }
        />
      ) : row.kind === 'issue' ? (
        <UnifiedIssueRow
          row={row}
          shortcutDigit={shortcutNumbers.get(row.issue.id)}
          allWorktreePaths={allWorktreePaths}
          sessions={sessions}
          issues={issues}
          selectedIssueId={selectedIssueId}
          paneA={paneA}
          now={now}
          onSelectIssue={(issue) => {
            setSelectedClosedPlacement({ issueId: issue.id, folded })
            selectIssue(issue)
          }}
          onSelectPanelForIssue={(issue, sessionId) => {
            setSelectedClosedPlacement({ issueId: issue.id, folded })
            selectPanelForIssue(issue, sessionId)
          }}
          onOpenIssue={openIssuePage}
          onRenameIssue={renameIssue}
          onGripDown={draggable ? onGripDown : undefined}
          onTuck={
            rowAwaitsTuck(row, selectedIssueId, selectedWasFolded, now)
              ? () => tuck(row.issue.id)
              : undefined
          }
        />
      ) : (
        <UnifiedWorktreeRow
          row={row}
          issues={issues}
          active={selectedIssueId === null && selectedWorktree === row.worktree.path}
          paneA={paneA}
          now={now}
          onSelect={() => selectWorktree(row.worktree.path)}
          onSelectPanel={(sid) => selectPanel(row.worktree.path, sid)}
        />
      )
    return (
      <motion.div
        key={`${item.key}:${item.placement}`}
        layout="position"
        layoutDependency={layoutRevision}
        transition={shouldReduceMotion ? { duration: 0 } : { layout: ROW_LAYOUT_TRANSITION }}
        {...(row.kind === 'issue' && draggable ? { 'data-drag-key': row.issue.id } : {})}
        className={cn(
          'min-w-0',
          arriving && 'row-arrive',
          exiting && 'pointer-events-none',
          folded &&
            'opacity-50 transition-opacity duration-150 hover:opacity-80 focus-within:opacity-80',
        )}
        style={
          arriving && row.kind === 'issue'
            ? ({
                '--arrive-tint': issueColorHex(row.issue.color),
              } as CSSProperties)
            : undefined
        }
        onAnimationEnd={
          arriving
            ? (e) => {
                // The wash is the longest of the three one-shots — its end (which
                // bubbles up from the row) means the arrival is fully over.
                if (e.animationName === 'podium-arrive-wash') settle(item.key, item.placement)
              }
            : undefined
        }
        data-transition-phase={item.phase}
      >
        <motion.div
          initial={arriving && !shouldReduceMotion ? { opacity: 0, y: -8 } : false}
          animate={exiting ? { opacity: 0, y: -6 } : { opacity: 1, y: 0 }}
          // ARMED ONLY WHILE THE ROW IS ACTUALLY EXITING. `quickArchiveExit`
          // alone also covers the window between the archive press and the
          // overlay dropping the row — where this row still animates to its
          // RESTING target, completes immediately, and would discard an exit
          // that has not begun. `discardExit` is a read when it matches nothing,
          // so that was no longer a crash; not arming it is the other half.
          onAnimationComplete={
            exiting && quickArchiveExit ? () => discardExit(item.key, item.placement) : undefined
          }
          transition={
            shouldReduceMotion
              ? { duration: 0 }
              : exiting
                ? quickArchiveExit
                  ? {
                      opacity: { duration: 0.14, ease: 'easeOut' },
                      y: { duration: 0.18, ease: [0.4, 0, 1, 1] },
                    }
                  : {
                      opacity: { duration: 0.64, ease: 'easeInOut' },
                      y: { duration: 0.7, ease: [0.4, 0, 1, 1] },
                    }
                : {
                    opacity: {
                      duration: 0.72,
                      delay: arriving ? 0.22 : 0,
                      ease: 'easeInOut',
                    },
                    y: {
                      duration: 0.78,
                      delay: arriving ? 0.14 : 0,
                      ease: [0.22, 1, 0.36, 1],
                    },
                  }
          }
        >
          {inner}
        </motion.div>
      </motion.div>
    )
  }

  const survives = (item: TransitionWorkRow): boolean =>
    !filtering || matchesWorkQuery(item.value.row, query, now)
  // The haystack the footnote names: the same live pool the field counts over.
  const filterTotal = transitionRows.filter(
    (item) => item.value.lane === 'pinned' || item.value.lane === 'open',
  ).length
  const renderedPinned = transitionRows.filter((item) => item.value.lane === 'pinned')
  const renderedGroupKeys = targetGroups.map((group) => group.key)
  for (const item of transitionRows) {
    if (item.value.lane !== 'pinned' && !renderedGroupKeys.includes(item.value.groupKey))
      renderedGroupKeys.push(item.value.groupKey)
  }
  const renderedGroups = renderedGroupKeys
    .map((groupKey) => {
      const target = targetGroups.find((group) => group.key === groupKey)
      const fallback = transitionRows.find((item) => item.value.groupKey === groupKey)
      const inGroup = (lane: WorkPlacement['lane']) =>
        transitionRows.filter(
          (item) => item.value.groupKey === groupKey && item.value.lane === lane,
        )
      return {
        key: groupKey,
        label: target?.label ?? fallback?.value.groupLabel ?? groupKey,
        rows: inGroup('open').filter(survives),
        // THE TAIL FOLDS CLOSE FOR THE DURATION OF A QUERY. They are archives
        // with their own counts, shut by default, and a `12 closed` line under
        // two matching rows says nothing about the query — the count is of the
        // fold, not of the hits, and opening it would answer a question the
        // filter was not asked. The band's count stays the hit count.
        snoozedRows: filtering ? [] : inGroup('snoozed'),
        closedRows: filtering ? [] : inGroup('closed'),
      }
    })
    // A project with no hit leaves entirely, band and all: an empty band under a
    // filter is a row of chrome claiming a group that has nothing to show.
    .filter((group) => !filtering || group.rows.length > 0)
  const filteredPinned = renderedPinned.filter(survives)
  // The folded menu's subject, looked up rather than carried in the state above.
  const foldedMenuRow = foldedMenu
    ? work.find((row) => row.kind === 'issue' && row.issue.id === foldedMenu.issueId)
    : undefined

  // Zero work, and not a loading frame: the ghost preview (POD-1058) shows the
  // shape of the list this column is about to become, under a label that names
  // WHICH project is empty.
  if (transitionRows.length === 0) return <WorkListEmpty />
  // Zero HITS is a different answer, and must not borrow the ghost: the ghost
  // says "nothing is here yet", which would be a lie about a column holding
  // thirty rows the query happens to miss.
  if (filtering && filteredPinned.length === 0 && renderedGroups.length === 0)
    return <WorkFilterEmpty />

  // Pinned issues MOVE above all project groups (POD-166, R3) — they leave
  // their group entirely; unpinning returns them to its banded order.
  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup id={layoutGroupId}>
        {filteredPinned.length > 0 && (
          <motion.div
            layout="position"
            layoutDependency={layoutRevision}
            transition={shouldReduceMotion ? { duration: 0 } : { layout: ROW_LAYOUT_TRANSITION }}
            className="flex min-w-0 flex-col"
            data-testid="pinned-section"
            data-drag-scope="pinned"
          >
            <PinnedSectionLabel
              count={filteredPinned.length}
              collapsed={pinnedCollapsed}
              onToggle={() => toggleBand(PINNED_FOLD_KEY)}
            />
            <FoldPanel open={!pinnedCollapsed} testId="pinned-section-rows">
              {filteredPinned.map((item) => renderWorkRow(item))}
            </FoldPanel>
          </motion.div>
        )}
        {renderedGroups.map((group, index) => {
          // A shut band takes the WHOLE group with it — its live rows and both
          // of its tail folds. Half a collapsed project (a band with a Closed
          // fold still hanging under it) would be the worst of both readings.
          const collapsed = groupCollapsed(group.key)
          return (
            <motion.div
              layout="position"
              layoutDependency={layoutRevision}
              transition={shouldReduceMotion ? { duration: 0 } : { layout: ROW_LAYOUT_TRANSITION }}
              key={group.key}
              // Every section but the FIRST one on screen takes the 14px gap:
              // pinned opens the column when it is there, this group when it is
              // not, and the opening band sits flush under the search field.
              className={cn(
                'flex min-w-0 flex-col',
                (index > 0 || filteredPinned.length > 0) && SECTION_GAP_CLASS,
              )}
              data-testid="project-group"
              data-collapsed={collapsed ? 'true' : 'false'}
              data-drag-scope={`group:${group.key}`}
            >
              <ProjectGroupLabel
                label={group.label}
                count={group.rows.length}
                collapsed={collapsed}
                onToggle={() => toggleBand(projectFoldKey(group.key))}
              />
              {/* ONE PANEL FOR THE WHOLE GROUP (POD-1253). A shut band takes its
                  live rows and both tail folds with it — see `collapsed` above —
                  so the three of them fold as one surface rather than as three
                  clips racing each other down the column. */}
              <FoldPanel open={!collapsed} testId="project-group-rows">
                {group.rows.map((item) => renderWorkRow(item))}
                {group.snoozedRows.length > 0 && (
                  <motion.div
                    layout="position"
                    layoutDependency={layoutRevision}
                    transition={
                      shouldReduceMotion ? { duration: 0 } : { layout: ROW_LAYOUT_TRANSITION }
                    }
                  >
                    <SnoozedIssueFold
                      groupKey={group.key}
                      rows={group.snoozedRows}
                      renderRow={renderWorkRow}
                      settleTransition={settle}
                    />
                  </motion.div>
                )}
                {/* The column's one tail fold. Suspended work folds above it. */}
                {group.closedRows.length > 0 && (
                  <motion.div
                    layout="position"
                    layoutDependency={layoutRevision}
                    transition={
                      shouldReduceMotion ? { duration: 0 } : { layout: ROW_LAYOUT_TRANSITION }
                    }
                  >
                    <ClosedIssueFold
                      groupKey={group.key}
                      rows={group.closedRows}
                      renderRow={renderWorkRow}
                      issueForRow={(item) => item.value.row as UnifiedIssueRowView}
                      onArchive={archiveClosedIssue}
                    />
                  </motion.div>
                )}
              </FoldPanel>
            </motion.div>
          )
        })}
        {/* How big the haystack was, under the last hit — the answer to the
            question a suddenly-short column raises. */}
        {filtering && <WorkFilterFootnote total={filterTotal} />}
        {/* One menu for the whole column, portalled to the cursor — see the
            `foldedMenu` state for why it is not per row. */}
        {foldedMenu && foldedMenuRow?.kind === 'issue' && (
          <FoldedRowMenu
            issue={foldedMenuRow.issue}
            canBringBack={rowCanBringBack(foldedMenuRow, now)}
            anchor={foldedMenu.anchor}
            onClose={closeFoldedMenu}
            onBringBack={() => bringBack(foldedMenuRow.issue.id)}
          />
        )}
      </LayoutGroup>
    </MotionConfig>
  )
}
