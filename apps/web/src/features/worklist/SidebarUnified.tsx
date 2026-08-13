import {
  groupUnifiedWorkRows,
  isDraftAgentVessel,
  planReorderKeys,
  rowAwaitsTuck,
  splitPinnedWork,
  type UnifiedIssueRow as UnifiedIssueRowView,
} from '@podium/client-core/viewmodels'
import { asIssueId, isIssueDeferred, type IssueId } from '@podium/model/browser'
import { LayoutGroup, MotionConfig, motion, useReducedMotion } from 'motion/react'
import type { CSSProperties, JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useId, useMemo, useState } from 'react'
import { issueColorHex } from '@/lib/issueColors'
import { type RowTransitionTarget, useRowTransitions } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { type SidebarDerivation, useSidebarDerivation } from './derivation'
import { MAX_ROW_SHORTCUTS, type RowShortcutTarget, useRowShortcuts } from './row-shortcuts'
import { AppToolsRow, NewWorkRow } from './spawn-row'
import { UnifiedIssueRow } from './UnifiedIssueRow'
import { UnifiedWorktreeRow } from './UnifiedWorktreeRow'
import { useUnifiedWork } from './use-unified-work'
import { useRowDrag } from './useRowDrag'
import { BRIDGE_NOTCH_W } from './WorkRowShell'
import {
  ClosedIssueFold,
  FoldedWorkRow,
  PinnedSectionLabel,
  ProjectGroupLabel,
  ROW_LAYOUT_TRANSITION,
  SnoozedIssueFold,
  type TransitionWorkRow,
  type WorkPlacement,
} from './work-folds'

/**
 * The redesigned work sidebar (#41, .design/specs/sidebar.md): the
 * `New <Agent> in <Repo>` spawn row over ONE list of work rows grouped by
 * project (mono section labels), each row carrying its ID square, two-line
 * status anatomy, motion-grammar meta and — when selected — the bridge notch
 * growing toward the engraved column.
 *
 * The pieces are exported separately because the collapsed rail shares their
 * hooks and row behavior.
 */

