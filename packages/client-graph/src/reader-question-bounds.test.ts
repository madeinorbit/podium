import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../worklist-proto/harness/src/work-meter'
import { MobxPool } from './pool'
import { createKeyedAnswer } from './query-result'
import { createColdIndex } from './shared/cold-index'
import { SCHEMA } from './shared/schema'
import { createSessionQuestions } from './shared/session-questions'
import type { RowRecord, RowSourceEvent } from './shared/source'

const stamp = '2026-10-03T12:00:00Z', old = '2020-01-01T00:00:00Z'
function fixture(scale: 1 | 4 = 1) {
  const issue = (id: string, patch: object = {}): RowRecord => ({ kind: 'issue', id, value: {
    id, seq: 1, title: id, stage: 'planning', priority: 0, repoId: 'other',
    repoPath: '/other', worktreePath: `/other/${id}`, createdAt: old, updatedAt: old, ...patch,
  } } as RowRecord)
  const session = (id: string, patch: object = {}): RowRecord => ({ kind: 'session', id, value: {
    sessionId: id, agentKind: 'codex', status: 'live', cwd: '/other', machineId: 'other',
    lastActiveAt: old, createdAt: old, ...patch,
  } } as RowRecord)
  const target = issue('target', { repoId: 'wanted', repoPath: '/wanted', worktreePath: '/wanted/wt', priority: 2 })
  const mine = session('mine', { issueId: 'target', cwd: '/wanted/wt', machineId: 'm0',
    lastActiveAt: stamp, createdAt: stamp, refRepoId: 'wanted', refSeq: 1, refLetter: 'A', agentState: { phase: 'needs_user' } })
  const peer = session('peer', { machineId: 'm1', createdAt: '2025-01-01T00:00:00Z',
    agentState: { phase: 'idle', idle: { kind: 'done' } } })
  const repo = (id: string, path: string, prefix: string): RowRecord => ({ kind: 'worktree', id, value: { repoId: id, repoPath: path, prefix } }) as RowRecord
  const rows = [repo('wanted', '/wanted', 'WANTED'), repo('other', '/other', 'OTHER'), repo('new', '/pending', 'NEW'), repo('else', '/else', 'ELSE'), target, mine, peer, ...Array.from({ length: 128 * scale }, (_, n) =>
    [issue(`issue-${n}`), session(`session-${n}`)]).flat()]
  const source = createColdIndex(SCHEMA)
  source.apply({ type: 'replace', rows })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    cold: () => source, load: () => undefined, schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows })
  const publish = (event: RowSourceEvent) => { source.apply(event); pool.apply(event) }
  return { pool, source, rows, issue, session, target, mine, peer, publish }
}

it('keeps narrowed answers and scalar questions flat with fully resident history at 1x/4x', async () => {
  async function measured(scale: 1 | 4) {
    const f = fixture(scale), censusIssue = vi.spyOn(f.pool.tables.issue, 'keys'),
      censusSession = vi.spyOn(f.pool.tables.session, 'keys')
    try {
      const { work } = await measureWork(async () => insideReader('addressed questions', () => {
        const queries = f.pool.queries
        expect(queries.ids({ kind: 'containingIssues', cwd: '/wanted/wt/file' })).toEqual(['target'])
        expect(queries.ids({ kind: 'commandIssueSessions', issueId: 'target' })).toEqual(['mine'])
        expect(queries.ids({ kind: 'sessionReference', ref: 'WANTED-1-A' })).toEqual(['mine'])
        expect(queries.ids({ kind: 'headerRecentSession' })).toEqual(['mine'])
        expect(queries.nextTriageSession('mine')).toBe('peer')
        expect(queries.latestMachineSession(['m0', 'm1'])).toEqual({ machineId: 'm0', createdAt: stamp })
        expect(queries.activity({ kind: 'commandRootActivity', roots: ['/wanted'] })).toBe(Date.parse(stamp))
      }), { pool: f.pool })
      expect(censusIssue).not.toHaveBeenCalled()
      expect(censusSession).not.toHaveBeenCalled()
      return { work, visits: f.pool.queries.counts.scalarVisits }
    } finally { censusIssue.mockRestore(); censusSession.mockRestore(); f.pool.dispose() }
  }
  const first = await measured(1), second = await measured(4)
  console.info('addressed question work 1x/4x', JSON.stringify({ first, second }))
  expect(second.visits).toBe(first.visits)
  expect(second.work.rows).toBe(first.work.rows)
  expect(second.work.derivations).toBe(first.work.derivations)
  expect(second.work.elements).toBe(first.work.elements)
})

