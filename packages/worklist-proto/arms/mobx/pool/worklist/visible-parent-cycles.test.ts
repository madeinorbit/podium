/** Parent cycles must rescue from actual work, as the legacy ancestor pass does. */
import type { SessionView } from '@podium/client-core/session-values'
import { type IssueNavigationModel, type UnifiedWorkRow, unifiedWorkList } from '@podium/client-core/viewmodels'
import { MobxPool } from '@podium/client-graph/pool'
import type { SliceIssue, SliceSession } from '@podium/client-graph/shared/slice-types'
import type { RowRecord } from '@podium/client-graph/shared/source'
import { directVisibility, type IssueVisibility, type VisibleInputs } from '@podium/client-graph/worklist/visible'
import { describe, expect, it, vi } from 'vitest'
import { tracked, visibleOrderOf } from '../../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from '../../../../harness/src/mobx-trap'

installMobxWarnTrap({ errors: true })
const NOW = Date.parse('2026-09-30T12:00:00.000Z')
const STAMP = new Date(NOW - 60_000).toISOString()

function issue(id: string, parentId: string | null, patch: Partial<SliceIssue> = {}): SliceIssue {
  return { id, parentId, title: id, seq: 1, createdAt: STAMP, updatedAt: STAMP,
    stage: 'backlog', audience: 'human', archived: false, repoPath: '/synthetic/repo',
    deps: [], ...patch }
}
function session(id: string): SliceSession {
  return { sessionId: `seat-${id}`, issueId: id, cwd: '/synthetic/repo',
    agentKind: 'codex', status: 'hibernated', archived: false,
    createdAt: STAMP, lastActiveAt: STAMP, agentState: { phase: 'idle', since: STAMP } }
}
function records(issues: SliceIssue[], sessions: SliceSession[] = []): RowRecord[] {
  return [...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })),
    ...sessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value }))]
}
function legacyVisible(issues: SliceIssue[], sessions: SliceSession[] = []): string[] {
  const rows = unifiedWorkList({ pinnedWorktrees: [], pinnedRepos: [], repos: [] },
    issues as unknown as IssueNavigationModel[], sessions as unknown as SessionView[], [], NOW)
  const ids: string[] = []
  const visit = (row: UnifiedWorkRow): void => {
    if (row.kind !== 'issue') return
    ids.push(row.issue.id)
    for (const child of row.startedByChildren ?? []) visit(child)
  }
  for (const row of rows) visit(row)
  return ids.sort()
}
function expectParity(pool: MobxPool, issues: SliceIssue[], sessions: SliceSession[] = []): void {
  const expected = legacyVisible(issues, sessions)
  expect(tracked(() => [...visibleOrderOf(pool)].sort())).toEqual(expected)
  // The same group functions also serve a memoized, non-MobX pass. Its
  // presence cannot depend on a live model's cycle-breaking cache state.
  const rebuilt = tracked(() => {
    const memo = new Map<string, IssueVisibility>()
    const input: VisibleInputs = { ...pool.visibleInputs,
      issue: id => directVisibility(input, id, memo) }
    return issues.filter(row => directVisibility(input, row.id, memo).visible).map(row => row.id).sort()
  })
  expect(rebuilt).toEqual(expected)
}

