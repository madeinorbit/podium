import { omitGone } from './lookup'
import { autorun, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { residentIds } from './enumerate'
import { MobxPool } from './pool'
import { createColdIndex } from './shared/cold-index'
import { SCHEMA } from './shared/schema'
import type { SessionActivityQuestion } from './shared/session-activity'
import type { RowRecord, RowSourceEvent } from './shared/source'

const stamp = '2026-10-03T12:00:00Z'
const session = (id: string, patch: object = {}): RowRecord => ({
  kind: 'session',
  id,
  value: {
    sessionId: id,
    agentKind: 'codex',
    status: 'live',
    cwd: '/repo',
    lastActiveAt: stamp,
    createdAt: stamp,
    ...patch,
  },
})

function fixture(rows: RowRecord[]) {
  const source = createColdIndex(SCHEMA)
  source.apply({ type: 'replace', rows })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    cold: () => source,
    load: () => undefined,
    schedule: () => () => {},
    worklist: 'demand',
  })
  pool.apply({ type: 'replace', rows })
  const publish = (event: RowSourceEvent) => {
    source.apply(event)
    pool.apply(event)
  }
  return { pool, source, publish }
}

/** The 44809b1850 activity algorithm: exclude the resident union from the
 * source maximum, then inspect every resident for each repository question.
 * Count visits even when a cached activity projection could supply the row. */
function residentScan(
  f: ReturnType<typeof fixture>,
  question: SessionActivityQuestion,
  counts: { calls: number; residentVisits: number },
): number {
  counts.calls++
  const residents = residentIds(f.pool, 'session')
  let maximum = f.source.readerActivity({
    ...question,
    excluded: [...residents, ...(question.excluded ?? [])],
  })
  const excluded = new Set(question.excluded)
  for (const id of residents) {
    counts.residentVisits++
    if (excluded.has(id) || f.pool.queries.collapsed(id)) continue
    const row = omitGone(f.pool.row('session', id, 'summary-fields')) as
      | { cwd: string; lastActiveAt?: string; agentKind?: string }
      | undefined
    if (!row || (question.agentsOnly && row.agentKind === 'shell')) continue
    if (question.roots.some(root => row.cwd === root ||
        (question.match !== 'exact' && row.cwd.startsWith(`${root}/`))))
      maximum = Math.max(maximum, Date.parse(row.lastActiveAt ?? '') || 0)
  }
  return maximum
}

