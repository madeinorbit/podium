import { readFileSync, writeFileSync } from 'node:fs'
import { sessionValues } from '@podium/client-core/session-values'
import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import { autorun, observe } from 'mobx'
import { expect, it } from 'vitest'
import { createWorklistPool } from './create'
import { fixedLocals } from './shared/locals-source'
import { createRowSource } from './shared/row-source'
import type { RowSourceEvent } from './shared/source'

const stamp = '2020-01-01T00:00:00Z'
const displayed = ['machineName', 'condition', 'handoffTarget', 'displayRef', 'readAt', 'unread', 'snoozedUntil']
type Row = Readonly<Record<string, unknown>>
function fixture(scale: 1 | 4) {
  const tables = new Map<ReplicaKind, Map<string, Row>>()
  let addressed: (batch: ReplicaAddressedBatch) => void = () => {}
  const put = (kind: ReplicaKind, id: string, row: Row) => {
    let table = tables.get(kind)
    if (!table) tables.set(kind, table = new Map())
    table.set(id, row)
  }
  put('machines', 'host', { id: 'host', name: 'Workstation', loggedOutHarnesses: ['claude-code'] })
  put('machines', 'target', { id: 'target', name: 'Laptop', loggedOutHarnesses: [] })
  put('repos', 'project', { id: 'project', prefix: 'POD', repoPath: '/synthetic/project' })
  put('repos', 'other', { id: 'other', prefix: null, repoPath: '/synthetic/other' })
  put('issueProjections', 'history', { id: 'history', repoId: 'project', seq: 1, title: 'History',
    stage: 'done', archived: true, createdAt: stamp, updatedAt: stamp, closedAt: stamp })
  for (let n = 0; n < 32 * scale; n++) {
    const id = `session-${n}`
    put('sessions', id, { sessionId: id, title: `Synthetic session ${n}`, createdAt: stamp, lastActiveAt: stamp,
      machineId: 'host', handoffTargetMachineId: n % 3 ? 'target' : 'missing', agentKind: n % 2 ? 'codex' : 'claude-code',
      refRepoId: n % 5 ? 'project' : 'other', ...(n % 4 ? { refSeq: n + 1, refLetter: 'A' } : { refDraft: n }),
      issueId: n ? 'history' : undefined, status: n ? 'exited' : 'live', archived: !!n,
      stoppedAt: n ? stamp : undefined, agentState: { phase: n ? 'ended' : 'working' } })
  }
  const discovery = [{ path: '/synthetic/project', repoId: 'project', worktrees: [{ path: '/synthetic/project/wt' }] }]
  const source = createRowSource({ principal: { userId: 'operator' },
    readLocal: () => discovery,
    onLocals: () => () => {},
  }, {
    row: (kind, id) => tables.get(kind)?.get(id), rows: kind => [...(tables.get(kind)?.values() ?? [])],
    subscribeAddressedBatch(listener) { addressed = listener; return () => {} },
  }, { mode: 'truth' })
  const handle = createWorklistPool(source.source, fixedLocals({ selectedIssueId: null, coarseNow: Date.parse('2026-10-05') }).source,
    { summaries: { session: ['sessionId', ...displayed], issue: ['id', 'repoPath'] }, schedule: () => () => {} })
  const change = (kind: ReplicaKind, id: string, patch: Row) => {
    put(kind, id, { ...tables.get(kind)?.get(id), ...patch })
    addressed({ type: 'update', rows: [{ kind, id }] })
    return source.flush()
  }
  return { source, pool: handle.pool, change, dispose() { handle.dispose(); source.dispose() } }
}
function values(row: Row) { return Object.fromEntries(displayed.map(key => [key, row[key] ?? null])) }

it('preserves display parity against the frozen base synthetic corpus', () => {
  const f = fixture(4)
  try {
    const actual = Array.from({ length: 128 }, (_, n) => values(f.pool.row('session', `session-${n}`, 'summary') as Row))
    const path = new URL('./__fixtures__/companion-joins.json', import.meta.url)
    if (process.env.PODIUM_JOIN_ORACLE === 'write') writeFileSync(path, JSON.stringify(actual, null, 2) + '\n')
    expect(actual).toEqual(JSON.parse(readFileSync(path, 'utf8')))
    expect(f.pool.row('issue', 'history', 'summary')).toMatchObject({ repoPath: '/synthetic/project' })
  } finally { f.dispose() }
})

