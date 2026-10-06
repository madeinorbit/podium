import { settingsHasFirstTask } from '@podium/client-graph/settings-views'
import { afterEach, expect, it, vi } from 'vitest'
import { MobxPool } from '@podium/client-graph'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'

let pool: MobxPool | undefined
afterEach(() => pool?.dispose())

it('keeps the first-task count current across duplicate deltas, hydration, removal and replacement', () => {
  const fields = { seq: 1, repoPath: '/synthetic/project', audience: 'human' as const,
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z' }
  const archived = { ...fields, id: 'cold', title: 'Cold task', stage: 'done', archived: true } as SliceIssue
  const draft = { ...fields, id: 'draft', title: 'Draft', stage: 'in_progress', isDraftVessel: true } as SliceIssue
  const load = vi.fn(() => archived)
  pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() }, undefined, { load, schedule: () => () => {} })
  pool.apply({ type: 'replace', rows: [archived, draft].map(value => ({ kind: 'issue', id: value.id, value })) })
  expect(settingsHasFirstTask(pool)).toBe(true)
  pool.row('issue', archived.id)
  expect(pool.hydrate()).toBe(1)
  pool.apply({ type: 'update', rows: [
    { kind: 'issue', id: draft.id, value: undefined },
    { kind: 'issue', id: draft.id, value: undefined },
  ] })
  expect(settingsHasFirstTask(pool)).toBe(true)
  pool.apply({ type: 'update', rows: [{ kind: 'issue', id: archived.id, value: { ...archived, deletedAt: '2020-01-03T00:00:00.000Z' } }] })
  expect(settingsHasFirstTask(pool)).toBe(false)
  pool.apply({ type: 'update', rows: [{ kind: 'issue', id: archived.id, value: { ...archived, deletedAt: null } }] })
  expect(settingsHasFirstTask(pool)).toBe(true)
  pool.apply({ type: 'replace', rows: [] })
  expect(settingsHasFirstTask(pool)).toBe(false)
  expect(load).toHaveBeenCalledTimes(1)
})
