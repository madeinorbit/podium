import type { IssueProjection } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { createReplica, memoryStorage } from './replica'
import { issueViewModelsFromReplica } from './issue-view-models'

const projection = {
  id: 'iss_projection_only',
  seq: 1,
  title: 'Projection only',
  description: { value: '' },
  stage: 'in_progress',
  updatedAt: '2026-08-14T10:00:00.000Z',
  createdAt: '2026-08-14T10:00:00.000Z',
  archived: false,
  priority: 2,
  type: 'bug',
  intentOrigin: 'human',
  audience: 'human',
  isDraftVessel: false,
} as unknown as IssueProjection

describe('issue view model assembly', () => {
  it('does not publish a projection without its render supplements', () => {
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('issueProjections', [projection])
    replica.applySnapshot('issues', [])

    expect(issueViewModelsFromReplica(replica)).toEqual(new Map())
  })
})
