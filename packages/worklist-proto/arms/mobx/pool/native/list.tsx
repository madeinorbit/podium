/**
 * POD-4565 (Ma1), POD-4569 (Mb1), POD-4570 (Mb2) — the pool's native list
 * (React Native primitives): the same sections, lanes and observation
 * discipline as the web list (`../react/list.tsx`), windowed by React
 * Native's own `SectionList` (a `VirtualizedList`: it draws an initial batch
 * and grows the window from layout and scroll). One section for the PINNED
 * rows, then per group its open lane under a header that toggles the closed
 * fold, and the closed fold as a section of its own. Loaded
 * lazily by `../arm.ts` so the node lanes never parse `react-native`.
 */

import { observer } from 'mobx-react-lite'
import { type ReactElement, useCallback, useState } from 'react'
import { SectionList, Text, View } from 'react-native'
import { RowShell } from '../../../../shared/src/row-shell'
import type { IssueModel } from '../models'
import type { MobxPool } from '../pool'
import type { WorklistGroups } from '../worklist/groups'
import { PoolNativeRow } from './row'

/** Rows in the first batch: one screen and a half of 56 px rows on a phone. */
const INITIAL_ROWS = 24

/**
 * A drawn row's shell: observes only whether its issue is in memory, and
 * hands the issue ITSELF to the row (it implements `RowView`). The row is the
 * observer of its fields, so a field change redraws the row and never this.
 */
const PoolNativeRowView = observer(function PoolNativeRowView({
  model,
}: {
  model: IssueModel
}): ReactElement | null {
  if (!model.inMemory) return null
  return <RowShell row={model} component={PoolNativeRow} />
})

/** One visible id: resolves its model once, else a loading placeholder (see the web list). */
const PoolNativeSlot = observer(function PoolNativeSlot({
  pool,
  id,
}: {
  pool: MobxPool
  id: string
}): ReactElement | null {
  const model = pool.issue(id)
  if (model === undefined) {
    return pool.resident('issue', id) === 'loading' ? <View testID={`loading-${id}`} /> : null
  }
  return <PoolNativeRowView model={model} />
})

/** A group header: its own group's label and counts; toggles the closed fold. */
const PoolNativeGroupHeader = observer(function PoolNativeGroupHeader({
  groups,
  groupKey,
  folded,
  onToggle,
}: {
  groups: WorklistGroups
  groupKey: string
  folded: boolean
  onToggle: (key: string) => void
}): ReactElement {
  const group = groups.group(groupKey)
  return (
    <View testID={`group-${groupKey}`} accessibilityState={{ expanded: !folded }}>
      <Text onPress={() => onToggle(groupKey)}>
        {group.label} {group.rowIds.length}+{group.closedIds.length}
      </Text>
    </View>
  )
})

/**
 * One section: the PINNED rows (no group), a group's open lane (with its
 * header) or its closed fold (no header). Each section's data IS its lane's
 * id list, so building the sections walks the groups, never their rows
 * (POD-4792).
 */
interface Section {
  readonly key: string
  readonly group: string | null
  readonly header: boolean
  readonly data: readonly string[]
}

const PoolNativeList = observer(function PoolNativeList({
  pool,
}: {
  pool: MobxPool
}): ReactElement {
  const groups = pool.groups
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = useCallback((key: string) => {
    setFolded((previous) => {
      const next = new Set(previous)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  const sections: Section[] = []
  if (groups.pinnedIds.length > 0) {
    sections.push({ key: 'pinned', group: null, header: true, data: groups.pinnedIds })
  }
  for (const key of groups.keys) {
    const group = groups.group(key)
    sections.push({ key: `group:${key}`, group: key, header: true, data: group.rowIds })
    if (!folded.has(key)) {
      sections.push({ key: `closed:${key}`, group: key, header: false, data: group.closedIds })
    }
  }

  return (
    <SectionList<string, Section>
      testID="mobx-pool-list"
      sections={sections}
      keyExtractor={(id) => id}
      initialNumToRender={INITIAL_ROWS}
      stickySectionHeadersEnabled={false}
      renderItem={({ item }) => <PoolNativeSlot pool={pool} id={item} />}
      renderSectionHeader={({ section }) =>
        !section.header ? null : section.group === null ? (
          <Text testID="group-PINNED">Pinned</Text>
        ) : (
          <PoolNativeGroupHeader
            groups={groups}
            groupKey={section.group}
            folded={folded.has(section.group)}
            onToggle={toggle}
          />
        )
      }
    />
  )
})

export default PoolNativeList
