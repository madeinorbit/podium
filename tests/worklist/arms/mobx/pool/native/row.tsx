/**
 * POD-4565 (Ma1), POD-4756 — the pool's native row: its own issue, typed as
 * the `RowView` it implements, and nothing else (L1b), an `observer` reading
 * the issue's row fields directly, for the reasons in `../react/row.tsx`. It
 * reads the fields a row draws (`ROW_DISPLAYED_FIELDS`) and no other: its
 * text, and its looks in its accessibility state and label and its style (a
 * native view has no data attributes). The placement fields (group, order
 * keys, fold time) are never read here (POD-4825).
 */

import { observer } from 'mobx-react-lite'
import type { ReactElement } from 'react'
import { Text, View } from 'react-native'
import type { RowProps } from '../../../../shared/src/row-shell'

export const PoolNativeRow = observer(function PoolNativeRow({ row }: RowProps): ReactElement {
  const flags = [
    row.pinned ? 'pinned' : '',
    row.band === 2 ? 'snoozed' : row.band === 0 ? 'up' : '',
    row.closed ? (row.dismissed ? 'dismissed' : 'closed') : '',
    row.working ? `working since ${row.workingSince ?? '?'}` : '',
    row.asking ? 'asking' : '',
  ].filter((flag) => flag !== '')
  return (
    <View
      testID={`row-${row.id}`}
      accessibilityState={{ selected: row.selected, busy: row.loading === true }}
      accessibilityLabel={[
        `${row.displayRef} ${row.title}`,
        ...flags,
        `active ${row.activityAt}`,
        row.originTick === null ? '' : `from ${row.originTick.ref}`,
      ].join(', ')}
      style={{ opacity: row.closed || row.band === 2 ? 0.6 : 1 }}
    >
      <Text>
        {row.displayRef} {row.title} [{row.phase}] {row.progressDone}/{row.progressTotal}
      </Text>
    </View>
  )
})
