/**
 * POD-4565 (Ma1), POD-4756 — the pool's row component. It receives its own
 * issue, typed as the `RowView` the issue implements, and nothing else (L1b
 * capability rule, `RowShell`), and it is an `observer`: it reads the issue's
 * row fields directly, each a cached value of the issue (`models.ts`), so it
 * redraws exactly when a field it reads changes, and no row view object is
 * built. It reads the fields a row DRAWS (`ROW_DISPLAYED_FIELDS`,
 * `shared/src/row-view.ts`): its text, and its looks as data
 * attributes (what a stylesheet keys the selected, pinned, snoozed and
 * folded looks and the recency and working stamps on).
 * POD-4953 also reads the complete sidebar payload in this same observer,
 * so the work-per-change meter includes every fact the real row will use.
 * The facts do not change the demo's presentation. The fields that only
 * place the row (its group, order keys and fold time) move it in the list and
 * are never read here (POD-4825). Declared once at module scope.
 */

import { observer } from 'mobx-react-lite'
import type { ReactElement } from 'react'
import { hostOf, IssueModel } from '@podium/client-graph/models'
import type { MobxPool } from '@podium/client-graph/pool'
import { sidebarIssueRow } from '@podium/client-graph/worklist/sidebar'
import type { RowProps } from '../../../../shared/src/row-shell'

export const PoolRow = observer(function PoolRow({ row }: RowProps): ReactElement {
  // Screen payloads live in their module, rather than on the model. Observe
  // this row's addressed payload in the same reaction as its displayed fields.
  if (row instanceof IssueModel) void sidebarIssueRow(row, hostOf(row) as MobxPool)
  return (
    <div
      data-issue-row={row.id}
      data-selected={row.selected ? 'true' : 'false'}
      data-band={row.band}
      data-pinned={row.pinned ? 'true' : 'false'}
      data-closed={row.closed ? 'true' : 'false'}
      data-dismissed={row.dismissed ? 'true' : 'false'}
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
