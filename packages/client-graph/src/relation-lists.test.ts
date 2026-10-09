import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { lazyKeptCount } from '@podium/mobx-helpers'
import { MobxPool } from './pool'
import { hostOf, type EntityModel, type LazyCollection } from './models'
import { createRelationIndex } from './shared/relation-index'
import { SCHEMA, type EntityName } from './shared/schema'
import { manyBefore, ModelCollectionBefore, subsetBefore } from './relation-lists-before.test-helper'

const stamp = '2026-10-09T00:00:00Z'
const issue = (id: string, patch: object = {}) => ({ kind: 'issue' as const, id,
  value: { id, seq: 1, title: id, stage: 'in_progress', audience: 'human',
    repoPath: '/synthetic', worktreePath: '/synthetic', createdAt: stamp, updatedAt: stamp, ...patch } as never })
const session = (id: string, patch: object = {}) => ({ kind: 'session' as const, id,
  value: { sessionId: id, issueId: 'root', cwd: '/synthetic', agentKind: 'codex',
    status: 'live', archived: false, lastActiveAt: stamp, ...patch } as never })
const initial = () => [
  { kind: 'worktree' as const, id: '/synthetic', value: { path: '/synthetic', repoId: 'repo', repoPath: '/synthetic' } as never },
  { kind: 'repo' as const, id: 'repo', value: { id: 'repo', path: '/synthetic', prefix: 'POD' } as never },
  issue('root'), issue('other'), issue('child', { parentId: 'root', deps: [{ id: 'root', type: 'blocks' }] }),
  session('seat'), session('free', { issueId: undefined }),
]
function fixture() {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: initial() })
  return pool
}

it('matches every old collection and subset reader on the same changing fixtures', () => {
  const pool = fixture(), index = createRelationIndex(SCHEMA)
  const rows = new Map<string, ReturnType<typeof initial>[number]>()
  function publish(next: ReturnType<typeof initial>) {
    index.begin()
    for (const row of next) {
      const key = `${row.kind}:${row.id}`
      index.changed(row.kind, row.id, rows.has(key), row.value)
      rows.set(key, row)
    }
    index.flush()
    runInAction(() => pool.apply({ type: 'update', rows: next }))
  }
  function parity() {
    for (const row of rows.values()) {
      const from: EntityName = row.kind, model = pool.model(from, row.id)!
      for (const [name, spec] of Object.entries(SCHEMA[from].relations)) {
        if (!(spec.kind === 'hasMany' || (spec.kind === 'edge' && (spec.direction === 'in' || spec.many)))) continue
        const before = () => manyBefore(index, from, row.id, name)
        expect([...pool.graph.many(from, row.id, name)], `${from}.${name} IDs`).toEqual([...before()])
        const current = Reflect.get(model, name) as LazyCollection<EntityModel>
        const old = new ModelCollectionBefore(hostOf(model), spec.to, row.id, before)
        const answer = current.ready
        // Explicit negative-control run must fail the real parity assertion.
        expect(process.env.PODIUM_RELATION_NEGATIVE_CONTROL === '1' && answer.length ? [] : answer,
          `${from}.${name} models`).toEqual(old.ready)
        expect(current.loading, `${from}.${name} loading`).toBe(old.loading)
        for (const subset of spec.kind === 'hasMany' ? Object.keys(spec.subsets ?? {}) : []) {
          const beforeSubset = () => subsetBefore(index, from, row.id, name, subset)
          expect([...pool.graph.subset(from, row.id, name, subset)], `${from}.${name}.${subset} IDs`).toEqual([...beforeSubset()])
          const actual = Reflect.get(current, subset) as LazyCollection<EntityModel>
          const expected = new ModelCollectionBefore(hostOf(model), spec.to, row.id, beforeSubset)
          expect(actual.ready, `${from}.${name}.${subset} models`).toEqual(expected.ready)
          expect(actual.loading, `${from}.${name}.${subset} loading`).toBe(expected.loading)
        }
      }
    }
  }
  try {
    publish(initial()); parity()
    publish([issue('child', { parentId: 'other', deps: [{ id: 'other', type: 'custom' }] }), session('free', { issueId: 'root' })]); parity()
    publish([issue('child', { title: 'renamed', parentId: 'other' }), session('seat', { archived: true }), session('joined')]); parity()
  } finally { pool.dispose() }
})

it('keeps ID and model lists across payload changes and replaces them on joins and leaves', () => {
  const pool = fixture(), root = pool.model('issue', 'root')!
  const held = root.children, heldSessions = root.sessions
  let ids: Iterable<string> = [], models: readonly EntityModel[] = [], title = '', paints = 0
  const stop = autorun(() => { ids = pool.graph.many('issue', 'root', 'children'); models = held.ready; paints++ })
  const stopTitle = autorun(() => { title = held.ready[0]?.title ?? '' })
  const firstIds = ids, firstModels = models
  try {
    expect(root.children).toBe(held)
    expect(heldSessions.ready.map(row => row.id)).toEqual(['seat'])
    runInAction(() => pool.apply({ type: 'update', rows: [issue('other', { title: 'unrelated' }), issue('child', { parentId: 'root', title: 'renamed' })] }))
    expect(ids).toBe(firstIds); expect(models).toBe(firstModels); expect(paints).toBe(1)
    expect(title).toBe('renamed')
    runInAction(() => pool.apply({ type: 'update', rows: [issue('joined', { parentId: 'root' }), session('new-seat')] }))
    expect(ids).not.toBe(firstIds); expect(models).not.toBe(firstModels)
    expect([...ids]).toEqual(['child', 'joined']); expect(models.map(row => row.id)).toEqual(['child', 'joined'])
    expect(heldSessions.ready.map(row => row.id)).toEqual(['seat', 'new-seat'])
    const joined = models
    runInAction(() => pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'child', value: undefined }, { kind: 'session', id: 'seat', value: undefined }] }))
    expect(models).not.toBe(joined); expect(models.map(row => row.id)).toEqual(['joined'])
    expect(heldSessions.ready.map(row => row.id)).toEqual(['new-seat'])
  } finally { stop(); stopTitle(); pool.dispose() }
})

