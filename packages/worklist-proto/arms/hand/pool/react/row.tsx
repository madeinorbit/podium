/**
 * POD-4578 (Ha1) — the pool's row component: it receives its own `RowView`
 * and nothing else (L1b capability rule, `RowShell`). Declared once at module
 * scope and `memo`: an unchanged view keeps its object, so the row does not
 * redraw.
 */

import { memo, type ReactElement } from 'react'
import type { RowProps } from '../../../../shared/src/row-shell'

export const PoolRow = memo(function PoolRow({ row }: RowProps): ReactElement {
  return (
    <div data-issue-row={row.id} data-selected={row.selected ? 'true' : 'false'}>
      {row.displayRef} {row.title} [{row.phase}
      {row.working ? '*' : ''}
      {row.asking ? '?' : ''}] {row.progressDone}/{row.progressTotal}
      {row.originTick !== null ? ` ⤷${row.originTick.ref}` : ''}
    </div>
  )
})
