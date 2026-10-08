// @vitest-environment happy-dom
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MobxPool } from './pool'
import { createColdIndex } from './shared/cold-index'
import { createReaderIndex, questionEntity, type ReaderQuestion } from './shared/reader-questions'
import { SCHEMA } from './shared/schema'
import type { RowRecord, RowSourceEvent } from './shared/source'

it.each([1, 4])('matches the old observed query walk and records heartbeat bookkeeping at %sx', scale => {
  const rows = new Map<string, RowRecord>()
  const issue = (id: string, patch: object = {}): RowRecord => ({ kind: 'issue', id, value: {
    id, title: id, seq: 1, repoId: 'repo', repoPath: '/repo', priority: 2, stage: 'in_progress',
    audience: 'human', deps: [], createdAt: '2026-10-01', updatedAt: '2026-10-01', ...patch,
  } } as RowRecord)
  const session = (id: string, patch: object = {}): RowRecord => ({ kind: 'session', id, value: {
    sessionId: id, cwd: '/repo', issueId: 'one', agentKind: 'codex', status: 'live',
    archived: false, lastActiveAt: '2026-10-01', createdAt: '2026-10-01', machineId: 'machine', ...patch,
  } } as RowRecord)
  for (const row of [issue('one'), issue('two'), session('active'), session('other'),
    { kind: 'repo', id: 'repo', value: { id: 'repo', prefix: 'POD', repoPath: '/repo' } } as RowRecord])
    rows.set(`${row.kind}:${row.id}`, row)
  const source = createColdIndex(SCHEMA)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-08') }, undefined, {
    cold: () => source, load: () => undefined, schedule: () => () => {},
  })
  const questions: ReaderQuestion[] = [
    { kind: 'commandSessions' }, { kind: 'inboxSessions' }, { kind: 'headerOccupancy' },
    { kind: 'sessionReference', ref: 'POD-S1' }, { kind: 'commandIssues' },
    { kind: 'boardIssues', priority: 2 }, { kind: 'boardIssues', projectPaths: ['/repo'] },
    { kind: 'containingIssues', cwd: '/repo/nested' }, { kind: 'proposedIssues' },
  ]
  for (let i = 0; i < 32 * scale; i++) questions.push({
    kind: 'commandIssueSessions', issueId: i ? `unrelated-${i}` : 'one', archived: false,
  })
  const seen = questions.map(() => [] as string[])
  const expected = questions.map(() => [] as string[])
  const stops: (() => void)[] = []
  let recent: string[] = [], count = 0, setup = 0, machine: unknown
  const apply = (event: RowSourceEvent) => {
    for (const row of event.rows) {
      if (row.value === undefined) rows.delete(`${row.kind}:${row.id}`)
      else rows.set(`${row.kind}:${row.id}`, row)
    }
    // Retain the old Q-wide membership walk as an independent answer oracle.
    const rebuilt = createReaderIndex()
    rebuilt.apply({ type: 'replace', rows: [...rows.values()] })
    for (const [at, question] of questions.entries()) {
      if (event.type === 'replace') expected[at] = rebuilt.ids(question)
      else for (const row of event.rows) {
        if (row.kind !== questionEntity(question)) continue
        const before = expected[at]!.includes(row.id), after = rebuilt.contains(question, row.id)
        if (before && !after) expected[at] = expected[at]!.filter(id => id !== row.id)
        if (!before && after) expected[at]!.push(row.id)
      }
      if (questionEntity(question) === 'session') expected[at]!.sort()
    }
    source.apply(event); pool.apply(event)
    if (stops.length) {
      expect(seen).toEqual(expected)
      expect(recent).toEqual(rebuilt.ids({ kind: 'headerRecentSession' }))
      expect(count).toBe(rebuilt.ids({ kind: 'commandSessions' }).length)
      expect(setup).toBe(count)
      const machines = [...rows.values()].filter(row => row.kind === 'session' &&
        (row.value as Record<string, unknown>).machineId === 'machine')
      expect(machine).toEqual(machines.length ? { machineId: 'machine', createdAt: '2026-10-01' } : undefined)
    }
  }
  try {
    apply({ type: 'replace', rows: [...rows.values()] })
    questions.forEach((question, at) => stops.push(autorun(() => { seen[at] = pool.queries.ids(question) })))
    stops.push(autorun(() => { recent = pool.queries.ids({ kind: 'headerRecentSession' }) }))
    stops.push(autorun(() => { count = pool.queries.count('session'); setup = pool.queries.setupSessionCount(); machine = pool.queries.latestMachineSession(['machine']) }))
    const revisions = vi.spyOn(source, 'readerRevision'), membership = vi.spyOn(source, 'readerContains')
    const checks = pool.queries.counts.revisionChecks
    const probes = pool.queries.counts.membershipChecks
    apply({ type: 'update', rows: [session('active', { lastActiveAt: '2026-10-09' })] })
    console.info('[query heartbeat]', JSON.stringify({ scale, revisionChecks: revisions.mock.calls.length,
      membershipChecks: membership.mock.calls.length,
      allRevisionChecks: pool.queries.counts.revisionChecks - checks,
      allMembershipChecks: pool.queries.counts.membershipChecks - probes }))
    expect(revisions.mock.calls.length).toBe(0)
    expect(membership.mock.calls.length).toBe(0)
    expect(pool.queries.counts.revisionChecks - checks).toBe(1)
    expect(pool.queries.counts.membershipChecks - probes).toBe(0)
    apply({ type: 'update', rows: [session('active', { archived: true }), session('other', { issueId: 'two' })] })
    apply({ type: 'update', rows: [issue('one', { priority: 1, stage: 'proposed', worktreePath: '/repo' })] })
    apply({ type: 'update', rows: [session('added', { issueId: 'two' })] })
    apply({ type: 'update', rows: [{ kind: 'session', id: 'added', value: undefined }] })
    apply({ type: 'replace', rows: [...rows.values()] })
  } finally { for (const stop of stops) stop(); pool.dispose() }
})