export function SidebarUnified(): JSX.Element {
  const derivation = useSidebarDerivation()
  return (
    <>
      <NewWorkRow sections={derivation.sections} />
      {/* The seam under the spawn row is the section bar's own bottom border
          now (POD-365) — one line at the shell's datum, shared by every column,
          rather than three columns each drawing their own at a different y.
          POD-388's theming of this divider goes with the divider; the border
          that replaced it takes `hairline-soft` from the same ramp.

          NO COLUMN-WIDE STATUS INSTRUMENT (POD-516 round 3). Round 2 put a
          "12/40 done · 5 running" meter here, summarising every mission in the
          column. The operator cut it: "there's now a overall progress section in
          the header of the sidebar. This was uncalled for." Progress moved to
          the rows themselves (`RowProgressMeter`), where it is a fact about one
          thing the operator can click rather than an aggregate over a scope
          nobody asked about. What is left is the 9px spacer that was always
          here, so the list starts where it always did. */}
      <div className="h-[9px] flex-none" aria-hidden="true" />
      {/* The scroll container leaves horizontal head-room past the aside edge
          (negative margin + matching padding) so the selected row's bridge notch
          can paint OVER the aside border into the engraved column — overflow
          clips at the padding box, so the notch survives (#41).

          THE HEAD-ROOM IS THE NOTCH'S WIDTH, NOT A PIXEL LESS (POD-761). It was
          5px against a 10px notch, so half the notch fell outside the padding
          box — where it was not painted but WAS scrollable overflow, and every
          selected row gave the column a 5px sideways scroll. Anything that hangs
          off a row's right edge has to fit in here, or it comes back as scroll.
          `overflow-x-clip` holds that line: it makes the head-room a PAINTING
          allowance rather than a scrollable one, since `overflow-y: auto` alone
          computes the x axis to `auto`. (Chrome computes the pair to `hidden`,
          which still measures overflow — hence the width match above, which is
          what actually removes it.)
          The padding matches the negative margin exactly now (POD-725): rows are
          FULL-BLEED bands, so the list has no side inset of its own and each row
          owns its 14px text inset. No row gap either — rows are separated by
          their own hairline rules; between groups the project-group mb-2.5
          clusters repo + snoozed/done as one unit. */}
      <div
        data-testid="work-scroll"
        className="scroll-none flex min-h-0 flex-1 flex-col overflow-x-clip overflow-y-auto pb-2.5"
        style={{ marginRight: -BRIDGE_NOTCH_W, paddingRight: BRIDGE_NOTCH_W }}
      >
        <WorkSections derivation={derivation} />
      </div>
      {/* Footer: the design's 38px strip at the column's 16px inset. The mock
          writes `new task` / `search` as bare mono words; we keep our muted icon
          controls (operator call) and the ⌘K hint stays right-aligned. */}
      <AppToolsRow className="h-[38px] flex-none border-t border-hairline-soft px-4" />
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

export function WorkSections({ derivation }: { derivation?: SidebarDerivation } = {}): JSX.Element {
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
    setIssueColor,
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
  const transitionTargets = useMemo<RowTransitionTarget<WorkPlacement>[]>(
    () => [
      ...pinned.map((row) => ({
        key: row.kind === 'issue' ? `issue:${row.issue.id}` : `wt:${row.worktree.path}`,
        placement: 'active',
        value: {
          lane: 'pinned' as const,
          groupKey: 'pinned',
          groupLabel: 'Pinned',
          row,
        },
      })),
      ...targetGroups.flatMap((group) => [
        ...group.rows.map((row) => ({
          key: row.kind === 'issue' ? `issue:${row.issue.id}` : `wt:${row.worktree.path}`,
          placement: 'active',
          value: {
            lane: 'open' as const,
            groupKey: group.key,
            groupLabel: group.label,
            row,
          },
        })),
        ...group.snoozedRows.map((row) => ({
          key: `issue:${row.issue.id}`,
          placement: `snoozed:${group.key}`,
          value: {
            lane: 'snoozed' as const,
            groupKey: group.key,
            groupLabel: group.label,
            row,
          },
        })),
        // NO ARCHIVE FILTER (POD-781): an archived row is already absent from
        // `group.closedRows` — the outbox overlay paints `archived: true` and
        // the worklist derivation drops it. Filtering here as well would be a
        // second hiding rule racing the first, and the one that lost would
        // decide whether the exit animation ever ran.
        ...group.closedRows.map((row) => ({
          key: `issue:${row.issue.id}`,
          placement: `closed:${group.key}`,
          value: {
            lane: 'closed' as const,
            groupKey: group.key,
            groupLabel: group.label,
            row,
          },
        })),
      ]),
    ],
    [pinned, targetGroups],
  )
  const { items: transitionRows, settle, discardExit } = useRowTransitions(transitionTargets)

  // Prune the quick-exit markers once their rows are gone from the transition
  // list — the exit has played and the styling has nothing left to style. Kept
  // as an effect over what is actually on screen rather than a timer: the exit's
  // duration is the motion layer's business, not this component's.
  useEffect(() => {
    const onScreen = new Set(transitionRows.map((item) => item.key))
    // Functional form and an identity-preserving no-op arm: this runs on every
    // transition list change, and returning `current` unchanged is what stops it
    // re-rendering itself in a loop.
    setQuickArchiveExitIds((current) => {
      if (current.size === 0) return current
      const next = new Set([...current].filter((id) => onScreen.has(`issue:${id}`)))
      return next.size === current.size ? current : next
    })
  }, [transitionRows])

  // Grip-drag manual sort (POD-168): drops persist fractional sortKeys through
  // issues.update; crossing the PINNED boundary toggles `pinned`. Outboxed
  // (POD-781), so the drop's own overlay repaints the order and the hook keeps no
  // preview of its own. Reordering never touches row KEYS — so useArrivals stays
  // silent (no arrival one-shot on a drag, only on genuinely new rows).
  const issueById = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])
  const { startDrag } = useRowDrag({
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

  // ⌘-hold row shortcuts (POD-790). The order is the column's own reading order
  // — pinned first, then each project group's live rows — taken from the SETTLED
  // groups rather than from `transitionRows`, so a row on its way out cannot
  // renumber the rows above it mid-animation.
  //
  // Only live issue rows are numbered. The folds are skipped because a digit
  // pointing into collapsed content would select something the operator cannot
  // see, and worktree rows because they are roster BANDS, not tasks — the thing
  // being counted here is "the missions in my column".
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
  for (const group of [{ rows: pinned }, ...targetGroups]) {
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

  const renderWorkRow = (item: TransitionWorkRow, animate = true) => {
    const { row, lane } = item.value
    const folded = lane === 'closed' || lane === 'snoozed'
    const arriving = animate && item.phase === 'entering'
    const exiting = item.phase === 'exiting'
    const quickArchiveExit =
      exiting && row.kind === 'issue' && quickArchiveExitIds.has(row.issue.id)
    const draggable = row.kind === 'issue' && !isIssueDeferred(row.issue, now)
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
          onColorChangeIssue={setIssueColor}
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

  const renderedPinned = transitionRows.filter((item) => item.value.lane === 'pinned')
  const renderedGroupKeys = targetGroups.map((group) => group.key)
  for (const item of transitionRows) {
    if (item.value.lane !== 'pinned' && !renderedGroupKeys.includes(item.value.groupKey))
      renderedGroupKeys.push(item.value.groupKey)
  }
  const renderedGroups = renderedGroupKeys.map((groupKey) => {
    const target = targetGroups.find((group) => group.key === groupKey)
    const fallback = transitionRows.find((item) => item.value.groupKey === groupKey)
    return {
      key: groupKey,
      label: target?.label ?? fallback?.value.groupLabel ?? groupKey,
      rows: transitionRows.filter(
        (item) => item.value.groupKey === groupKey && item.value.lane === 'open',
      ),
      snoozedRows: transitionRows.filter(
        (item) => item.value.groupKey === groupKey && item.value.lane === 'snoozed',
      ),
      closedRows: transitionRows.filter(
        (item) => item.value.groupKey === groupKey && item.value.lane === 'closed',
      ),
    }
  })

  if (transitionRows.length === 0) {
    return (
      <div className="p-3 text-xs text-muted-foreground/70">
        Nothing yet — start an agent or create an issue above.
      </div>
    )
  }
  // Pinned issues MOVE above all project groups (POD-166, R3) — they leave
  // their group entirely; unpinning returns them to its banded order.
  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup id={layoutGroupId}>
        {renderedPinned.length > 0 && (
          <motion.div
            layout="position"
            transition={shouldReduceMotion ? { duration: 0 } : { layout: ROW_LAYOUT_TRANSITION }}
            className="mb-2.5 flex min-w-0 flex-col"
            data-testid="pinned-section"
            data-drag-scope="pinned"
          >
            <PinnedSectionLabel count={renderedPinned.length} />
            {renderedPinned.map((item) => renderWorkRow(item))}
          </motion.div>
        )}
        {renderedGroups.map((group, index) => (
          <motion.div
            layout="position"
            transition={shouldReduceMotion ? { duration: 0 } : { layout: ROW_LAYOUT_TRANSITION }}
            key={group.key}
            className="mb-2.5 flex min-w-0 flex-col last:mb-0"
            data-testid="project-group"
            data-drag-scope={`group:${group.key}`}
          >
            <ProjectGroupLabel
              label={group.label}
              count={group.rows.length}
              first={index === 0 && renderedPinned.length === 0}
            />
            {group.rows.map((item) => renderWorkRow(item))}
            {group.snoozedRows.length > 0 && (
              <motion.div
                layout="position"
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
            {/* The column's one tail fold. Suspended work folds above it; both
                are group headers, and they are the only foldable things in this
                column now that the rows are flat. */}
            {group.closedRows.length > 0 && (
              <motion.div
                layout="position"
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
          </motion.div>
        ))}
      </LayoutGroup>
    </MotionConfig>
  )
}
