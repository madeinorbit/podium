import { describe, expect, it } from 'vitest'
import { collectionFixture } from '../apps/web/harness/collection-fixture'
import { operatorCorpus } from '../apps/web/harness/measurement-corpus'
import { augmentAnswer } from '../apps/web/harness/staged-bootstrap.mjs'

describe('synthetic operator measurement input', () => {
  it('has exact populations, closed tree membership and no dangling edges', () => {
    const corpus = operatorCorpus(4443)
    expect(corpus.issues).toHaveLength(8_687)
    expect(corpus.sessions).toHaveLength(6_941)
    const ids = new Set(corpus.issues.map((issue) => issue.id))
    for (const issue of corpus.issues) expect(!issue.parentId || ids.has(issue.parentId)).toBe(true)
    for (const dep of corpus.issueDeps) expect(ids.has(dep.fromId) && ids.has(dep.toId)).toBe(true)
    const rows = corpus.issueProjections.map((value) => ({
      entity: 'issueProjection',
      entityId: value.id,
      value: value as unknown as Record<string, unknown>,
    }))
    const answer = collectionFixture(rows, corpus.fixedNow, 7)
    for (const tree of corpus.measurementTrees) {
      const fetched = answer({
        collection: 'issueProjection.tree',
        part: 'main',
        args: { root: tree.root },
      })
      expect(fetched.rows).toHaveLength(tree.size)
      expect(new Set(fetched.rows.map((row) => row.entityId))).toEqual(new Set(tree.ids))
      expect(fetched.rows.filter((row) => row.value['stage'] === 'done')).toHaveLength(tree.closed)
      expect(
        corpus.sessions.some((session) => session.issueId && tree.ids.includes(session.issueId)),
      ).toBe(false)
    }
  })

  it('answers one-record and body collections without fabricating an absent match', () => {
    const answer = collectionFixture(
      [{ entity: 'issueBrief', entityId: 'one', value: { id: 'one', text: 'brief' } }],
      0,
      7,
    )
    expect(
      answer({ collection: 'issueBrief.ofIssue', part: 'main', args: { issueId: 'one' } }).rows,
    ).toHaveLength(1)
    expect(
      answer({ collection: 'issueBrief.ofIssue', part: 'main', args: { issueId: 'absent' } }).rows,
    ).toEqual([])
  })

  it('fetches a cached issue parent and its personal row before certifying their markers', () => {
    const value = (id: string, parentId: string | null) => ({
      id,
      parentId,
      seq: 1,
      repoId: 'repo',
      stage: 'done',
      closedReason: 'completed',
      archived: false,
      deletedAt: null,
      isDraftVessel: false,
      audience: 'human',
      title: id,
      updatedAt: '2020-01-01T00:00:00Z',
    })
    const fixture = collectionFixture(
      [
        { entity: 'issueProjection', entityId: 'parent', value: value('parent', null) },
        { entity: 'issueProjection', entityId: 'child', value: value('child', 'parent') },
        {
          entity: 'issueUserState',
          entityId: 'parent-state',
          value: { userId: 'operator', entityId: 'parent' },
        },
      ],
      Date.parse('2026-11-18T00:00:00Z'),
      7,
    )
    const answer = fixture.close([
      { collection: 'issueProjection.one', part: 'main', args: { id: 'child' } },
    ])
    expect(answer.rows.map((row) => `${row.entity}:${row.entityId}`)).toEqual(
      expect.arrayContaining([
        'issueProjection:child',
        'issueProjection:parent',
        'issueUserState:parent-state',
      ]),
    )
    expect(
      answer.markers.some(
        (marker) => marker.collection === 'issueProjection.one' && marker.args?.['id'] === 'parent',
      ),
    ).toBe(true)
    expect(() => fixture.validate(answer)).not.toThrow()
    expect(() =>
      fixture.validate({ ...answer, rows: answer.rows.filter((row) => row.entityId !== 'parent') }),
    ).toThrow('issueProjection:parent')
  })
  it('delivers synthetic collections at their canonical completion boundaries', () => {
    const fixture = collectionFixture(
      [
        { entity: 'issueProjection', entityId: 'one', value: { id: 'one', parentId: null } },
        { entity: 'issueBrief', entityId: 'one', value: { id: 'one', text: 'brief' } },
      ],
      0,
      7,
    )
    const meta = { type: 'syncMeta', mode: 'snapshot', feedId: 'main', epoch: 'epoch', seq: 64 }
    const chunk = {
      type: 'feedBootstrap',
      feedId: 'main',
      epoch: 'epoch',
      fromSeq: 0,
      seq: 64,
      minAvailableSeq: 0,
      totalRows: 0,
      last: true,
      changes: [],
    }
    const marker = (collection: string) => ({
      type: 'collectionComplete',
      feedId: 'main',
      epoch: 'epoch',
      seq: 64,
      instances: [{ collection, part: 'main', args: { id: 'one', issueId: 'one' } }],
    })
    const answer = augmentAnswer(
      [
        meta,
        chunk,
        marker('issueProjection.one'),
        marker('issueBrief.ofIssue'),
        { type: 'syncComplete', feedId: 'main', epoch: 'epoch', seq: 64, rows: 0, records: 3 },
      ],
      fixture,
    )
    const records = answer.body
      .trim()
      .split('\n')
      .map((line: string) => JSON.parse(line))
    const issueAt = records.findIndex((record: { changes?: { entity: string }[] }) =>
      record.changes?.some((row) => row.entity === 'issueProjection'),
    )
    const issueMarkerAt = records.findIndex((record: { instances?: { collection: string }[] }) =>
      record.instances?.some((x) => x.collection === 'issueProjection.one'),
    )
    const briefAt = records.findIndex((record: { changes?: { entity: string }[] }) =>
      record.changes?.some((row) => row.entity === 'issueBrief'),
    )
    expect(issueAt).toBeLessThan(issueMarkerAt)
    expect(briefAt).toBeGreaterThan(issueMarkerAt)
    expect(records.at(-1).rows).toBe(2)
    expect(records.slice(1, -1).filter((record: { last?: boolean }) => record.last)).toHaveLength(1)
  })
})
