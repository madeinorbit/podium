import { companion } from '@podium/mobx-helpers'
import { createIdentityQuery } from '../query-result'
import { sidebarBelowOf, sidebarNestedOf } from './sidebar'
import { nestBelowPartOf, nestedPartOf } from './visible'
import type { WorklistIssue } from './issue'

/** The worklist supplies policies; the data query owns ordered ID identity. */
export const worklistLists = companion((row: WorklistIssue) => ({
  below: createIdentityQuery({ name: `worklist@${row.id}.below`,
    ids: () => nestBelowPartOf(row.worklist.host.visibleInputs, row.id) }),
  nested: createIdentityQuery({ name: `worklist@${row.id}.nested`,
    ids: () => nestedPartOf(row.worklist.host.visibleInputs, row.id, row) }),
  drawnBelow: createIdentityQuery({ name: `worklist@${row.id}.drawnBelow`,
    ids: () => sidebarBelowOf(row, row.worklist.pool) }),
  drawnNested: createIdentityQuery({ name: `worklist@${row.id}.drawnNested`,
    ids: () => sidebarNestedOf(row, row.worklist.pool) }),
}))
