import type { ReactElement } from 'react'
import { RowShell } from '../../../../../shared/src/row-shell'
import type { RowView } from '@podium/client-graph/shared/row-view'
import { Row } from './row'
import type { Pool } from './store'

/** The list gets the pool through props; `import type` carries no value. */
export function List({ pool, views }: { pool: Pool; views: RowView[] }): ReactElement {
  return (
    <div data-rows={pool.issues.size}>
      {views.map((view) => (
        <RowShell key={view.id} row={view} component={Row} />
      ))}
    </div>
  )
}
