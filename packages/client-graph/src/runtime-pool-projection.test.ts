import { getObserverTree } from 'mobx'
import { _observerFinalizationRegistry } from 'mobx-react-lite'
import { afterEach, expect, it, vi } from 'vitest'
import { MobxPool } from './pool'
import { createPoolProjection } from './runtime-pool'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop()
  vi.restoreAllMocks()
})

function fixture() {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  cleanups.push(() => pool.dispose())
  // Track size as well as membership so another key can change an observed
  // input while preserving the projected result. The size atom also exposes
  // the projection's real observer lifetime through getObserverTree.
  const read = vi.fn((current: MobxPool) => ({ selected: current.selection.size > 0 && current.selection.has('target') }))
  const view = createPoolProjection(pool, read)
  const subscribe = (wake = vi.fn()) => {
    const stop = view.subscribe(wake)
    cleanups.push(stop)
    return stop
  }
  return { pool, read, view, subscribe,
    change: (id: string | null) => pool.applyLocals({ selectedIssueId: id, coarseNow: 0 }, new Set(['selectedIssueId'])),
    observers: () => getObserverTree(pool.selection).observers?.length ?? 0,
  }
}

it('tracks the first snapshot once and shares one observer among all subscriptions', () => {
  const f = fixture()
  const first = f.view.getSnapshot()
  expect(f.view.getSnapshot()).toBe(first)
  expect(f.read).toHaveBeenCalledTimes(1)
  expect(f.observers()).toBe(1)
  const a = vi.fn(), b = vi.fn()
  const stopA = f.subscribe(a), stopB = f.subscribe(b)
  expect(f.read).toHaveBeenCalledTimes(1)
  f.change('target')
  const next = f.view.getSnapshot()
  expect(next).toEqual({ selected: true })
  expect(next).not.toBe(first)
  expect(f.view.getSnapshot()).toBe(next)
  expect(f.read).toHaveBeenCalledTimes(2)
  expect(a).toHaveBeenCalledTimes(1)
  expect(b).toHaveBeenCalledTimes(1)
  stopA()
  expect(f.observers()).toBe(1)
  f.change(null)
  expect(f.read).toHaveBeenCalledTimes(3)
  expect(a).toHaveBeenCalledTimes(1)
  expect(b).toHaveBeenCalledTimes(2)
  stopB()
  expect(f.observers()).toBe(0)
  f.change('target')
  expect(f.read).toHaveBeenCalledTimes(3)
})

it('retains the snapshot object when observed inputs change to an equal result', () => {
  const f = fixture()
  const wake = vi.fn()
  f.subscribe(wake)
  const first = f.view.getSnapshot()
  f.change('other')
  expect(f.read).toHaveBeenCalledTimes(2)
  expect(f.view.getSnapshot()).toBe(first)
  expect(wake).not.toHaveBeenCalled()
  f.pool.applyLocals({ selectedIssueId: 'other', coarseNow: 60_000 }, new Set(['coarseNow']))
  expect(f.view.getSnapshot()).toBe(first)
  expect(f.read).toHaveBeenCalledTimes(2)
})

it('publishes a real change between the first read and subscription exactly once', () => {
  const f = fixture()
  const first = f.view.getSnapshot()
  f.change('target')
  const wake = vi.fn()
  f.subscribe(wake)
  expect(f.view.getSnapshot()).toEqual({ selected: true })
  expect(f.view.getSnapshot()).not.toBe(first)
  expect(f.read).toHaveBeenCalledTimes(2)
  expect(wake).toHaveBeenCalledTimes(1)
})

it('re-arms after the last unsubscribe and preserves equal snapshot identity', () => {
  const f = fixture()
  const stop = f.subscribe()
  const first = f.view.getSnapshot()
  stop()
  expect(f.observers()).toBe(0)
  f.subscribe()
  expect(f.observers()).toBe(1)
  expect(f.view.getSnapshot()).toBe(first)
  expect(f.read).toHaveBeenCalledTimes(2)
})

it('publishes lazy reference initialization when subscribing before the first snapshot', () => {
  const f = fixture()
  const issue = { id: 'one', seq: 1, prefix: 'POD', title: 'Task one', stage: 'review',
    createdAt: '2026-01-01', updatedAt: '2026-01-01', archived: false, repoPath: '/r', deps: [] }
  f.pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'one', value: issue as never }] })
  const read = vi.fn((current: MobxPool) => current.references.read('POD-1'))
  const view = createPoolProjection(f.pool, read)
  const wake = vi.fn()
  cleanups.push(view.subscribe(wake))
  expect(view.getSnapshot()).toMatchObject({ title: 'Task one' })
  expect(wake).toHaveBeenCalledTimes(1)
  // The first read builds the reference index, which publishes its readiness.
  expect(read).toHaveBeenCalledTimes(2)
  f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'one', value: { ...issue, title: 'Changed' } as never }] })
  expect(view.getSnapshot()).toMatchObject({ title: 'Changed' })
  expect(read).toHaveBeenCalledTimes(3)
  expect(wake).toHaveBeenCalledTimes(2)
})

it('gives abandoned renders to the observer finalizer and re-arms a finalized view', () => {
  const register = vi.spyOn(_observerFinalizationRegistry, 'register')
  const unregister = vi.spyOn(_observerFinalizationRegistry, 'unregister')
  const f = fixture()
  const first = f.view.getSnapshot()
  const [target, held, token] = register.mock.calls.at(-1)!
  expect(target).toBe(f.view)
  expect(token).toBe(held)
  // Deterministically exercise the finalizer's disposal, without depending on GC timing.
  held.reaction!.dispose()
  held.reaction = null
  expect(f.observers()).toBe(0)
  f.change('target')
  const wake = vi.fn()
  f.subscribe(wake)
  expect(unregister).toHaveBeenCalledWith(token)
  expect(f.view.getSnapshot()).not.toBe(first)
  expect(f.view.getSnapshot()).toEqual({ selected: true })
  expect(f.read).toHaveBeenCalledTimes(2)
  expect(wake).toHaveBeenCalledTimes(1)
  f.change(null)
  expect(wake).toHaveBeenCalledTimes(2)
  expect(f.read).toHaveBeenCalledTimes(3)
})

it('rethrows reader errors through getSnapshot and recovers on a real input change', () => {
  const f = fixture()
  const failure = new Error('projection reader failed')
  const view = createPoolProjection(f.pool, (current) => {
    if (current.selection.has('target')) throw failure
    return { selected: false }
  })
  const wake = vi.fn()
  cleanups.push(view.subscribe(wake))
  const first = view.getSnapshot()
  f.change('target')
  expect(() => view.getSnapshot()).toThrow(failure)
  expect(wake).toHaveBeenCalledTimes(1)
  f.change(null)
  expect(view.getSnapshot()).toBe(first)
  expect(wake).toHaveBeenCalledTimes(2)
})
