import { IssueGitStateProjection, IssueUserStateWire, RepoProjection } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { buildCorpus } from './__fixtures__/build'
import { GOLDEN } from './__fixtures__/golden'
import { FeedChange, FeedChangeLenient } from './messages/feed'
import { MetadataChange, MetadataChangeLenient, MetadataEntityKind } from './messages/sync'

/** Targeted evidence for the additive migration. Other pre-existing corpus
 * drift is tracked separately; the old IssueWire cases remain an exact pin. */
describe('additive issue companions on the wire', () => {
  it('pins each new shape and preserves every old IssueWire golden byte', () => {
    const model = buildCorpus().find(family => family.family === 'model')!
    const schemas = new Set(['IssueUserStateWire', 'IssueGitStateProjection', 'Repo', 'RepoIdentity', 'RepoProjection', 'IssueWire'])
    const golden = GOLDEN.model as typeof model
    const actual = model.cases.filter(c => schemas.has(c.schema))
    expect(new Set(actual.map(c => c.schema))).toEqual(schemas)
    expect(actual).toEqual(golden.cases.filter(c => schemas.has(c.schema)))
  })

  it('accepts the new kinds on v1 and v2 without changing the legacy kind', () => {
    const states = [
      ['issueUserState', IssueUserStateWire.parse({ userId: 'user:a', entityId: 'issue:a', readAt: 'read', tuckedAt: null, pinned: true })],
      ['issueGitState', IssueGitStateProjection.parse({ id: 'issue:a', updatedAt: 'probe', branch: 'feature', shared: false, ahead: 2, dirtyFiles: 0, merged: true })],
      ['repo', RepoProjection.parse({ id: 'repo:a', prefix: 'POD', repoPath: '/repo' })],
    ] as const
    for (const [entity, value] of states) {
      expect(MetadataEntityKind.options).toContain(entity)
      const legacy = { seq: 1, entity, id: 'row', op: 'upsert', value }
      const scoped = { seq: 1, entity, entityId: 'row', op: 'upsert', value }
      expect(MetadataChange.parse(legacy)).toEqual(legacy)
      expect(FeedChange.parse(scoped)).toEqual(scoped)
      expect(MetadataChangeLenient.parse({ ...legacy, entity: 'futureIssueCompanion' })).toMatchObject({ entity: 'futureIssueCompanion' })
      expect(FeedChangeLenient.parse({ ...scoped, entity: 'futureIssueCompanion' })).toMatchObject({ entity: 'futureIssueCompanion' })
    }
    expect(MetadataEntityKind.options).toContain('issue')
  })
})
