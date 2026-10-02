/**
 * POD-4445 legacy control native list — the same unmemoized whole-array-props
 * shape as `list.tsx`, rendered in React Native primitives for the native
 * count lane (`harness/native/`).
 *
 * Under the mobile vitest lane `react-native` resolves to `react-native-web`
 * (the same mapping `expo export -p web` builds against), so this mounts in
 * the React Native unit renderer: real RN components, counted by the same
 * `CommitBoundary` profilers and the same count harness. No DOM imports here —
 * `View`/`Text`/`ScrollView` only — so the module also loads on device.
 */

import {
  createSlicePublisher,
  type UnifiedIssueRow,
  type UnifiedWorkRow,
} from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'
import { asIssueId } from '@podium/model'
import type { ReactElement } from 'react'
import { useMemo, useSyncExternalStore } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { CommitBoundary } from '../../../shared/src/row-shell'
import type { LegacyControlEngine } from './arm'
import type { ControlSliceDef } from './list'

function NativeRow({
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
  const mine = sessions.filter((session) => session.issueId === row.issue.id)
  const self = issues.find((issue) => issue.id === row.issue.id)
  return (
    <CommitBoundary id={row.issue.id}>
      <View testID={`row-${row.issue.id}`} accessibilityRole="button" onTouchEnd={onSelect}>
        <Text>
          {row.issue.displayRef ?? `#${row.issue.seq}`} {self?.title ?? row.issue.title} (
          {mine.length})
        </Text>
      </View>
    </CommitBoundary>
  )
}

function nativeKey(row: UnifiedWorkRow): string {
  return row.kind === 'issue' ? row.issue.id : row.worktree.path
}

export function LegacyControlNativeList({
  engine,
  sliceDef,
}: {
  engine: LegacyControlEngine
  sliceDef: ControlSliceDef
}): ReactElement {
  const publisher = useMemo(() => createSlicePublisher(() => engine.getSnapshot()), [engine])
  const slice = useSyncExternalStore(
    (listener) => engine.subscribe(listener),
    () => publisher.read(sliceDef),
  )
  const store = engine.getSnapshot()
  const issues = store.issueProjections
  const sessions = store.sessions as readonly SessionMeta[]
  const select = (id: string): void => {
    engine.getSnapshot().setSelectedIssueId(asIssueId(id))
  }
  const rows: UnifiedWorkRow[] = [
    ...slice.pinned,
    ...slice.groups.flatMap((group) => [...group.rows, ...group.snoozedRows, ...group.closedRows]),
  ]
  return (
    <ScrollView testID="control-list">
      {rows.map((row) =>
        row.kind !== 'issue' ? (
          <CommitBoundary key={nativeKey(row)} id={row.worktree.path}>
            <View testID={`worktree-${row.worktree.path}`}>
              <Text>{row.worktree.path}</Text>
            </View>
          </CommitBoundary>
        ) : (
          <NativeRow
            key={row.issue.id}
            row={row}
            issues={issues}
            sessions={sessions}
            onSelect={() => select(row.issue.id)}
          />
        ),
      )}
    </ScrollView>
  )
}
