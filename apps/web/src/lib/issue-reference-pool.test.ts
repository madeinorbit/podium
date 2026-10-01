import {
  canonicalIssueRef,
  type IssueReferenceSource,
  issueReferenceModel,
} from '@podium/client-core/viewmodels'
import { LOADING, MobxPool } from '@podium/client-graph'
import { checkIssueChips } from '@podium/client-graph/diagnostics/chip-check'
import { IssueReferences } from '@podium/client-graph/issue-reference'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { asIssueId } from '@podium/model/browser'
import { describe, expect, it, vi } from 'vitest'

function reaction<T>(
  read: () => T,
  paint: (value: T) => void,
  _options: { fireImmediately: boolean },
): () => void {
  const view = createPoolProjection(null as unknown as MobxPool, read)
  paint(view.getSnapshot())
  return view.subscribe(() => paint(view.getSnapshot()))
}

function issue(i: number, patch: Record<string, unknown> = {}) {
  return {
    id: asIssueId(`iss_${i}`),
    seq: i,
    title: `Task ${i}`,
    prefix: 'POD',
    displayRef: `POD-${i}`,
    stage: 'in_progress' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archived: false,
    repoPath: '/r',
    deps: [],
    ...patch,
  }
}
function setup(count = 2000) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() })
  const rows = Array.from({ length: count }, (_, i) => issue(i + 1))
  pool.apply({
    type: 'replace',
    rows: rows.map((row) => ({ kind: 'issue', id: row.id, value: row as never })),
  })
  const queue = vi.fn()
  const row = vi.fn(pool.row.bind(pool))
  const refs = new IssueReferences({ row, tables: pool.tables, relations: pool.relations }, queue)
  return {
    pool,
    refs,
    rows,
    queue,
    row,
    dispose() {
      refs.dispose()
      pool.dispose()
    },
  }
}