it('shadows long runs of newer source facts without walking excluded resident history', () => {
  for (const scale of [1, 4] as const) {
    const f = fixture(scale)
    try {
      const records = f.rows.filter(row => row.kind === 'session' && row.id.startsWith('session-'))
      f.source.apply({ type: 'update', rows: records.map(row => f.session(row.id, {
        ...row.value as object, lastActiveAt: '2028-01-01T00:00:00Z', createdAt: '2028-01-01T00:00:00Z', machineId: 'm0',
      })) })
      f.pool.apply({ type: 'update', rows: records })
      const before = f.pool.queries.counts.scalarVisits
      expect(f.pool.queries.ids({ kind: 'headerRecentSession' })).toEqual(['mine'])
      expect(f.pool.queries.latestMachineSession(['m0', 'm1'])?.machineId).toBe('m0')
      expect(f.pool.queries.counts.scalarVisits - before).toBe(3)
    } finally { f.pool.dispose() }
  }
})

it('maintains resident predicate moves, removals and per-path repo identities by changed key', () => {
  const f = fixture(), answers: string[][] = []
  const stop = autorun(() => answers.push(f.pool.queries.repoIds('/pending')))
  try {
    const resident = f.issue('pending', { repoId: 'new', repoPath: '/pending', worktreePath: '/pending/wt' })
    f.pool.apply({ type: 'update', rows: [resident] })
    expect(answers.at(-1)).toEqual(['new'])
    const before = answers.length
    f.pool.apply({ type: 'update', rows: [{ ...resident, value: { ...resident.value as object, title: 'New title' } } as RowRecord] })
    expect(answers).toHaveLength(before)
    expect(f.pool.queries.ids({ kind: 'containingIssues', cwd: '/pending/wt/file' })).toEqual(['pending'])
    f.pool.apply({ type: 'update', rows: [f.issue('pending', { repoId: 'else', repoPath: '/else', worktreePath: '/else/wt' })] })
    expect(answers.at(-1)).toEqual([])
    expect(f.pool.queries.ids({ kind: 'containingIssues', cwd: '/pending/wt/file' })).toEqual([])
    f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'pending', value: undefined }] })
    expect(f.pool.queries.repoIds()).not.toContain('new')
  } finally { stop(); f.pool.dispose() }
})

it('does not wake addressed collapse/order or machine answers for unrelated session changes', () => {
  const f = fixture(), runs = { addressed: 0, machine: 0 }
  let latest: unknown
  const stops = [autorun(() => { f.pool.queries.collapsed('mine'); f.pool.queries.orderKey('mine'); runs.addressed++ }),
    autorun(() => { latest = f.pool.queries.latestMachineSession(['m0', 'm1']); runs.machine++ })]
  try {
    runs.addressed = runs.machine = 0
    f.publish({ type: 'update', rows: [f.session('session-0', { createdAt: '2030-01-01T00:00:00Z', resume: { kind: 'codex-thread', value: 'other' } })] })
    expect(runs).toEqual({ addressed: 0, machine: 0 })
    f.publish({ type: 'update', rows: [f.session('mine', { ...f.mine.value as object, machineId: 'other' })] })
    expect(latest).toEqual({ machineId: 'm1', createdAt: '2025-01-01T00:00:00Z' })
    expect(runs.machine).toBe(1)
  } finally { for (const stop of stops) stop(); f.pool.dispose() }
})

it('shares immutable keyed trees while successor and removal honor custom ordering', () => {
  const answer = createKeyedAnswer<{ id: string; rank: number }>((a, b) => a.rank - b.rank)
  for (const [id, rank] of [['a', 3], ['b', 1], ['c', 2]] as const) answer.set(id, '', { id, rank })
  const fork = answer.fork()
  fork.delete('c')
  fork.set('a', '', { id: 'a', rank: 0 })
  expect(answer.snapshot().map(row => row.id)).toEqual(['b', 'c', 'a'])
  expect(fork.snapshot().map(row => row.id)).toEqual(['a', 'b'])
  expect(answer.after({ id: 'b', rank: 1 }, 'b')?.id).toBe('c')
  expect(fork.after({ id: 'a', rank: 0 }, 'a')?.id).toBe('b')
})

it('answers successor after mass snooze expiry and clock rewind without replaying history', () => {
  for (const scale of [1, 4] as const) {
    const questions = createSessionQuestions(() => false)
    for (let n = 0; n < 128 * scale; n++) questions.set(`sleep-${n}`, {
      status: 'live', agentKind: 'codex', lastActiveAt: old, createdAt: old,
      snoozedUntil: '2026-10-02T12:00:00Z', cwd: `/history/${n}`, machineId: 'history',
    })
    questions.set('mine', { status: 'live', agentKind: 'codex', lastActiveAt: stamp, createdAt: stamp })
    const before = questions.visits
    expect(questions.next(questions.triageFact('mine', Date.parse(stamp)), Date.parse(stamp))?.id).toBe('sleep-0')
    expect(questions.visits - before).toBe(1)
    const rewind = Date.parse('2026-10-01T12:00:00Z'), visits = questions.visits
    expect(questions.next(questions.triageFact('mine', rewind), rewind)?.id).toBe('sleep-0')
    expect(questions.visits - visits).toBe(1)
  }
})

