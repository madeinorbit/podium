/** POD-5179: reproduce the cycle at MobxPool.apply(replace), including errors
 * swallowed by filing reactions. Legacy's id-ordered pass rejects the last
 * edge of a cycle, keeping its greatest id as the root. */
import { MobxPool } from '@podium/client-graph/pool'
import type { SliceIssue, SliceSession } from '@podium/client-graph/shared/slice-types'
import type { RowRecord } from '@podium/client-graph/shared/source'
import { tracked, visibleOrderOf } from '../../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from '../../../../harness/src/mobx-trap'
import { describe, expect, it } from 'vitest'

installMobxWarnTrap({ errors: true })
const NOW = Date.parse('2026-09-30T12:00:00.000Z')
const STAMP = new Date(NOW - 60_000).toISOString()

function issue(id: string, parent: string | null): SliceIssue {
  return { id, title: id, seq: 1, createdAt: STAMP, updatedAt: STAMP,
    stage: 'in_progress', audience: 'human', repoPath: '/synthetic/repo',
    parentId: null, startedBySession: parent === null ? null : `seat-${parent}` }
}
function session(id: string): SliceSession {
  return { sessionId: `seat-${id}`, issueId: id, cwd: '/synthetic/repo',
    agentKind: 'codex', status: 'hibernated', archived: false,
    createdAt: STAMP, lastActiveAt: STAMP, agentState: { phase: 'idle', since: STAMP } }
}
function rows(issues: SliceIssue[]): RowRecord[] {
  return issues.flatMap(value => [
    { kind: 'issue' as const, id: value.id, value },
    { kind: 'session' as const, id: `seat-${value.id}`, value: session(value.id) },
  ])
}
function parents(pool: MobxPool, ids: string[]) {
  return tracked(() => Object.fromEntries(ids.map(id => [id, pool.knownIssue(id)?.nestParent])))
}

describe('provenance nesting cycles (POD-5179)', () => {
  it.each([false, true])('keeps both rows after replace and breaks the same edge (reversed=%s)', reversed => {
    const issues = [issue('cycle-a', 'cycle-b'), issue('cycle-b', 'cycle-a')]
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
    try {
      expect(() => pool.apply({ type: 'replace', rows: rows(reversed ? [...issues].reverse() : issues) })).not.toThrow()
      expect(parents(pool, ['cycle-b', 'cycle-a'])).toEqual({ 'cycle-a': 'cycle-b', 'cycle-b': null })
      expect(tracked(() => [...visibleOrderOf(pool)].sort())).toEqual(['cycle-a', 'cycle-b'])
      expect(tracked(() => pool.issue('cycle-b')?.nested)).toEqual(['cycle-a'])
    } finally { pool.dispose() }
  })

  it('breaks a longer cycle without dropping an incoming branch', () => {
    const issues = [issue('cycle-c', 'cycle-a'), issue('cycle-a', 'cycle-b'),
      issue('cycle-b', 'cycle-c'), issue('tail-z', 'cycle-a')]
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
    try {
      pool.apply({ type: 'replace', rows: rows(issues) })
      expect(parents(pool, issues.map(row => row.id))).toEqual({
        'cycle-a': 'cycle-b', 'cycle-b': 'cycle-c', 'cycle-c': null, 'tail-z': 'cycle-a',
      })
      expect(tracked(() => [...visibleOrderOf(pool)].sort())).toEqual(issues.map(row => row.id).sort())
    } finally { pool.dispose() }
  })

  it('handles a cycle formed by formal ancestry and provenance', () => {
    const a = { ...issue('cycle-a', null), parentId: 'cycle-b' }
    const b = issue('cycle-b', 'cycle-a')
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
    try {
      pool.apply({ type: 'replace', rows: rows([b, a]) })
      expect(parents(pool, [a.id, b.id])).toEqual({ 'cycle-a': 'cycle-b', 'cycle-b': null })
      expect(tracked(() => [...visibleOrderOf(pool)].sort())).toEqual([a.id, b.id])
    } finally { pool.dispose() }
  })

  it('recomputes the break when a session changes owner and after replacement', () => {
    const a = issue('cycle-a', 'cycle-b')
    const b = issue('cycle-b', 'cycle-a')
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
    try {
      pool.apply({ type: 'replace', rows: rows([a, b]) })
      pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'seat-cycle-a',
        value: { ...session(a.id), issueId: b.id } }] })
      expect(parents(pool, [a.id, b.id])).toEqual({ 'cycle-a': 'cycle-b', 'cycle-b': null })
      pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'seat-cycle-b',
        value: { ...session(b.id), issueId: a.id } }] })
      expect(parents(pool, [a.id, b.id])).toEqual({ 'cycle-a': null, 'cycle-b': null })
      pool.apply({ type: 'replace', rows: rows([b, a]) })
      expect(parents(pool, [b.id, a.id])).toEqual({ 'cycle-a': 'cycle-b', 'cycle-b': null })
    } finally { pool.dispose() }
  })
})
