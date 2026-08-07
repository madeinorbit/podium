import {
  groupUnifiedWorkRows,
  type IssueNavigationModel,
  rowAwaitsTuck,
  splitPinnedWork,
  type UnifiedIssueRow as UnifiedIssueRowView,
} from '@podium/client-core/viewmodels'
import { asIssueId, isIssueDeferred } from '@podium/model'
import { LayoutGroup, MotionConfig, motion, useReducedMotion } from 'motion/react'
import type { CSSProperties, JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useId, useMemo, useState } from 'react'
import { issueColorHex } from '@/lib/issueColors'
import { type RowTransitionTarget, useRowTransitions } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { type SidebarDerivation, useSidebarDerivation } from './derivation'
import { planReorderKeys } from './reorder'
import { AppToolsRow, NewWorkRow } from './spawn-row'
import { UnifiedIssueRow } from './UnifiedIssueRow'
import { UnifiedWorktreeRow } from './UnifiedWorktreeRow'
import { useUnifiedWork } from './use-unified-work'
import { useRowDrag } from './useRowDrag'
import {
  ClosedIssueFold,
  FoldedWorkRow,
  PinnedSectionLabel,
  ProjectGroupLabel,
  ProposedIssueFold,
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
          that replaced it takes `hairline-soft` from the same ramp. */}
      <div className="h-[9px] flex-none" aria-hidden="true" />
      {/* The scroll container leaves 5px of horizontal head-room past the aside
          edge (negative margin + matching padding) so the selected row's bridge
          notch can paint OVER the aside border into the engraved column —
          overflow clips at the padding box, so the notch survives (#41). Rows
          sit at the column's 8px side inset (13 − 5). Within a project group
          the 3px row gap holds; between groups the project-group mb-2.5
          clusters repo + snoozed/done as one unit. */}
      <div
        data-testid="work-scroll"
        className="scroll-none flex min-h-0 flex-1 flex-col gap-[3px] overflow-y-auto pb-2.5 pl-2"
        style={{ marginRight: -5, paddingRight: 13 }}
      >
        <WorkSections derivation={derivation} />
      </div>
      {/* Footer: 8px top / 10px sides, 4px own bottom + the column's 6px. */}
      <AppToolsRow className="flex-none border-t border-hairline-soft px-2.5 pt-2 pb-2.5" />
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
    issueId: string
    folded: boolean
  } | null>(null)
  const [archivingIssueIds, setArchivingIssueIds] = useState<ReadonlySet<string>>(() => new Set())
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
  const archiveClosedIssue = (id: string): void => {
    setArchivingIssueIds((current) => new Set(current).add(id))
    void archiveIssue(id).catch(() => {
      setArchivingIssueIds((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    })
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
  // PROPOSED WORK (POD-516 §1.1, item 5), keyed the same way the worklist groups
  // are so a repo's intake queue lands under its own project label.
  //
  // It is derived HERE rather than in the worklist slice on purpose: a proposed
  // issue has no session, no lifecycle and no row in the live list — the slice
  // deliberately drops it (`rows.ts`, "the unified list is live work, not a
  // tree"), and putting it back would leak untriaged work into every other
  // consumer of `work` (the command palette, mobile, the rail). The column that
  // wants it is this one.
  const proposedByGroup = useMemo(() => {
    const byGroup = new Map<string, IssueNavigationModel[]>()
    for (const issue of issues) {
      if (issue.stage !== 'proposed') continue
      if (issue.archived || issue.deletedAt || issue.audience === 'agent') continue
      const key = issue.repoId ?? issue.repoPath
      const list = byGroup.get(key) ?? []
      list.push(issue)
      byGroup.set(key, list)
    }
    // Newest proposal first: an intake queue is read from the top.
    for (const list of byGroup.values()) list.sort((a, b) => b.seq - a.seq)
    return byGroup
  }, [issues])
  useEffect(() => {
    const closedIds = new Set<string>(
      targetGroups.flatMap((group) => group.closedRows.map((row) => row.issue.id)),
    )
    setArchivingIssueIds((current) => {
      const next = new Set(current)
      for (const id of current) {
        if (!closedIds.has(id)) next.delete(id)
      }
      return next.size === current.size ? current : next
    })
  }, [targetGroups])
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
        ...group.closedRows
          .filter((row) => !archivingIssueIds.has(row.issue.id))
          .map((row) => ({
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
    [archivingIssueIds, pinned, targetGroups],
  )
  const { items: transitionRows, settle, discardExit } = useRowTransitions(transitionTargets)

  // Grip-drag manual sort (POD-168): drops persist fractional sortKeys through
  // issues.update; crossing the PINNED boundary toggles `pinned`. The preview
  // holds until the store echoes the new order (settleDrag in the effect below),
  // and reordering never touches row KEYS — so useArrivals stays silent (no
  // arrival one-shot on a drag, only on genuinely new rows).
  const issueById = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])
  const { startDrag, settleDrag } = useRowDrag({
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
    onDrop: ({ sourceScope, targetScope, movedId, order }) => {
      // Same DOM-attribute origin and same narrowing as `allowedTargets` above:
      // every scope this sidebar drags within is an issue row scope.
      const patches = planReorderKeys(order, movedId, (id) => issueById.get(asIssueId(id))?.sortKey)
      const crossedPinned = sourceScope !== targetScope
      void applySortPatches(
        patches.map((p) => ({
          ...p,
          ...(crossedPinned && p.id === movedId ? { pinned: targetScope === 'pinned' } : {}),
        })),
      ).catch(() => settleDrag())
    },
  })
  const onGripDown = (e: ReactPointerEvent, issueId: string) => startDrag(e, issueId)
  // The mutation round-trips over the ws; when the derived order lands, drop
  // the held drag preview (transforms) in the same commit.
  useEffect(() => {
    // `work` is the trigger: a fresh derived order means the reorder landed.
    void work
    settleDrag()
  }, [work, settleDrag])

  const renderWorkRow = (item: TransitionWorkRow, animate = true) => {
    const { row, lane } = item.value
    const folded = lane === 'closed' || lane === 'snoozed'
    const arriving = animate && item.phase === 'entering'
    const exiting = item.phase === 'exiting'
    const quickArchiveExit = exiting && row.kind === 'issue' && archivingIssueIds.has(row.issue.id)
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
          onAnimationComplete={
            quickArchiveExit ? () => discardExit(item.key, item.placement) : undefined
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
  // A repo whose only work is still proposed still earns its project group —
  // otherwise the intake queue would be unreachable exactly when it is all the
  // operator has.
  for (const groupKey of proposedByGroup.keys()) {
    if (!renderedGroupKeys.includes(groupKey)) renderedGroupKeys.push(groupKey)
  }
  const renderedGroups = renderedGroupKeys.map((groupKey) => {
    const target = targetGroups.find((group) => group.key === groupKey)
    const fallback = transitionRows.find((item) => item.value.groupKey === groupKey)
    const proposedRows = proposedByGroup.get(groupKey) ?? []
    return {
      key: groupKey,
      label:
        target?.label ??
        fallback?.value.groupLabel ??
        proposedRows[0]?.repoPath.split('/').pop() ??
        groupKey,
      rows: transitionRows.filter(
        (item) => item.value.groupKey === groupKey && item.value.lane === 'open',
      ),
      snoozedRows: transitionRows.filter(
        (item) => item.value.groupKey === groupKey && item.value.lane === 'snoozed',
      ),
      proposedRows,
      closedRows: transitionRows.filter(
        (item) => item.value.groupKey === groupKey && item.value.lane === 'closed',
      ),
    }
  })

  if (transitionRows.length === 0 && proposedByGroup.size === 0) {
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
            className="mb-2.5 flex min-w-0 flex-col gap-[3px]"
            data-testid="pinned-section"
            data-drag-scope="pinned"
          >
            <PinnedSectionLabel />
            {renderedPinned.map((item) => renderWorkRow(item))}
          </motion.div>
        )}
        {renderedGroups.map((group, index) => (
          <motion.div
            layout="position"
            transition={shouldReduceMotion ? { duration: 0 } : { layout: ROW_LAYOUT_TRANSITION }}
            key={group.key}
            className="mb-2.5 flex min-w-0 flex-col gap-[3px] last:mb-0"
            data-testid="project-group"
            data-drag-scope={`group:${group.key}`}
          >
            <ProjectGroupLabel
              label={group.label}
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
            {/* The artifact's two tail folds, in its order: Proposed, then
                Closed. Both are group headers — the only foldable things in
                this column now that the rows are flat. */}
            {group.proposedRows.length > 0 && (
              <motion.div
                layout="position"
                transition={
                  shouldReduceMotion ? { duration: 0 } : { layout: ROW_LAYOUT_TRANSITION }
                }
              >
                <ProposedIssueFold
                  groupKey={group.key}
                  issues={group.proposedRows}
                  now={now}
                  selectedIssueId={selectedIssueId}
                  onSelect={(issue) => {
                    setSelectedClosedPlacement(null)
                    selectIssue(issue)
                  }}
                />
              </motion.div>
            )}
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
                  archivingIssueIds={archivingIssueIds}
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