describe('warmed repository activity work', () => {
  it.each([1, 4])('keeps 500 repository answers flat with %ix resident history', scale => {
    const rows = Array.from({ length: 1536 * scale }, (_, n) => session(`s-${n}`, {
      cwd: `/repos/${n % 500}/worktree`,
      lastActiveAt: new Date(Date.parse(stamp) + n * 1000).toISOString(),
    }))
    const f = fixture(rows)
    const legacy = { calls: 0, residentVisits: 0 }
    const indexed = { calls: 0, scalarVisits: 0, rowReads: 0, residentEnumerations: 0 }
    const questions = Array.from({ length: 500 }, (_, n): SessionActivityQuestion => ({
      kind: 'commandRootActivity', roots: [`/repos/${n}`],
    }))
    const observed: number[] = []
    const runs = new Array<number>(500).fill(0)
    const stops = questions.map((question, n) => autorun(() => {
      runs[n] = runs[n]! + 1
      observed[n] = f.pool.queries.activity(question)
    }))
    try {
      expect(f.pool.tables.session.size).toBe(rows.length)
      for (let frame = 0; frame < 3; frame++) {
        if (frame) f.publish({ type: 'update', rows: [{
          ...rows[0]!, value: { ...rows[0]!.value, title: `Title ${frame}`, status: 'idle' },
        }] })
        const expected = questions.map(question => residentScan(f, question, legacy))
        const reads = vi.spyOn(f.pool, 'row')
        const enumerate = vi.spyOn(f.pool.tables.session, 'keys')
        const before = f.pool.queries.counts.scalarVisits
        try {
          const actual = questions.map(question => {
            indexed.calls++
            return f.pool.queries.activity(question)
          })
          expect(actual).toEqual(expected)
          expect(observed).toEqual(expected)
          // Preserving every usage value also preserves repository MRU order.
          const order = (values: number[]) => values.map((at, n) => ({ at, n }))
            .sort((a, b) => b.at - a.at || a.n - b.n).map(value => value.n)
          expect(order(actual)).toEqual(order(expected))
          indexed.scalarVisits += f.pool.queries.counts.scalarVisits - before
          indexed.rowReads += reads.mock.calls.length
          indexed.residentEnumerations += enumerate.mock.calls.length
        } finally {
          reads.mockRestore()
          enumerate.mockRestore()
        }
      }
      expect(runs).toEqual(new Array(500).fill(1))
      expect(indexed).toEqual({ calls: 1500, scalarVisits: 1500, rowReads: 0, residentEnumerations: 0 })
      expect(legacy).toEqual({ calls: 1500, residentVisits: 1500 * rows.length })
      // Negative control: the measured scanner fails the same bounded-work budget.
      expect(legacy.residentVisits <= indexed.calls).toBe(false)
      console.info('repository activity A/B', JSON.stringify({ scale, residents: rows.length, legacy, indexed }))
    } finally {
      for (const stop of stops) stop()
      f.pool.dispose()
    }
  })

  it('notifies only activity material changes and their old/new repository paths', () => {
    let row = session('moving', { cwd: '/repo/worktree' })
    const f = fixture([row])
    const questions: SessionActivityQuestion[] = [
      { kind: 'commandRootActivity', roots: ['/repo'] },
      { kind: 'commandRootActivity', roots: ['/repo'], match: 'exact' },
      { kind: 'commandRootActivity', roots: ['/elsewhere'] },
      { kind: 'commandRootActivity', roots: ['/repo'], agentsOnly: true },
    ]
    const values: number[][] = questions.map(() => [])
    const stops = questions.map((question, n) => autorun(() => values[n]!.push(f.pool.queries.activity(question))))
    const update = (patch: object) => {
      row = { ...row, value: { ...row.value, ...patch } }
      f.publish({ type: 'update', rows: [row] })
    }
    try {
      for (const patch of [
        { title: 'Renamed' }, { status: 'idle' }, { archived: true },
        { draftUpdatedAt: '2030-01-01T00:00:00Z' }, { headless: true },
        { agentKind: 'claude-code' }, { machineId: 'another-machine' },
      ]) update(patch)
      expect(values.map(answer => answer.length)).toEqual([1, 1, 1, 1])
      update({ lastActiveAt: '2027-01-01T00:00:00Z' })
      expect(values.map(answer => answer.length)).toEqual([2, 1, 1, 2])
      expect(values[0]!.at(-1)).toBe(Date.parse('2027-01-01T00:00:00Z'))
      update({ cwd: '/elsewhere' })
      expect(values.map(answer => answer.length)).toEqual([3, 1, 2, 3])
      expect(values[0]!.at(-1)).toBe(0)
      expect(values[2]!.at(-1)).toBe(Date.parse('2027-01-01T00:00:00Z'))
      update({ cwd: '/repo' })
      expect(values[1]!.at(-1)).toBe(Date.parse('2027-01-01T00:00:00Z'))
      update({ agentKind: 'shell' })
      expect(values[0]!.at(-1)).toBe(Date.parse('2027-01-01T00:00:00Z'))
      expect(values[3]!.at(-1)).toBe(0)
      f.publish({ type: 'update', rows: [{ kind: 'session', id: row.id, value: undefined }] })
      expect(values[0]!.at(-1)).toBe(0)
    } finally {
      for (const stop of stops) stop()
      f.pool.dispose()
    }
  })

  it('replaces stale source maxima by address and restores source activity on resident eviction', () => {
    const latest = session('latest', { lastActiveAt: '2029-01-01T00:00:00Z' })
    const runner = session('runner', { lastActiveAt: '2028-01-01T00:00:00Z' })
    const f = fixture([latest, runner])
    const question: SessionActivityQuestion = { kind: 'commandRootActivity', roots: ['/repo'] }
    const values: number[] = []
    const stop = autorun(() => values.push(f.pool.queries.activity(question)))
    try {
      // A pending resident write lowers the old maximum; the source is still ahead.
      f.pool.apply({ type: 'update', rows: [session('latest', { lastActiveAt: stamp })] })
      expect(values.at(-1)).toBe(Date.parse('2028-01-01T00:00:00Z'))
      expect(f.pool.queries.activity({ ...question, excluded: new Set(['runner']) })).toBe(Date.parse(stamp))
      f.pool.apply({ type: 'update', rows: [session('runner', { cwd: '/elsewhere' })] })
      expect(values.at(-1)).toBe(Date.parse(stamp))
      runInAction(() => f.pool.tables.session.delete('latest'))
      expect(values.at(-1)).toBe(Date.parse('2029-01-01T00:00:00Z'))
      f.publish({ type: 'replace', rows: [session('replacement', { lastActiveAt: '2030-01-01T00:00:00Z' })] })
      expect(values.at(-1)).toBe(Date.parse('2030-01-01T00:00:00Z'))
      expect(f.pool.queries.activity({ ...question, roots: ['/elsewhere'] })).toBe(0)
    } finally {
      stop()
      f.pool.dispose()
    }
  })

  it('updates indexed activity when a parked twin collapses or returns', () => {
    const resume = { kind: 'codex-thread', value: 'twins' }
    const loser = session('old', { cwd: '/repo/old', status: 'exited', resume, lastActiveAt: '2030-01-01T00:00:00Z' })
    const winner = session('winner', { cwd: '/repo/winner', status: 'hibernated', resume })
    const f = fixture([loser])
    const values: number[] = []
    const stop = autorun(() => values.push(f.pool.queries.activity({ kind: 'commandRootActivity', roots: ['/repo/old'] })))
    try {
      expect(values.at(-1)).toBe(Date.parse('2030-01-01T00:00:00Z'))
      f.publish({ type: 'update', rows: [winner] })
      expect(f.pool.queries.collapsed('old')).toBe(true)
      expect(values.at(-1)).toBe(0)
      f.publish({ type: 'update', rows: [{ kind: 'session', id: 'winner', value: undefined }] })
      expect(f.pool.queries.collapsed('old')).toBe(false)
      expect(values.at(-1)).toBe(Date.parse('2030-01-01T00:00:00Z'))
    } finally {
      stop()
      f.pool.dispose()
    }
  })
})
