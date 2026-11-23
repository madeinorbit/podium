import { repositoryCheckouts } from '@podium/client-core/test-support/machine-records'
import { here, omitGone } from './lookup'
import { EMPTY_PENDING } from '../../../tests/worklist/shared/src/row-source'
import { readFileSync, writeFileSync } from 'node:fs'
import { sessionValues } from '@podium/client-core/session-values'
import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import { autorun, observe } from 'mobx'
import { expect, it, vi } from 'vitest'
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
  // The registered repository and its worktree: checkout records (POD-6644).
  for (const record of repositoryCheckouts({ path: '/synthetic/project', repoId: 'project' as never, kind: 'repository',
    worktrees: [{ path: '/synthetic/project/wt' }] }, 'host'))
    put('checkouts', record.entityId, record.value)
  const source = createRowSource({ principal: { userId: 'operator' } }, {
    row: (kind, id) => tables.get(kind)?.get(id), rows: kind => [...(tables.get(kind)?.values() ?? [])],
    subscribeAddressedBatch(listener) { addressed = listener; return () => {} },
  }, { pending: EMPTY_PENDING })
  const handle = createWorklistPool(source.source, fixedLocals({ selectedIssueId: null, coarseNow: Date.parse('2026-10-05') }).source,
    { schedule: () => () => {} })
  const change = (kind: ReplicaKind, id: string, patch: Row) => {
    put(kind, id, { ...tables.get(kind)?.get(id), ...patch })
    addressed({ type: 'update', rows: [{ kind, id }] })
    return source.flush()
  }
  return { source, pool: handle.pool, change,
    removeDiscovery() {
      const ids = [...(tables.get('checkouts')?.keys() ?? [])]
      tables.delete('checkouts')
      addressed({ type: 'update', rows: ids.map(id => ({ kind: 'checkouts' as const, id })) })
      return source.flush()
    },
    replaceWithoutMachine(id: string) {
      tables.get('machines')?.delete(id)
      addressed({ type: 'replace', reason: 'rescope' })
      return source.flush()
    },
    dispose() { handle.dispose(); source.dispose() } }
}
function values(row: Row) { return Object.fromEntries(displayed.map(key => [key, row[key] ?? null])) }

it('preserves display parity against the frozen base synthetic corpus', () => {
  const f = fixture(4)
  try {
    const actual = Array.from({ length: 128 }, (_, n) => values(omitGone(f.pool.row('session', `session-${n}`)) as Row))
    const path = new URL('./__fixtures__/companion-joins.json', import.meta.url)
    if (process.env.PODIUM_JOIN_ORACLE === 'write') writeFileSync(path, JSON.stringify(actual, null, 2) + '\n')
    expect(actual).toEqual(JSON.parse(readFileSync(path, 'utf8')))
    expect(omitGone(f.pool.row('issue', 'history'))).toMatchObject({ repoPath: '/synthetic/project' })
  } finally { f.dispose() }
})

it('shares the repo facade across cold joins while path and prefix stay independent', () => {
  const f = fixture(4)
  const reads = vi.spyOn(f.pool, 'row')
  const paths: unknown[] = [], prefixes: unknown[] = []
  const stopPath = autorun(() => {
    const row = omitGone(f.pool.row('issue', 'history')) as Row
    paths.push(row.repoPath)
  })
  const stopPrefix = autorun(() => { prefixes.push(here(f.pool.model('repo', 'project'))?.prefix) })
  try {
    // Count screen reads before publication computes its own cold bounds.
    expect(reads.mock.calls.filter(([kind]) => kind === 'repo')).toEqual([['repo', 'project']])
    expect(paths).toEqual(['/synthetic/project'])
    expect(prefixes).toEqual(['POD'])
    f.change('repos', 'project', { prefix: 'NEW' })
    expect(paths).toEqual(['/synthetic/project'])
    expect(prefixes).toEqual(['POD', 'NEW'])
    f.change('repos', 'project', { repoPath: '/synthetic/renamed' })
    expect(paths).toEqual(['/synthetic/project', '/synthetic/renamed'])
    expect(prefixes).toEqual(['POD', 'NEW'])
  } finally { stopPrefix(); stopPath(); reads.mockRestore(); f.dispose() }
})

for (const scale of [1, 4] as const) it(`a repo prefix change alone publishes one record at ${scale}x`, () => {
  const f = fixture(scale)
  try {
    f.source.stats.reset()
    const event = f.change('repos', 'project', { prefix: 'NEW' })!
    expect(event.rows).toHaveLength(1)
    expect(event.rows[0]?.kind).toBe('repo')
    expect(f.source.stats.rowsVisited).toBe(1)
    expect((omitGone(f.pool.row('session', 'session-1')) as Row).displayRef).toBe('NEW-2-A')
  } finally { f.dispose() }
})

it('keeps repo companions when their last discovered lane leaves', () => {
  const f = fixture(1)
  try {
    f.removeDiscovery()
    expect(f.pool.tables.worktree.size).toBe(0)
    expect(omitGone(f.pool.row('repo', 'project'))).toMatchObject({ prefix: 'POD' })
    expect((omitGone(f.pool.row('session', 'session-1')) as Row).displayRef).toBe('POD-2-A')
    expect(f.pool.queries.linkedSessionId('POD-2-A')).toBe('session-1')
  } finally { f.dispose() }
})

it('removes a missing machine companion when the source replaces its snapshot', () => {
  const f = fixture(1)
  try {
    expect((omitGone(f.pool.row('session', 'session-1')) as Row).handoffTarget).toBe('Laptop')
    f.replaceWithoutMachine('target')
    expect(omitGone(f.pool.row('machine', 'target'))).toBeUndefined()
    expect((omitGone(f.pool.row('session', 'session-1')) as Row).handoffTarget).toBeUndefined()
  } finally { f.dispose() }
})
