import { describe, expect, it } from 'vitest'
import { isExcluded } from '@podium/model/browser'
import { isFinished } from '../shared/predicates'
import { awaitingMergeOf } from '../shared/schema'
import type { SliceIssue } from '../shared/slice-types'
import { MobxPool } from '../pool'
import { LOADING } from './rollup'

const stamp = '2026-10-08T12:00:00Z'
const fixtures = [
  ['open', { stage: 'planning', parentId: 'parent' }],
  ['closed', { stage: 'done', closedAt: stamp }],
  ['merge', { stage: 'done', branch: 'issue/merge', gitState: { ahead: 3, shared: false, merged: false } }],
  ['archived', { stage: 'done', archived: true }],
  ['deleted', { stage: 'done', deletedAt: stamp }],
  ['cold', { stage: 'done', closedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
  ['missing', undefined],
] as const
const fields = ['excluded', 'finished', 'awaitingMerge', 'updatedMs', 'finishedMs', 'parentRef'] as const

// The old private factRow lookup, frozen before removing its retained raw row.
function previousFacts(pool: MobxPool, id: string) {
  const resident = pool.row('issue', id, 'mark')
  if (resident !== LOADING) return resident as SliceIssue | undefined
  const summary = pool.row('issue', id, 'summary-fields')
  return summary === LOADING ? undefined : summary as SliceIssue | undefined
}
const ms = (value: string | null | undefined) => { const number = Date.parse(value ?? ''); return Number.isFinite(number) ? number : null }
function answers(row: SliceIssue | undefined) {
  return {
    excluded: row !== undefined && isExcluded(row),
    finished: row === undefined ? undefined : isFinished(row),
    awaitingMerge: row !== undefined && awaitingMergeOf(row),
    updatedMs: ms(row?.updatedAt),
    finishedMs: ms(row?.closedAt ?? row?.updatedAt) ?? 0,
    parentRef: row?.parentId || null,
  }
}

describe('shared worklist record facts keep their answers without a raw-row cache', () => {
  for (const [name, patch] of fixtures) for (const field of fields) it(`${name}.${field}`, () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined,
      name === 'cold' ? { load: () => undefined, schedule: () => () => {} } : {})
    if (patch) pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: name, value: {
      id: name, seq: 1, title: name, repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp, ...patch,
    } as never }] })
    try {
      const old = answers(previousFacts(pool, name))[field]
      const value = pool.issueObject(name)[field]
      expect(process.env.POD5822_MUTATE_FACTS === '1' ? '__wrong_answer__' : value).toEqual(old)
    } finally { pool.dispose() }
  })
})