for (const scale of [1, 4] as const) it(`touches one companion and zero session rows at ${scale}x with fresh cold/hot readers`, () => {
  const f = fixture(scale), events: RowSourceEvent[] = []
  const stopEvents = f.source.source.subscribe(event => events.push(event))
  let writes = 0, coldRuns = 0, hotRuns = 0, cold: Row = {}, hot: Row = {}, matching: string[] = [], ref: string | undefined
  const stopWrites = observe(f.pool.tables.session, () => writes++)
  const stopCold = autorun(() => { coldRuns++; cold = sessionValues(f.pool.row('session', 'session-1', 'summary') as never) as unknown as Row })
  const stopHot = autorun(() => { hotRuns++; hot = sessionValues(f.pool.row('session', 'session-0') as never) as unknown as Row })
  const stopMatching = autorun(() => { matching = f.pool.queries.ids({ kind: 'sessionReference', ref: 'POD-2-A' }) })
  const stopRef = autorun(() => { ref = f.pool.queries.linkedSessionId('POD-2-A') })
  try {
    expect(f.pool.tables.session.size).toBe(1)
    expect((f.pool.row('session', 'session-1', 'summary') as Row).machineName).toBe('Workstation')
    expect(ref).toBe('session-1')
    expect(matching).toEqual(['session-1'])
    f.source.stats.reset()
    const machine = f.change('machines', 'host', { name: 'Renamed', loggedOutHarnesses: ['codex'] })!
    expect(machine.rows).toHaveLength(1)
    expect(machine.rows.filter(row => row.kind === 'session')).toHaveLength(0)
    expect(f.source.stats.rowsVisited).toBe(1)
    expect(writes).toBe(0)
    expect(cold).toMatchObject({ machineName: 'Renamed', condition: 'logged-out', displayRef: 'POD-2-A' })
    expect(hot.machineName).toBe('Renamed')
    expect([coldRuns, hotRuns]).toEqual([2, 2])
    f.source.stats.reset()
    const repo = f.change('repos', 'project', { prefix: 'NEW' })!
    expect(repo.rows).toHaveLength(1)
    expect(repo.rows.filter(row => row.kind === 'session' || row.kind === 'issue' || row.kind === 'worktree')).toHaveLength(0)
    expect(f.source.stats.rowsVisited).toBe(1)
    expect(writes).toBe(0)
    const visited = f.source.stats.rowsVisited
    expect(cold.displayRef).toBe('NEW-2-A')
    expect(ref).toBeUndefined()
    expect(matching).toEqual([])
    expect(f.pool.queries.linkedSessionId('NEW-2-A')).toBe('session-1')
    expect(f.pool.queries.ids({ kind: 'sessionReference', ref: 'NEW-2-A' })).toEqual(['session-1'])
    expect(f.pool.queries.ids({ kind: 'sessionReference', ref: 'POD-2-A' })).toEqual([])
    expect([coldRuns, hotRuns]).toEqual([3, 2])
    expect(f.pool.tables.session.size).toBe(1)
    for (const row of f.source.source.snapshot('session'))
      for (const field of ['machineName', 'condition', 'handoffTarget', 'displayRef']) expect(row.value).not.toHaveProperty(field)
    expect(f.source.source.row!('issue', 'history')).not.toHaveProperty('repoPath')
    console.info(`companion ${scale}x`, JSON.stringify({ sessions: 32 * scale, records: 1, sessionWrites: writes, visited }))
  } finally { stopMatching(); stopRef(); stopHot(); stopCold(); stopWrites(); stopEvents(); f.dispose() }
})

for (const scale of [1, 4] as const) it(`a repo prefix change alone publishes one record at ${scale}x`, () => {
  const f = fixture(scale)
  try {
    f.source.stats.reset()
    const event = f.change('repos', 'project', { prefix: 'NEW' })!
    expect(event.rows).toHaveLength(1)
    expect(event.rows[0]?.kind).toBe('repo')
    expect(f.source.stats.rowsVisited).toBe(1)
    expect((f.pool.row('session', 'session-1', 'summary') as Row).displayRef).toBe('NEW-2-A')
  } finally { f.dispose() }
})
