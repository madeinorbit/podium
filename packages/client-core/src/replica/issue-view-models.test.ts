import {
  asIssueId,
  asUserId,
  type IssueGitStateProjection,
  type IssueProjection,
  type IssueUserStateWire,
  issueUserStateRowId,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import { issueAwaitingMerge, issuePendingDecision } from '../viewmodels/slices/issues'
import { allIssueViewModels } from './issue-view-cache'
import { issueViewModelsFromReplica } from './issue-view-models'
import { createReplica, memoryStorage } from './replica'

const projection = {
  id: asIssueId('iss_projection_only'),
  seq: 1,
  repoId: 'repo',
  title: 'Projection only',
  description: { value: 'Materialized description' },
  stage: 'review',
  updatedAt: '2026-08-14T10:00:00.000Z',
  createdAt: '2026-08-14T10:00:00.000Z',
  archived: false,
  priority: 2,
  type: 'bug',
  intentOrigin: 'agent',
  audience: 'human',
  isDraftVessel: true,
  needsHuman: true,
  branch: 'issue/1',
  asked: {
    question: 'Ship this?',
    options: ['Ship', 'Hold'],
    at: '2026-08-14T11:00:00Z',
    by: 's-asker',
  },
} as unknown as IssueProjection
const markers: IssueUserStateWire = {
  userId: asUserId('u-test'),
  entityId: projection.id,
  readAt: '2026-08-14T12:00:00Z',
  tuckedAt: '2026-08-14T13:00:00Z',
  pinned: true,
}
const git = {
  id: projection.id,
  branch: 'issue/1',
  shared: false,
  ahead: 3,
  merged: false,
  dirtyFiles: 0,
  updatedAt: '2026-08-14T14:00:00Z',
} as IssueGitStateProjection
function world() {
  const replica = createReplica({ storage: memoryStorage() })
  replica.applySnapshot('issueProjections', [projection])
  replica.applySnapshot('issueUserStates', [markers])
  replica.applySnapshot('issueGitStates', [git])
  replica.applySnapshot('repos', [
    { id: 'repo', repoPath: '/normalized-repo', prefix: 'POD' } as never,
  ])
  return replica
}

describe('normalized issue render models', () => {
  it('keeps a partial offline cache renderable until normalized facts arrive', () => {
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('issueProjections', [projection])
    const partial = allIssueViewModels(replica)[0]!
    expect(partial).toMatchObject({ title: projection.title, asked: projection.asked })
    expect(partial.gitState).toBeUndefined()
    expect(issueAwaitingMerge({ ...partial, stage: 'done' })).toBe(false)
    expect(partial.repoPath).toBe('')
    replica.batch(() => {
      replica.applySnapshot('issueUserStates', [markers])
      replica.applySnapshot('issueGitStates', [git])
      replica.applySnapshot('repos', [
        { id: 'repo', repoPath: '/normalized-repo', prefix: 'POD' } as never,
      ])
    })
    expect(allIssueViewModels(replica)[0]).toMatchObject({
      readAt: markers.readAt,
      tuckedAt: markers.tuckedAt,
      pinned: true,
      gitState: { ahead: 3 },
      repoPath: '/normalized-repo',
    })
  })

  it('joins each issue field from its normalized kind', () => {
    const replica = world()
    const model = issueViewModelsFromReplica(replica).get(projection.id)!
    expect(model).toMatchObject({
      title: projection.title,
      description: projection.description.value,
      displayRef: 'POD-1',
      repoPath: '/normalized-repo',
      readAt: markers.readAt,
      tuckedAt: markers.tuckedAt,
      pinned: true,
      gitState: { ahead: 3, merged: false },
      asked: projection.asked,
      intentOrigin: 'agent',
      isDraftVessel: true,
      unread: false,
    })
    expect(issuePendingDecision(model)).toBe('merge')
    expect(issueAwaitingMerge({ ...model, stage: 'done' })).toBe(true)
  })
  it.each([
    'question',
    'options',
    'at',
    'by',
  ] as const)('keeps asked.%s on its normalized spelling', (field) => {
    const model = issueViewModelsFromReplica(world()).get(projection.id)!
    expect(model.asked?.[field]).toEqual(projection.asked?.[field])
    expect(Object.keys(model).filter((key) => key.startsWith('humanQuestion'))).toEqual([])
  })
  it.each([
    'intentOrigin',
    'isDraftVessel',
  ] as const)('keeps %s on its normalized spelling', (field) => {
    const model = issueViewModelsFromReplica(world()).get(projection.id)!
    expect(model[field]).toBe(projection[field])
    expect(model).not.toHaveProperty(field === 'intentOrigin' ? 'origin' : 'draft')
  })
  it('uses safe defaults when marker/git/repo rows are absent and never revives them', () => {
    const replica = world()
    allIssueViewModels(replica)
    replica.applyChanges(
      'issueUserStates',
      [],
      [issueUserStateRowId(markers.userId, projection.id)],
    )
    replica.applySnapshot('issueGitStates', [])
    replica.applySnapshot('repos', [])
    expect(allIssueViewModels(replica)[0]).toMatchObject({
      readAt: null,
      tuckedAt: null,
      pinned: false,
      repoPath: '',
      gitState: undefined,
      unread: true,
    })
    replica.applySnapshot('issueUserStates', [markers])
    expect(allIssueViewModels(replica)[0]?.pinned).toBe(true)
    replica.applySnapshot('issueProjections', [])
    expect(allIssueViewModels(replica)).toEqual([])
  })
  it('updates pending merge from the git kind and clears the ask from the projection', () => {
    const replica = world()
    const first = allIssueViewModels(replica)[0]!
    replica.applySnapshot('issueGitStates', [{ ...git, merged: true }])
    const landed = allIssueViewModels(replica)[0]!
    expect(landed).not.toBe(first)
    expect(issuePendingDecision(landed)).toBe('review')
    replica.applySnapshot('issueProjections', [
      { ...projection, asked: undefined, needsHuman: false },
    ])
    expect(allIssueViewModels(replica)[0]?.asked).toBeUndefined()
  })
  it('keeps outgoing edge changes visible even when its derived view is stable', () => {
    const replica = world()
    allIssueViewModels(replica)
    replica.applySnapshot('issueDeps', [
      { id: 'dep', fromId: projection.id, toId: 'origin', type: 'discovered-from' } as never,
    ])
    expect(allIssueViewModels(replica)[0]?.deps).toEqual([
      { id: 'origin', type: 'discovered-from' },
    ])
  })
})
