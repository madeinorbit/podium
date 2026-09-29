/**
 * POD-4565 (Ma1), POD-4756 — the pool's row component. It receives its own
 * issue, typed as the `RowView` the issue implements, and nothing else (L1b
 * capability rule, `RowShell`), and it is an `observer`: it reads the issue's
 * row fields directly, each a cached value of the issue (`models.ts`), so it
 * redraws exactly when a field it reads changes, and no row view object is
 * built. It reads EVERY field of the row: the drawn ones as text, the
 * placement and stamps as data attributes (what a stylesheet keys the
 * pinned, snoozed and folded looks and the recency stamp on), so "the fields
 * it shows" is the whole `RowView`, the exact-commit fence's oracle.
 * Declared once at module scope.
 */

import { observer } from 'mobx-react-lite'
import type { ReactElement } from 'react'
import type { RowProps } from '../../../../shared/src/row-shell'

export const PoolRow = observer(function PoolRow({ row }: RowProps): ReactElement {
  return (
    <div
      data-issue-row={row.id}
      data-selected={row.selected ? 'true' : 'false'}
      data-band={row.band}
      data-pinned={row.pinned ? 'true' : 'false'}
      data-closed={row.closed ? 'true' : 'false'}
      data-dismissed={row.dismissed ? 'true' : 'false'}
      data-repo={row.repoKey}
      data-sort-key={row.sortKey ?? ''}
      data-created-at={row.createdAt}
      data-seq={row.seq}
      data-fold-at={row.foldAt}
      data-activity-at={row.activityAt}
      data-working-since={row.workingSince ?? ''}
      data-loading={row.loading === true ? 'true' : 'false'}
    >
      {row.displayRef} {row.title} [{row.phase}
      {row.working ? '*' : ''}
      {row.asking ? '?' : ''}] {row.progressDone}/{row.progressTotal}
      {row.originTick !== null ? ` ⤷${row.originTick.ref}` : ''}
    </div>
  )
})
