/**
 * POD-4565 (Ma1) — the pool's native row: its own `RowView` and nothing else
 * (L1b), `memo` and not `observer` for the reason in `../react/row.tsx`.
 */

import { memo, type ReactElement } from 'react'
import { Text, View } from 'react-native'
import type { RowProps } from '../../../../shared/src/row-shell'

export const PoolNativeRow = memo(function PoolNativeRow({ row }: RowProps): ReactElement {
  return (
    <View testID={`row-${row.id}`} accessibilityState={{ selected: row.selected }}>
      <Text>
        {row.displayRef} {row.title} [{row.phase}] {row.progressDone}/{row.progressTotal}
      </Text>
    </View>
  )
})
