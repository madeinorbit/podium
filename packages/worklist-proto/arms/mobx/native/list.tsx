/**
 * POD-4447 — the MobX arm's native list (React Native primitives).
 *
 * Same observation discipline as the web list: rows read their own `row`
 * plus `isSelected`, the list reads the order only. No DOM imports here —
 * View/Text/ScrollView only — so this loads on device; the package lane maps
 * `react-native` to `react-native-web`.
 *
 * M1 renders the full row set in a ScrollView (the control lane does the
 * same, so counts compare directly). True windowed recycling (FlatList with
 * getItemLayout) is M3 hardening once device evidence needs it.
 */

import type { ReactElement } from 'react'
import { memo } from 'react'
import { observer } from 'mobx-react-lite'
import { ScrollView, Text, View } from 'react-native'
import { RowShell } from '../../../shared/src/row-shell'
import type { SliceRow } from '../../../shared/src/slice-types'
import type { IssueModel } from '../models/issue'
import type { MobXStore } from '../store'

const MobxNativeRowView = observer(function MobxNativeRowView({
  model,
  store,
}: {
  model: IssueModel
  store: MobXStore
}): ReactElement | null {
  const row = model.row as SliceRow | null
  const selected = model.isSelected
  if (row === null) return null
  return (
    <RowShell id={row.id}>
      <View
        testID={`row-${row.id}`}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onTouchEnd={() => store.setSelection(row.id)}
      >
        <Text>
          {row.displayRef} {row.title} [{row.phase}] {row.progressDone}/{row.progressTotal}
        </Text>
      </View>
    </RowShell>
  )
})

const MobxNativeRow = memo(function MobxNativeRow({
  model,
  store,
}: {
  model: IssueModel
  store: MobXStore
}): ReactElement {
  return <MobxNativeRowView model={model} store={store} />
})

export const MobxNativeList = observer(function MobxNativeList({
  store,
}: {
  store: MobXStore
}): ReactElement {
  const pinnedIds = store.worklist.groups.pinnedIds
  const groups = store.worklist.groups.groups
  const rows: string[] = [
    ...pinnedIds,
    ...groups.flatMap((group) => [...group.rowIds, ...group.closedIds]),
  ]
  return (
    <ScrollView testID="mobx-list">
      {rows.map((id) => {
        const model = store.issues.get(id)
        if (!model) return null
        return <MobxNativeRow key={id} model={model} store={store} />
      })}
    </ScrollView>
  )
})