it('routes projected membership once per changed key and retains both projections on replacement', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const session = (patch: object = {}): RowRecord => ({ kind: 'session', id: 'a', value: {
    sessionId: 'a', agentKind: 'codex', status: 'live', archived: false, cwd: '/repo', ...patch,
  } } as RowRecord)
  let first: unknown, second: unknown
  const question = { kind: 'inboxSessions' } as const
  pool.apply({ type: 'replace', rows: [session()] })
  const stops = [
    autorun(() => { first = pool.queries.project(question, 'first', id => id) }),
    autorun(() => { second = pool.queries.project(question, 'second', id => id) }),
  ]
  try {
    expect(first).toEqual(['a']); expect(second).toEqual(['a'])
    let before = pool.queries.counts.membershipChecks
    pool.apply({ type: 'update', rows: [session({ lastActiveAt: '2026-10-09' })] })
    expect(pool.queries.counts.membershipChecks - before).toBe(0)
    before = pool.queries.counts.membershipChecks
    pool.apply({ type: 'update', rows: [session({ archived: true })] })
    expect(pool.queries.counts.membershipChecks - before).toBe(2)
    expect(first).toEqual([]); expect(second).toEqual([])
    pool.apply({ type: 'replace', rows: [session()] })
    expect(first).toEqual(['a']); expect(second).toEqual(['a'])
    pool.apply({ type: 'update', rows: [session({ archived: true })] })
    expect(first).toEqual([]); expect(second).toEqual([])
  } finally { for (const stop of stops) stop(); pool.dispose() }
})

it('routes the open explorer facet when an issue finishes without leaving live history', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const issue = (stage: string): RowRecord => ({ kind: 'issue', id: 'a', value: {
    id: 'a', title: 'Issue', stage, audience: 'human', deps: [],
    createdAt: '2026-10-01', updatedAt: '2026-10-01',
  } } as RowRecord)
  pool.apply({ type: 'replace', rows: [issue('in_progress')] })
  let seen: string[] = []
  const stop = autorun(() => { seen = pool.queries.ids({ kind: 'boardIssues', explorerTab: 'needs' }) })
  try {
    expect(seen).toEqual(['a'])
    pool.apply({ type: 'update', rows: [issue('done')] })
    expect(seen).toEqual([])
    pool.apply({ type: 'update', rows: [issue('in_progress')] })
    expect(seen).toEqual(['a'])
  } finally { stop(); pool.dispose() }
})