it('keeps resident scalar overrides independent of source snooze and replacement collapse', () => {
  const f = fixture()
  try {
    const sleeping = f.session('sleeper', { lastActiveAt: old, snoozedUntil: '2026-10-02T12:00:00Z' })
    f.publish({ type: 'update', rows: [sleeping] })
    f.source.apply({ type: 'update', rows: [f.session('sleeper', { lastActiveAt: old, snoozedUntil: '2030-10-02T12:00:00Z' })] })
    f.pool.apply({ type: 'update', rows: [sleeping] })
    const scalar = f.pool.queries.nextTriageSession('peer')
    expect(scalar).toBe('sleeper')
    const resume = { kind: 'codex-thread', value: 'resident-twins' }
    const loser = f.session('twin-a', { status: 'exited', resume, cwd: '/twin', machineId: 'twin', createdAt: stamp })
    const winner = f.session('twin-z', { status: 'hibernated', resume, cwd: '/twin', machineId: 'twin', createdAt: old })
    f.publish({ type: 'update', rows: [loser, winner] })
    expect(f.pool.queries.latestMachineSession(['twin'])?.createdAt).toBe(old)
    // The resident loser row retains its identity; only source collapse changes.
    f.publish({ type: 'replace', rows: [...f.rows, loser] })
    expect(f.pool.queries.latestMachineSession(['twin'])?.createdAt).toBe(stamp)
  } finally { f.pool.dispose() }
})

it('preserves collapsed command order for equal machine creation timestamps', () => {
  const f = fixture()
  try {
    const resume = { kind: 'codex-thread', value: 'machine-tie' }
    f.publish({ type: 'update', rows: [
      f.session('z-winner', { status: 'hibernated', resume, createdAt: stamp, machineId: 'z' }),
      f.session('b-peer', { status: 'exited', createdAt: stamp, machineId: 'b' }),
      f.session('a-loser', { status: 'exited', resume, createdAt: old, machineId: 'a' }),
    ] })
    expect(f.pool.queries.latestMachineSession(['z', 'b'])?.machineId).toBe('z')
  } finally { f.pool.dispose() }
})

it('prunes deadline-ineligible subtrees for first and successor answers', () => {
  const answer = createKeyedAnswer<{ id: string; rank: number; deadline: number }>(
    (a, b) => a.rank - b.rank, value => value.deadline)
  for (let rank = 0; rank < 100; rank++) answer.set(String(rank), '', { id: String(rank), rank, deadline: rank % 2 })
  expect(answer.firstBounded(0, 'atMost')?.rank).toBe(0)
  expect(answer.firstBounded(0, 'above')?.rank).toBe(1)
  expect(answer.firstBounded(0, 'atMost', { id: '49', rank: 49, deadline: 1 }, '49')?.rank).toBe(50)
  expect(answer.firstBounded(0, 'above', { id: '49', rank: 49, deadline: 1 }, '49')?.rank).toBe(51)
  expect(answer.firstBounded(2, 'above')).toBeUndefined()
  expect(answer.firstBounded(-1, 'atMost')).toBeUndefined()
})

it('publishes scalar replacement when independent resident revisions collide with source revisions', () => {
  const source = createColdIndex(SCHEMA)
  const session = (id: string, patch: object = {}): RowRecord => ({ kind: 'session', id, value: {
    sessionId: id, agentKind: 'codex', status: 'live', cwd: '', machineId: 'm0',
    lastActiveAt: old, createdAt: stamp, ...patch,
  } } as RowRecord)
  let resident = session('r')
  const cold = session('c', { machineId: 'm1', archived: true, status: 'exited', stoppedAt: old, createdAt: old })
  source.apply({ type: 'replace', rows: [resident, cold] })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    cold: () => source, load: () => undefined, schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows: [resident, cold] })
  const answers: unknown[] = [], stop = autorun(() => answers.push(pool.queries.latestMachineSession(['m0', 'm1'])))
  try {
    expect(pool.tables.session.has('c')).toBe(false)
    for (let n = 0; n < 6; n++) {
      resident = session('r', { createdAt: `2027-01-0${n + 1}T00:00:00Z` })
      pool.apply({ type: 'update', rows: [resident] })
    }
    expect(answers.at(-1)).toMatchObject({ machineId: 'm0' })
    const replacement: RowSourceEvent = { type: 'replace', rows: [resident,
      session('c', { machineId: 'm1', archived: true, status: 'exited', stoppedAt: old, createdAt: '2030-01-01T00:00:00Z' })] }
    source.apply(replacement)
    pool.apply(replacement)
    expect(answers.at(-1)).toMatchObject({ machineId: 'm1' })
  } finally { stop(); pool.dispose() }
})
