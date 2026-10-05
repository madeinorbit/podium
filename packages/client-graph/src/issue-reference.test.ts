import { runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../worklist-proto/harness/src/work-meter'
import { MobxPool } from './pool'
import { createPoolProjection } from './runtime-pool'
import { SHELL_SUMMARIES } from './shell-schema'
import { createColdIndex } from './shared/cold-index'
import { SCHEMA } from './shared/schema'
import type { RowRecord, RowSourceEvent } from './shared/source'
import { LOADING } from './worklist/rollup'

const stamp = '2020-01-01T00:00:00Z'
const issue = (id: string, seq = 1, patch: object = {}): RowRecord => ({ kind: 'issue', id, value: {
  id, seq, repoId: 'target-repo', repoPath: '/fixture', title: id, stage: 'review', archived: true,
  audience: 'human', labels: [], deps: [], priority: 2, createdAt: stamp, updatedAt: stamp, ...patch,
} } as RowRecord)
const repo = (id = 'target-repo', prefix = 'POD'): RowRecord => ({ kind: 'worktree', id: `/${id}`, value: {
  path: `/${id}`, repoId: id, prefix, repoPath: `/${id}`, repoName: id,
} } as RowRecord)
function fixture(scale: 1 | 4, resident: boolean) {
  const rows = [repo(), issue('target'),
    ...Array.from({ length: 128 * scale }, (_, n) => repo(`foreign-repo-${n}`, `F${n}`)),
    ...Array.from({ length: 128 * scale }, (_, n) => issue(`foreign-${n}`, n + 10, { repoId: `foreign-repo-${n}` })),
  ]
  const source = createColdIndex(SCHEMA, SHELL_SUMMARIES)
  source.apply({ type: 'replace', rows })
  const load = vi.fn(() => undefined), authority = vi.fn(() => undefined)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 }, undefined, {
    cold: () => source, summaries: SHELL_SUMMARIES, worklist: 'demand', load, issueIdByRef: authority, schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows })
  if (resident) runInAction(() => {
    for (const row of rows) if (row.kind === 'issue') pool.tables.issue.set(row.id, row.value as never)
  })
  return { pool, load, authority,
    publish(event: RowSourceEvent) { source.apply(event); pool.apply(event) },
  }
}

it('keeps facade creation, first chip and named updates flat with cold and resident histories', async () => {
  async function measured(scale: 1 | 4, resident: boolean) {
    const f = fixture(scale, resident), row = vi.spyOn(f.pool, 'row')
    const ids = vi.spyOn(f.pool.queries, 'ids'), repos = vi.spyOn(f.pool.queries, 'repoIds')
    const walks = ['keys', 'values', 'entries'].map(method => vi.spyOn(f.pool.tables.issue, method as 'keys'))
    const measure = (name: string, action: () => void) => measureWork(async () => insideReader(name, action), { pool: f.pool })
    let stop = () => {}
    try {
      const creation = await measure('reference facade construction', () => { void f.pool.references })
      expect(row).not.toHaveBeenCalled()
      const paint = vi.fn(), view = createPoolProjection(f.pool, pool => pool.references.read(' POD-01 '))
      const first = await measure('reference first chip', () => {
        expect(view.getSnapshot()).toMatchObject({ issueId: 'target', ref: 'POD-1', availability: 'archived' })
        stop = view.subscribe(paint)
      })
      expect(row.mock.calls).toEqual([['issue', 'target', 'summary-fields'], ['repo', 'target-repo']])
      const repeat = await measure('reference repeat chip', () => { expect(view.getSnapshot()).toMatchObject({ title: 'target' }) })
      const unrelated = await measure('reference unrelated issue', () => f.publish({ type: 'update', rows: [issue('foreign-0', 10, { repoId: 'foreign-repo-0', title: 'Renamed' })] }))
      expect(paint).not.toHaveBeenCalled()
      const target = await measure('reference named issue', () => f.publish({ type: 'update', rows: [issue('target', 1, { title: 'Changed' })] }))
      expect(paint).toHaveBeenCalledTimes(1)
      expect(view.getSnapshot()).toMatchObject({ title: 'Changed' })
      stop(); paint.mockClear()
      const closed = await measure('reference removed chip', () => f.publish({ type: 'update', rows: [issue('target', 1, { title: 'Offscreen' })] }))
      expect(paint).not.toHaveBeenCalled()
      expect(ids).not.toHaveBeenCalled(); expect(repos).not.toHaveBeenCalled()
      for (const walk of walks) expect(walk).not.toHaveBeenCalled()
      expect(f.load).not.toHaveBeenCalled(); expect(f.authority).not.toHaveBeenCalled()
      return Object.fromEntries(Object.entries({ creation, first, repeat, unrelated, target, closed }).map(([name, value]) => [name, value.work]))
    } finally { stop(); for (const walk of walks) walk.mockRestore(); row.mockRestore(); ids.mockRestore(); repos.mockRestore(); f.pool.dispose() }
  }
  for (const resident of [false, true]) {
    const first = await measured(1, resident), second = await measured(4, resident)
    console.info('shared reference work1x4x', JSON.stringify({ resident, first, second }))
    for (const action of Object.keys(first)) for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(second[action]?.[counter]).toBe(first[action]?.[counter])
  }
})

