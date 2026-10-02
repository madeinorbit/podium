import { IssueGitStateProjection, IssueUserStateWire, RepoProjection } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { buildCorpus } from './__fixtures__/build'
import { GOLDEN } from './__fixtures__/golden'
import { FeedChange, FeedChangeLenient } from './messages/feed'
import { MetadataChange, MetadataChangeLenient, MetadataEntityKind } from './messages/sync'

/** Each independently keyed companion remains part of the supported protocol. */
describe('normalized issue companions on the wire', () => {
  it('pins the companion shapes', () => {
    const model = buildCorpus().find((family) => family.family === 'model')!
    const schemas = new Set([
      'IssueUserStateWire',
      'IssueGitStateProjection',
      'Repo',
      'RepoIdentity',
      'RepoProjection',
    ])
    const golden = GOLDEN.model as typeof model
    const actual = model.cases.filter((c) => schemas.has(c.schema))
    expect(new Set(actual.map((c) => c.schema))).toEqual(schemas)
    expect(actual).toEqual(golden.cases.filter((c) => schemas.has(c.schema)))
  })

  it('accepts companions in snapshots and feed envelopes', () => {
    const states = [
      [
        'issueUserState',
        IssueUserStateWire.parse({
          userId: 'user:a',
          entityId: 'issue:a',
          readAt: 'read',
          tuckedAt: null,
          pinned: true,
        }),
      ],
      [
        'issueGitState',
        IssueGitStateProjection.parse({
          id: 'issue:a',
          updatedAt: 'probe',
          branch: 'feature',
          shared: false,
          ahead: 2,
          dirtyFiles: 0,
          merged: true,
        }),
      ],
      ['repo', RepoProjection.parse({ id: 'repo:a', prefix: 'POD', repoPath: '/repo' })],
    ] as const
    for (const [entity, value] of states) {
      expect(MetadataEntityKind.options).toContain(entity)
      const legacy = { seq: 1, entity, id: 'row', op: 'upsert', value }
      const scoped = { seq: 1, entity, entityId: 'row', op: 'upsert', value }
      expect(MetadataChange.parse(legacy)).toEqual(legacy)
      expect(FeedChange.parse(scoped)).toEqual(scoped)
      expect(
        MetadataChangeLenient.parse({ ...legacy, entity: 'futureIssueCompanion' }),
      ).toMatchObject({ entity: 'futureIssueCompanion' })
      expect(FeedChangeLenient.parse({ ...scoped, entity: 'futureIssueCompanion' })).toMatchObject({
        entity: 'futureIssueCompanion',
      })
    }
    expect(MetadataEntityKind.options).not.toContain('issue')
  })
})
