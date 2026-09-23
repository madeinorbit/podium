/**
 * POD-4578 (Ha1) — the pool's native row: its own `RowView` and nothing else
 * (L1b), `memo` for the reason in `../react/row.tsx`.
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
