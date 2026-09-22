/**
 * POD-4565 (Ma1) — the pool's row component: it receives its own `RowView`
 * and nothing else (L1b capability rule, `RowShell`). Declared once at module
 * scope; `observer` so the MobX lint's `missing-observer` holds, although a
 * view is plain data and the row reads no observable.
 */

import { observer } from 'mobx-react-lite'
import type { ReactElement } from 'react'
import type { RowProps } from '../../../../shared/src/row-shell'

export const PoolRow = observer(function PoolRow({ row }: RowProps): ReactElement {
  return (
    <div data-issue-row={row.id} data-selected={row.selected ? 'true' : 'false'}>
      {row.displayRef} {row.title} [{row.phase}
      {row.working ? '*' : ''}
      {row.asking ? '?' : ''}] {row.progressDone}/{row.progressTotal}
      {row.originTick !== null ? ` ⤷${row.originTick.ref}` : ''}
    </div>
  )
})
