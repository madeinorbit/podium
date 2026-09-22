/**
 * POD-4565 (Ma1) — the pool's row component: it receives its own `RowView`
 * and nothing else (L1b capability rule, `RowShell`). Declared once at module
 * scope, and `memo`, not `observer`: a view is plain data, so the row reads no
 * observable (an `observer` here trips `reactionRequiresObservable`); its
 * slot (`list.tsx`) is the observer.
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