it('releases unresolved chips before hydration and never revives them on a late answer or scope reset', () => {
  const f = fixture(1, false), view = createPoolProjection(f.pool, pool => pool.references.read('POD-999'))
  try {
    const stop = view.subscribe(() => {})
    expect(view.getSnapshot()).toBe(LOADING)
    stop()
    expect(f.pool.references.hasRequest('POD-999')).toBe(false)
    expect(f.pool.hydrate()).toBe(0)
    expect(f.authority).not.toHaveBeenCalled()
    f.pool.references.resolved('POD-999', 'target')
    f.pool.references.resetUnresolved()
    expect(f.pool.hydrate()).toBe(0)
    expect(f.pool.references.hasRequest('POD-999')).toBe(false)
    expect(f.load).not.toHaveBeenCalled()
  } finally { f.pool.dispose() }
})

it('uses canonical identity, first bare alias ownership and separate live/all prefix membership', () => {
  const f = fixture(1, false)
  try {
    f.publish({ type: 'update', rows: [issue('POD-1', 8), repo('deleted-repo', 'DEL'), issue('deleted', 1, { repoId: 'deleted-repo', deletedAt: stamp }), repo('empty', 'EMPTY'), issue('z', 7, { repoId: undefined }), issue('a', 7, { repoId: undefined })] })
    expect(f.pool.references.id('POD-01')).toBe('target')
    expect(f.pool.references.id('#007')).toBe('a')
    expect(f.pool.queries.hasIssuePrefix('DEL')).toBe(false)
    expect(f.pool.queries.hasIssuePrefix('DEL', true)).toBe(true)
    expect(f.pool.queries.hasIssuePrefix('EMPTY', true)).toBe(false)
    f.publish({ type: 'update', rows: [{ kind: 'issue', id: 'a', value: undefined }] })
    expect(f.pool.references.id('#7')).toBe('z')
    const view = createPoolProjection(f.pool, pool => ({ live: pool.queries.hasIssuePrefix('NEW'), all: pool.queries.hasIssuePrefix('NEW', true) }))
    const paint = vi.fn(), stop = view.subscribe(paint)
    expect(view.getSnapshot()).toEqual({ live: false, all: false })
    f.publish({ type: 'update', rows: [repo('target-repo', 'NEW')] })
    expect(view.getSnapshot()).toEqual({ live: true, all: true })
    expect(paint).toHaveBeenCalledTimes(1)
    expect(f.pool.references.id('NEW-1')).toBe('target')
    f.publish({ type: 'update', rows: [repo('target-repo', 'POD')] })
    expect(view.getSnapshot()).toEqual({ live: false, all: false })
    stop()
  } finally { f.pool.dispose() }
})
