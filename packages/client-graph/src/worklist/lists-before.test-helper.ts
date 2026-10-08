import { companion } from '@podium/mobx-helpers'
import { createIdentityQuery } from '../query-identity-before.test-helper'
import { sidebarBelowOf, sidebarNestedOf } from './sidebar'
import { nestBelowPartOf, nestedPartOf } from './visible'
import type { WorklistIssueBefore } from './issue-before.test-helper'

/** The worklist supplies policies; the data query owns ordered ID identity. */
export const worklistLists = companion((row: WorklistIssueBefore) => ({
  below: createIdentityQuery({ name: `worklist@${row.id}.below`,
    ids: () => nestBelowPartOf(row.worklist.host.visibleInputs, row.id) }),
  nested: createIdentityQuery({ name: `worklist@${row.id}.nested`,
    ids: () => nestedPartOf(row.worklist.host.visibleInputs, row.id, row) }),
  drawnBelow: createIdentityQuery({ name: `worklist@${row.id}.drawnBelow`,
    ids: () => sidebarBelowOf(row as never, row.worklist.pool) }),
  drawnNested: createIdentityQuery({ name: `worklist@${row.id}.drawnNested`,
    ids: () => sidebarNestedOf(row as never, row.worklist.pool) }),
}))