describe('per-issue pool references', () => {
  it('does work only for the changed issue, with no list scan or peek', () => {
    const f = setup()
    const reads = Array.from({ length: 60 }, () => vi.fn())
    const paints = reads.map(() => vi.fn())
    const stops = reads.map((read, i) =>
      reaction(
        () => {
          read()
          return f.refs.read(`POD-${(i % 20) + 1}`)
        },
        paints[i]!,
        { fireImmediately: true },
      ),
    )
    const scans = [
      vi.spyOn(f.pool.tables.issue, 'keys'),
      vi.spyOn(f.pool.tables.issue, 'values'),
      vi.spyOn(f.pool.tables.issue, 'entries'),
    ]
    const row = f.row
    for (const read of reads) read.mockClear()
    for (const paint of paints) paint.mockClear()
    f.pool.apply({
      type: 'update',
      rows: [
        { kind: 'issue', id: 'iss_1500', value: issue(1500, { title: 'Elsewhere' }) as never },
      ],
    })
    expect(reads.reduce((n, read) => n + read.mock.calls.length, 0)).toBe(0)
    f.pool.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: 'iss_1', value: issue(1, { title: 'Renamed' }) as never }],
    })
    expect(paints.map((paint) => paint.mock.calls.length)).toEqual(
      Array.from({ length: 60 }, (_, i) => (i % 20 === 0 ? 1 : 0)),
    )
    expect(scans.reduce((n, scan) => n + scan.mock.calls.length, 0)).toBe(0)
    expect(row.mock.calls.some((call) => (call as unknown[])[2] === 'peek')).toBe(false)
    for (const stop of stops) stop()
    for (const scan of scans) scan.mockRestore()
    f.dispose()
  })

  it('redraws only when displayed fields change and follows remove/re-add', () => {
    const f = setup(1),
      paint = vi.fn()
    const stop = reaction(() => f.refs.read('POD-01'), paint, { fireImmediately: true })
    paint.mockClear()
    f.pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'issue',
          id: 'iss_1',
          value: issue(1, { priority: 0, updatedAt: '2026-09-01T00:00:00.000Z' }) as never,
        },
      ],
    })
    expect(paint).not.toHaveBeenCalled()
    for (const patch of [
      { stage: 'review' },
      { archived: true },
      { deletedAt: '2026-09-01' },
      { title: 'Changed' },
    ]) {
      f.pool.apply({
        type: 'update',
        rows: [{ kind: 'issue', id: 'iss_1', value: issue(1, patch) as never }],
      })
      expect(paint.mock.calls.at(-1)?.[0]).toEqual(
        issueReferenceModel(issue(1, patch) as IssueReferenceSource),
      )
    }
    f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'iss_1', value: undefined }] })
    expect(paint.mock.calls.at(-1)?.[0]).toBe(LOADING)
    f.refs.resolved('POD-1', null)
    expect(paint.mock.calls.at(-1)?.[0]).toBeNull()
    f.pool.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: 'iss_1', value: issue(1) as never }],
    })
    expect(paint.mock.calls.at(-1)?.[0]).toMatchObject({
      availability: 'present',
      stage: 'in_progress',
    })
    stop()
    f.dispose()
  })

  it('resolves cold references once, then queues the row through the pool reader', () => {
    const cold = issue(1, { archived: true })
    const load = vi.fn(() => cold)
    let run: (() => void) | undefined
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() }, undefined, {
      load,
      schedule: (callback) => {
        run = callback
        return () => {}
      },
    })
    pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: cold.id, value: cold as never }] })
    const queue = vi.fn(),
      refs = new IssueReferences(pool, queue),
      paint = vi.fn()
    expect(pool.tables.issue.has(cold.id)).toBe(false)
    const stop = reaction(() => refs.read('POD-01'), paint, { fireImmediately: true })
    expect(refs.read('POD-1')).toBe(LOADING)
    expect(queue).toHaveBeenCalledTimes(1)
    expect(load).not.toHaveBeenCalled()
    refs.resolved('POD-1', cold.id)
    expect(refs.read('POD-1')).toBe(LOADING)
    expect(load).not.toHaveBeenCalled()
    run?.()
    expect(load).toHaveBeenCalledTimes(1)
    expect(paint.mock.calls.at(-1)?.[0]).toMatchObject({
      availability: 'archived',
      title: 'Task 1',
    })
    stop()
    refs.dispose()
    pool.dispose()
  })

  it('checks every displayed chip value and reports only positions, fields and opaque ids', () => {
    const f = setup(20)
    const legacy = f.rows as IssueReferenceSource[]
    const tokens = legacy.map((row) => canonicalIssueRef(row))
    expect(checkIssueChips(f.refs, legacy, tokens)).toEqual({
      chips: 20,
      pending: 0,
      differences: 0,
      first: null,
    })
    for (const patch of [
      { title: 'PRIVATE title' },
      { stage: 'review' },
      { archived: true },
      { deletedAt: 'PRIVATE date' },
      { displayRef: 'NEW-1', prefix: 'NEW' },
    ]) {
      f.pool.apply({
        type: 'update',
        rows: [{ kind: 'issue', id: 'iss_1', value: issue(1, patch) as never }],
      })
      const changed = checkIssueChips(f.refs, legacy, tokens)
      if (patch.prefix) {
        expect(changed.pending).toBe(1)
        f.refs.resolved('POD-1', null)
      }
      const result = checkIssueChips(f.refs, legacy, tokens)
      expect(result.differences).toBeGreaterThan(0)
      expect(result.first?.chipIndex).toBe(0)
      expect(JSON.stringify(result)).not.toContain('PRIVATE')
    }
    f.dispose()
  })

  it('batches 50 cold references in one existing load window, never per chip', async () => {
    const cold = Array.from({ length: 50 }, (_, i) => issue(i + 1, { archived: true }))
    const load = vi.fn((_entity: string, id: string) => cold.find((row) => row.id === id))
    const due: Array<() => void> = []
    const resolveReferences = vi.fn(async (refs: readonly string[]) =>
      refs.map((ref) => ({
        ref,
        id: ref === 'POD-999' ? null : `iss_${Number(ref.split('-')[1])}`,
      })),
    )
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() }, undefined, {
      load,
      resolveReferences,
      schedule: (run) => {
        due.push(run)
        return () => {}
      },
    })
    pool.apply({
      type: 'replace',
      rows: cold.map((row) => ({ kind: 'issue', id: row.id, value: row as never })),
    })
    const paints = cold.map(() => vi.fn())
    const stops = cold.map((row, i) =>
      reaction(() => pool.references.read(`POD-${row.seq}`), paints[i]!, { fireImmediately: true }),
    )
    expect(pool.references.read('POD-01')).toBe(LOADING)
    expect(pool.references.read('POD-999')).toBe(LOADING)
    expect(resolveReferences).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
    expect(due).toHaveLength(1)
    due.shift()!()
    await Promise.resolve()
    expect(resolveReferences).toHaveBeenCalledTimes(1)
    expect(resolveReferences.mock.calls[0]?.[0]).toHaveLength(51)
    expect(load).not.toHaveBeenCalled()
    expect(pool.references.read('POD-999')).toBeNull()
    expect(due).toHaveLength(1)
    due.shift()!()
    expect(load).toHaveBeenCalledTimes(50)
    expect(paints.every((paint) => paint.mock.calls.at(-1)?.[0]?.availability === 'archived')).toBe(
      true,
    )
    for (const stop of stops) stop()
    pool.dispose()
  })
})
