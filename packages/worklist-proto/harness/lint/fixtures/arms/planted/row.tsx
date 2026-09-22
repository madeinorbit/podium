import type { ReactElement } from 'react'
import type { RowProps } from '../../../../../shared/src/row-shell'
import { label } from './format'

export function Row({ row }: RowProps): ReactElement {
  return <div data-issue-row={row.id}>{label(row.displayRef, row.title)}</div>
}
