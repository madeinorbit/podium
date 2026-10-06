/**
 * POD-4446 — the hand-rolled arm's native list (React Native primitives).
 *
 * Same per-key subscriptions as the web list: rows read their own key plus
 * `selected:<id>`, headers their group key. No DOM imports here —
 * View/Text/ScrollView only — so this loads on device; the package lane maps
 * `react-native` to `react-native-web`.
 *
 * M1 renders the full row set in a ScrollView (the control lane does the
 * same, so counts compare directly). True windowed recycling (FlatList with
 * getItemLayout) is named M3 hardening in NOTES.md once device evidence
 * needs it — the web list already windows.
 */

import type { ReactElement } from 'react'
import { memo, useSyncExternalStore } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { CommitBoundary } from '../../shared/src/row-shell'
import type { SliceRow } from '@podium/client-graph/shared/slice-types'
import type { HandStore } from './store'

function useNativeKey<T>(store: HandStore, key: string): T {
  return useSyncExternalStore(
    (listener) => store.subscribe(key, listener),
    () => store.get(key) as T,
  )
}

const NativeRow = memo(function NativeRow({
  store,
  id,
}: {
  store: HandStore
  id: string
}): ReactElement | null {
  const row = useNativeKey<SliceRow | null>(store, id)
  const selected = useNativeKey<boolean>(store, `selected:${id}`)
  if (row === null) return null
  return (
    <CommitBoundary id={id}>
      <View
        testID={`row-${id}`}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onTouchEnd={() => store.setSelection(id)}
      >
        <Text>
          {row.displayRef} {row.title} [{row.phase}] {row.progressDone}/{row.progressTotal}
        </Text>
      </View>
    </CommitBoundary>
  )
})

export function HandNativeList({ store }: { store: HandStore }): ReactElement {
  const order = useNativeKey<{
    pinnedIds: string[]
    groups: { key: string; label: string; rowIds: string[]; closedIds: string[] }[]
  }>(store, 'order')
  const rows: string[] = [
    ...order.pinnedIds,
    ...order.groups.flatMap((group) => [...group.rowIds, ...group.closedIds]),
  ]
  return (
    <ScrollView testID="hand-list">
      {rows.map((id) => (
        <NativeRow key={id} store={store} id={id} />
      ))}
    </ScrollView>
  )
}