describe('parent-cycle presence (POD-5263)', () => {
  it.each([false, true])('keeps an empty reciprocal backlog cycle hidden (reversed=%s)', reversed => {
    const issues = [issue('cycle-a', 'cycle-b'), issue('cycle-b', 'cycle-a')]
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
    try {
      pool.apply({ type: 'replace', rows: records(reversed ? [...issues].reverse() : issues) })
      expectParity(pool, issues)
      expect(tracked(() => issues.map(row => {
        const parts = pool.knownIssue(row.id)
        return { flat: parts?.flat, keeps: parts?.keeps, present: parts?.present }
      }))).toEqual([
        { flat: false, keeps: false, present: false },
        { flat: false, keeps: false, present: false },
      ])
      expect(legacyVisible(issues)).toEqual([])
    } finally { pool.dispose() }
  })

  it('updates rescue when the cycle gains and loses its only session', () => {
    const issues = [issue('cycle-a', 'cycle-b'), issue('cycle-b', 'cycle-a')]
    const seat = session('cycle-a')
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
    try {
      pool.apply({ type: 'replace', rows: records(issues) })
      expectParity(pool, issues)
      pool.apply({ type: 'update', rows: records([], [seat]) })
      expectParity(pool, issues, [seat])
      expect(tracked(() => issues.map(row => pool.knownIssue(row.id)?.present))).toEqual([true, true])
      pool.apply({ type: 'update', rows: [{ kind: 'session', id: seat.sessionId, value: undefined }] })
      expectParity(pool, issues)
      pool.apply({ type: 'replace', rows: records([...issues].reverse()) })
      expectParity(pool, issues)
    } finally { pool.dispose() }
  })

  it('handles self-parenting and a longer cycle with a live incoming branch', () => {
    const self = issue('self', 'self')
    const issues = [self, issue('cycle-c', 'cycle-a'), issue('cycle-a', 'cycle-b'),
      issue('cycle-b', 'cycle-c'), issue('tail', 'cycle-a')]
    const seat = session('tail')
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
    try {
      pool.apply({ type: 'replace', rows: records(issues) })
      expectParity(pool, issues)
      pool.apply({ type: 'update', rows: records([], [seat]) })
      expectParity(pool, issues, [seat])
      expect(tracked(() => [...visibleOrderOf(pool)].sort())).toEqual(['cycle-a', 'cycle-b', 'cycle-c', 'tail'])
      pool.apply({ type: 'update', rows: records([{ ...self, stage: 'planning' }]) })
      expectParity(pool, [{ ...self, stage: 'planning' }, ...issues.slice(1)], [seat])
      pool.apply({ type: 'update', rows: records([self]) })
      expectParity(pool, issues, [seat])
    } finally { pool.dispose() }
  })

  it.each([
    { archived: true }, { deletedAt: STAMP }, { stage: 'proposed' }, { stage: 'shipping' },
  ])('stops rescue at an excluded cycle member (%j)', exclusion => {
    const issues = [issue('cycle-a', 'cycle-b'), issue('cycle-b', 'cycle-a', exclusion),
      issue('tail', 'cycle-b', { stage: 'planning' })]
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
    try {
      pool.apply({ type: 'replace', rows: records(issues) })
      expectParity(pool, issues)
      expect(tracked(() => pool.knownIssue('cycle-a')?.present)).toBe(false)
    } finally { pool.dispose() }
  })

  it('answers an expired cold cycle from summaries without reading or loading its rows', () => {
    const finished = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString()
    const issues = [issue('cycle-a', 'cycle-b'), issue('cycle-b', 'cycle-a')].map(row =>
      ({ ...row, stage: 'done', closedAt: finished, updatedAt: finished }))
    const values = new Map(issues.map(row => [row.id, row]))
    const load = vi.fn((_entity: string, id: string) => values.get(id))
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW }, undefined,
      { load, schedule: () => () => {} })
    try {
      pool.apply({ type: 'replace', rows: records(issues) })
      expect(tracked(() => [...pool.tables.issue.keys()])).toEqual([])
      const peek = vi.spyOn(pool.visibleInputs, 'issueRow')
      expect(tracked(() => issues.map(row => pool.knownIssue(row.id)?.keeps))).toEqual([false, false])
      expect(tracked(() => [...visibleOrderOf(pool)])).toEqual(legacyVisible(issues))
      expect(peek).not.toHaveBeenCalled()
      expect(pool.hydrate()).toBe(0)
      expect(load).not.toHaveBeenCalled()
    } finally { pool.dispose() }
  })
})
