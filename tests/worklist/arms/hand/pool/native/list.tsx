/**
 * POD-4578 (Ha1), POD-4582 (Hb1), POD-4583 (Hb2) — the pool's native list
 * (React Native primitives): the same sections, lanes and subscription
 * discipline as the web list (`../react/list.tsx`), windowed by React
 * Native's own `SectionList` (a `VirtualizedList`: it draws an initial batch
 * and grows the window from layout and scroll). One section for the PINNED
 * rows, then one per group whose header toggles its closed fold. Loaded
 * lazily by `../arm.ts` so the node lanes never parse `react-native`.
 */

import { memo, type ReactElement, useCallback, useSyncExternalStore, useState } from 'react'
import { SectionList, Text, View } from 'react-native'
import { RowShell } from '../../../../shared/src/row-shell'
import type { HandPool } from '../pool'
import { PoolNativeRow } from './row'

/** Rows in the first batch: one screen and a half of 56 px rows on a phone. */
const INITIAL_ROWS = 24

/**
 * One visible id: its own view, `memo` on that view's identity; a cold row
 * draws a bare placeholder outside `RowShell` until its load lands.
 */
const PoolNativeSlot = memo(function PoolNativeSlot({
  pool,
  id,
}: {
  pool: HandPool
  id: string
}): ReactElement | null {
  const subscribe = useCallback((listener: () => void) => pool.subscribe(id, listener), [pool, id])
  const view = useSyncExternalStore(subscribe, () => pool.view(id))
  if (view === undefined) {
    return pool.resident('issue', id) === 'loading' ? <View testID={`loading-${id}`} /> : null
  }
  return <RowShell row={view} component={PoolNativeRow} />
})

/**
 * A group header: its own group's label and counts; toggles the closed fold.
 * `memo` on props plus its own lanes subscription, as the web header.
 */
const PoolNativeGroupHeader = memo(function PoolNativeGroupHeader({
  pool,
  groupKey,
  folded,
  onToggle,
}: {
  pool: HandPool
  groupKey: string
  folded: boolean
  onToggle: (key: string) => void
}): ReactElement {
  const subscribe = useCallback(
    (listener: () => void) => pool.subscribeGroup(groupKey, listener),
    [pool, groupKey],
  )
  const lanes = useSyncExternalStore(subscribe, () => pool.groupLanes(groupKey))
  return (
    <View testID={`group-${groupKey}`} accessibilityState={{ expanded: !folded }}>
      <Text onPress={() => onToggle(groupKey)}>
        {lanes.label} {lanes.rowIds.length}+{lanes.closedIds.length}
      </Text>
    </View>
  )
})

/** One section: the PINNED rows (no header key) or a group. */
interface Section {
  readonly key: string
  readonly group: string | null
  readonly data: readonly string[]
}

function PoolNativeList({ pool }: { pool: HandPool }): ReactElement {
  const view = useSyncExternalStore(pool.subscribeGroups, pool.groupsView)
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = useCallback((key: string) => {
    setFolded((previous) => {
      const next = new Set(previous)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  const sections: Section[] = []
  if (view.pinnedIds.length > 0) {
    sections.push({ key: 'pinned', group: null, data: view.pinnedIds })
  }
  for (const key of view.keys) {
    const lanes = pool.groupLanes(key)
    sections.push({
      key: `group:${key}`,
      group: key,
      data: folded.has(key) ? lanes.rowIds : [...lanes.rowIds, ...lanes.closedIds],
    })
  }

  return (
    <SectionList<string, Section>
      testID="hand-pool-list"
      sections={sections}
      keyExtractor={(id) => id}
      initialNumToRender={INITIAL_ROWS}
      stickySectionHeadersEnabled={false}
      renderItem={({ item }) => <PoolNativeSlot pool={pool} id={item} />}
      renderSectionHeader={({ section }) =>
        section.group === null ? (
          <Text testID="group-PINNED">Pinned</Text>
        ) : (
          <PoolNativeGroupHeader
            pool={pool}
            groupKey={section.group}
            folded={folded.has(section.group)}
            onToggle={toggle}
          />
        )
      }
    />
  )
}

export default PoolNativeList
