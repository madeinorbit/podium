/**
 * POD-4448 — the TanStack arm's native list (React Native primitives).
 *
 * Same per-key subscriptions as the web list: rows read their own key plus
 * `selected:<id>`, headers their group key. No DOM imports here —
 * View/Text/ScrollView only — so this loads on device; the package lane maps
 * `react-native` to `react-native-web`.
 *
 * M1 renders the full row set in a ScrollView (the control lane does the
 * same, so counts compare directly). True windowed recycling is M3 work.
 */

import type { ReactElement } from 'react'
import { memo, useSyncExternalStore } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { RowShell } from '../../shared/src/row-shell'
import type { SliceRow } from '../../shared/src/slice-types'
import type { TanStackStore } from './store'

function useNativeKey<T>(store: TanStackStore, key: string): T {
  return useSyncExternalStore(
    (listener) => store.subscribe(key, listener),
    () => store.get(key) as T,
  )
}

const NativeRow = memo(function NativeRow({
  store,
  id,
}: {
  store: TanStackStore
  id: string
}): ReactElement | null {
  const row = useNativeKey<SliceRow | null>(store, id)
  const selected = useNativeKey<boolean>(store, `selected:${id}`)
  if (row === null) return null
  return (
    <RowShell id={id}>
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
    </RowShell>
  )
})

export function TanStackNativeList({ store }: { store: TanStackStore }): ReactElement {
  const order = useNativeKey<{
    pinnedIds: string[]
    groups: { key: string; label: string; rowIds: string[]; closedIds: string[] }[]
  }>(store, 'order')
  const rows: string[] = [
    ...order.pinnedIds,
    ...order.groups.flatMap((group) => [...group.rowIds, ...group.closedIds]),
  ]
  return (
    <ScrollView testID="tanstack-list">
      {rows.map((id) => (
        <NativeRow key={id} store={store} id={id} />
      ))}
    </ScrollView>
  )
}