it('keeps declared subset lists stable and follows members moving in and out', () => {
  const pool = fixture(), lane = pool.model('worktree', '/synthetic')!
  const collection = lane.sessions, subset = collection.issueless
  let ids: Iterable<string> = [], ready: readonly EntityModel[] = [], paints = 0
  const stop = autorun(() => {
    ids = pool.graph.subset('worktree', '/synthetic', 'sessions', 'issueless')
    ready = collection.issueless.ready
    paints++
  })
  const firstIds = ids, firstReady = ready
  try {
    // A handle retained outside the watched getter stays live too. Its lazy
    // fields have their own observation lifetime, like any @lazy field.
    expect(subset.ready.map(row => row.id)).toEqual(firstReady.map(row => row.id))
    expect(collection.issueless).toBe(collection.issueless)
    runInAction(() => pool.apply({ type: 'update', rows: [session('free', { issueId: undefined, title: 'renamed' }), issue('other', { title: 'unrelated' })] }))
    expect(ids).toBe(firstIds); expect(ready).toBe(firstReady); expect(paints).toBe(1)
    runInAction(() => pool.apply({ type: 'update', rows: [session('seat', { issueId: undefined })] }))
    expect(ids).not.toBe(firstIds); expect(ready).not.toBe(firstReady)
    expect(ready.map(row => row.id)).toEqual(['free', 'seat'])
    const joined = ready
    runInAction(() => pool.apply({ type: 'update', rows: [session('free', { issueId: 'root' })] }))
    expect(ready).not.toBe(joined); expect(ready.map(row => row.id)).toEqual(['seat'])
  } finally { stop(); pool.dispose() }
})

it('a retained collection leaves loading after hydration and follows deletion and re-addition', () => {
  const cold = issue('cold', { parentId: 'root', stage: 'done', closedAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    load: () => cold.value, schedule: () => () => {}, summaries: { issue: ['parentId', 'stage', 'closedAt', 'updatedAt'] },
  })
  pool.apply({ type: 'replace', rows: [issue('root'), cold] })
  const root = pool.model('issue', 'root')!, held = root.children
  let answer: readonly EntityModel[] = [], loading = -1
  const stop = autorun(() => { answer = held.ready; loading = held.loading })
  try {
    const before = new ModelCollectionBefore(hostOf(root), 'issue', 'root', () => pool.graph.many('issue', 'root', 'children'))
    expect(answer).toEqual(before.ready); expect(loading).toBe(before.loading); expect(loading).toBe(1)
    runInAction(() => { pool.hydrate() })
    expect(loading).toBe(0); expect(answer.map(row => row.id)).toEqual(['cold'])
    const loaded = answer
    runInAction(() => pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'cold', value: undefined }] }))
    expect(answer).toEqual([])
    runInAction(() => pool.apply({ type: 'update', rows: [issue('cold', { parentId: 'root' })] }))
    expect(answer.map(row => row.id)).toEqual(['cold']); expect(answer).not.toBe(loaded)
  } finally { stop(); pool.dispose() }
})

it('releases list demand and reopens with current membership', async () => {
  const pool = fixture(), root = pool.model('issue', 'root')!, held = root.children
  const stop = autorun(() => { void held.ready; void pool.graph.many('issue', 'root', 'children') })
  await Promise.resolve()
  expect(lazyKeptCount(held)).toBeGreaterThan(0)
  stop()
  expect(lazyKeptCount(held)).toBe(0)
  const read = vi.spyOn(pool.graph, 'many')
  runInAction(() => pool.apply({ type: 'update', rows: [issue('joined', { parentId: 'root' })] }))
  expect(read).not.toHaveBeenCalled()
  expect(held.ready.map(row => row.id)).toEqual(['child', 'joined'])
  pool.dispose()
})

it('shares repeated imperative list reads within a synchronous run and refreshes after release', async () => {
  const pool = fixture()
  const first = pool.graph.many('issue', 'root', 'children')
  expect(pool.graph.many('issue', 'root', 'children')).toBe(first)
  await Promise.resolve()
  runInAction(() => pool.apply({ type: 'update', rows: [issue('joined', { parentId: 'root' })] }))
  expect([...pool.graph.many('issue', 'root', 'children')]).toEqual(['child', 'joined'])
  pool.dispose()
})

it('keeps observed IDs when the index is replaced with unchanged membership', () => {
  const pool = fixture()
  let ids: Iterable<string> = [], paints = 0
  const stop = autorun(() => { ids = pool.graph.many('issue', 'root', 'children'); paints++ })
  const first = ids
  try {
    runInAction(() => pool.apply({ type: 'replace', rows: initial() }))
    expect(ids).toBe(first); expect(paints).toBe(1)
  } finally { stop(); pool.dispose() }
})
