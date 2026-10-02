/**
 * POD-4445 legacy control list — the pre-Stage-0 `SidebarUnified` shape, DELIBERATELY.
 *
 * This file mirrors what the app rendered BEFORE the Stage 0 fixes (POD-4416):
 * rows are plain (unmemoized) functions receiving the WHOLE `issues` and
 * `sessions` arrays as props plus fresh closures per render, with their own
 * O(N) scans inside. That shape is precisely what the isolation fence exists
 * to catch: any publish re-renders the list, and every row commits.
 *
 * DO NOT "fix" this file (no `memo`, no narrow props, no stable callbacks).
 * If a heartbeat ever stops committing every row, the armed control test
 * (`control.test.tsx`) fails — and that failure is the signal, not a bug.
 *
 * Greenfield arms MUST NOT import from here or from the legacy view-model /
 * slice code it reads (H4 shape review). The control is the exception: it IS
 * the current store, adapted to the `Arm` interface for measurement.
 */

import type { PodiumClientApi } from '@podium/client-core/api'
import type { Store } from '@podium/client-core/engine'
import {
  createSlicePublisher,
  type SliceDefinition,
  type UnifiedIssueRow,
  type UnifiedWorkRow,
  type WorklistSlice,
} from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'
import { asIssueId } from '@podium/model'
import { type ReactElement, useMemo, useState, useSyncExternalStore } from 'react'
import { CommitBoundary } from '../../../shared/src/row-shell'
import type { LegacyControlEngine } from './arm'

export type ControlSliceDef = SliceDefinition<Store<PodiumClientApi>, WorklistSlice>

export interface LegacyControlListProps {
  engine: LegacyControlEngine
  sliceDef: ControlSliceDef
}

/**
 * One row, pre-Stage-0 shape: the whole collections as props, a fresh
 * `onSelect` closure from the parent every render, and its own scans over the
 * arrays (cf. `UnifiedIssueRow.tsx`'s `issues.find` and per-row session
 * scans). Unmemoized on purpose.
 */
export function LegacyControlRow({
  row,
  issues,
  sessions,
  onSelect,
}: {
  row: UnifiedIssueRow
  issues: readonly { id: string; title: string }[]
  sessions: readonly SessionMeta[]
  onSelect: () => void
}): ReactElement {
  // Deliberate whole-array reads inside the row: the membership scan and the
  // title lookup every pre-Stage-0 row performed for itself.
  const mine = sessions.filter((session) => session.issueId === row.issue.id)
  const self = issues.find((issue) => issue.id === row.issue.id)
  const id = row.issue.id
  return (
    <CommitBoundary id={id}>
      <div data-issue-row={id}>
        <button type="button" data-pressable onClick={onSelect}>
          {row.issue.displayRef ?? `#${row.issue.seq}`} {self?.title ?? row.issue.title} (
          {mine.length})
        </button>
      </div>
    </CommitBoundary>
  )
}

/** One group header, unmemoized with a fresh toggle closure per render. */
export function LegacyControlGroupHeader({
  groupKey,
  label,
  openCount,
  closedCount,
  onToggle,
}: {
  groupKey: string
  label: string
  openCount: number
  closedCount: number
  onToggle: () => void
}): ReactElement {
  return (
    <div data-group={groupKey}>
      <button type="button" onClick={onToggle}>
        {label} {openCount}+{closedCount}
      </button>
    </div>
  )
}

function rowKey(row: UnifiedWorkRow): string {
  return row.kind === 'issue' ? row.issue.id : row.worktree.path
}

/**
 * The control list: pinned section, then per-group open lanes and the closed
 * fold. Unwindowed — pre-Stage-0 rendered every visible row — and every
 * callback below is a fresh closure, so no memo boundary could hold even if
 * one were added.
 *
 * LEGACY NESTING NOTE. The slice (`SliceSnapshot`) is flat: every visible
 * issue is a top-level row. Legacy RENDERING nests formal children inside
 * their parent's row, and this control renders the legacy lanes, not the
 * flat slice — so formal children (e.g. SMALL's i4/i9/i24/i29) have no
 * top-level row here and commit WITH their parent. That is the current
 * store's shape, deliberately: parity is checked on the snapshot (which
 * flattens), isolation on commits (which nest). An arm rendering flat will
 * commit those rows separately; the control committing fewer top-level rows
 * but MORE commits than snapshot rows (39 vs 37 at SMALL) is the shape
 * difference made visible.
 */
export function LegacyControlList({ engine, sliceDef }: LegacyControlListProps): ReactElement {
  const publisher = useMemo(() => createSlicePublisher(() => engine.getSnapshot()), [engine])
  const slice = useSyncExternalStore(
    (listener) => engine.subscribe(listener),
    () => publisher.read(sliceDef),
  )
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const store = engine.getSnapshot()
  const issues = store.issueProjections
  const sessions = store.sessions as readonly SessionMeta[]
  const select = (id: string): void => {
    engine.getSnapshot().setSelectedIssueId(asIssueId(id))
  }
  const renderRow = (row: UnifiedWorkRow): ReactElement | null => {
    if (row.kind !== 'issue') {
      return (
        <CommitBoundary key={rowKey(row)} id={row.worktree.path}>
          <div data-worktree-row={row.worktree.path}>{row.worktree.path}</div>
        </CommitBoundary>
      )
    }
    const issueRow = row
    return (
      <LegacyControlRow
        key={issueRow.issue.id}
        row={issueRow}
        issues={issues}
        sessions={sessions}
        onSelect={() => select(issueRow.issue.id)}
      />
    )
  }
  return (
    <div data-control-list>
      {slice.pinned.map(renderRow)}
      {slice.groups.map((group) => (
        <div key={group.key}>
          <LegacyControlGroupHeader
            groupKey={group.key}
            label={group.label}
            openCount={group.rows.length + group.snoozedRows.length}
            closedCount={group.closedRows.length}
            onToggle={() => {
              setCollapsed((previous) => {
                const next = new Set(previous)
                if (next.has(group.key)) next.delete(group.key)
                else next.add(group.key)
                return next
              })
            }}
          />
          {!collapsed.has(group.key) && group.rows.map(renderRow)}
          {!collapsed.has(group.key) && group.snoozedRows.map(renderRow)}
          {group.closedRows.map(renderRow)}
        </div>
      ))}
    </div>
  )
}
