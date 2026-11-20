import { MobxPool } from '@podium/client-graph'
import { settingsHasFirstTask } from '@podium/client-graph/settings-views'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import { autorun } from 'mobx'
import { afterEach, expect, it } from 'vitest'

let pool: MobxPool | undefined
afterEach(() => pool?.dispose())

it('observes first-task membership across duplicate deltas, removal and replacement', () => {
  const fields = {
    seq: 1,
    repoPath: '/synthetic/project',
    audience: 'human' as const,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-02T00:00:00.000Z',
  }
  const archived = {
    ...fields,
    id: 'cold',
    title: 'Cold task',
    stage: 'done',
    archived: true,
  } as SliceIssue
  const draft = {
    ...fields,
    id: 'draft',
    title: 'Draft',
    stage: 'in_progress',
    isDraftVessel: true,
  } as SliceIssue
  pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() })
  pool.apply({
    type: 'replace',
    rows: [archived, draft].map((value) => ({ kind: 'issue', id: value.id, value })),
  })
  expect(settingsHasFirstTask(pool)).toBe(true)
  const answers: unknown[] = []
  const stop = autorun(() => answers.push(settingsHasFirstTask(pool!)))
  pool.apply({
    type: 'update',
    rows: [
      { kind: 'issue', id: draft.id, value: undefined },
      { kind: 'issue', id: draft.id, value: undefined },
    ],
  })
  expect(settingsHasFirstTask(pool)).toBe(true)
  pool.apply({
    type: 'update',
    rows: [
      {
        kind: 'issue',
        id: archived.id,
        value: { ...archived, deletedAt: '2020-01-03T00:00:00.000Z' },
      },
    ],
  })
  expect(settingsHasFirstTask(pool)).toBe(false)
  pool.apply({
    type: 'update',
    rows: [{ kind: 'issue', id: archived.id, value: { ...archived, deletedAt: null } }],
  })
  expect(settingsHasFirstTask(pool)).toBe(true)
  pool.apply({ type: 'replace', rows: [] })
  expect(settingsHasFirstTask(pool)).toBe(false)
  expect(answers).toEqual([true, false, true, false])
  stop()
})
