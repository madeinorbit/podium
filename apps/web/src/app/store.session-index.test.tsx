import type { SessionMeta } from '@podium/model'
import { asSessionId, asUserId } from '@podium/model'
import { asClientPrincipal } from '@podium/client-core/principal'
import { readStoreStats, storeStats } from '@podium/client-core/perf'
import { createSubscriptionStore, sessionById } from '@podium/client-core/store'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Profiler, type ReactNode } from 'react'
import type { Store } from './store'

const fixture = vi.hoisted(() => ({ handle: null as unknown }))
// The provider imports the implementation directly inside client-core.
vi.mock('../../../../packages/client-core/src/engine/runtime', () => ({
  createClientRuntime: () => fixture.handle,
}))
vi.mock('./trpc', () => ({ makeTrpc: () => ({}) }))
const { StoreProvider, useSession, useStoreSelector } = await import('./store')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  cleanup()
  storeStats.enable(false)
  storeStats.reset()
  vi.restoreAllMocks()
})

function row(id: string): SessionMeta {
  return { sessionId: asSessionId(id), name: id } as SessionMeta
}
function mount(sessions: SessionMeta[], children: ReactNode) {
  const owner = { start() {}, dispose() {}, destroy() {} }
  const store = createSubscriptionStore({ sessions, coarseNow: 0 } as Store, undefined, owner)
  fixture.handle = Object.assign(owner, store)
  const view = render(
    <StoreProvider
      principal={asClientPrincipal(asUserId('test'))}
      config={{ httpOrigin: 'http://test', wsClientUrl: 'ws://test' }}
      onFatalError={() => {}}
      createReplicaFn={() => { throw new Error('mock runtime') }}
    >{children}</StoreProvider>,
  )
  return { store, view }
}
const counts = () => readStoreStats().runtimes.reduce((sum, c) => ({
  publishes: sum.publishes + c.publishes,
  wakes: sum.wakes + c.subscriberWakes,
  selectors: sum.selectors + c.selectorRuns,
  builds: sum.builds + (c.slices.sessionById ?? 0),
}), { publishes: 0, wakes: 0, selectors: 0, builds: 0 })

it('A/B: unrelated deltas remove lookup comparisons, not reader fan-out', () => {
  const results = []
  for (const legacy of [true, false]) {
    storeStats.reset()
    storeStats.enable()
    let comparisons = 0
    let commits = 0
    const sessions = Array.from({ length: 256 }, (_, i) => row(`s${i}`))
    // Instrument the COLLECTION, not the legacy selector: reverting useSession
    // to find also moves this counter and fails the new-arm assertion.
    const watch = (rows: SessionMeta[]) => vi.spyOn(rows, 'find').mockImplementation((predicate, thisArg) =>
      Array.prototype.find.call(rows, (value: SessionMeta, index: number) => {
        comparisons++
        return predicate.call(thisArg, value, index, rows)
      }),
    )
    watch(sessions)
    const id = asSessionId('s255')
    function LegacyReader() {
      const selected = useStoreSelector((s) => s.sessions.find((s) => s.sessionId === id))
      return <span>{selected?.name}</span>
    }
    function IndexedReader() {
      const selected = useSession(id)
      return <span>{selected?.name}</span>
    }
    const Reader = legacy ? LegacyReader : IndexedReader
    const { store, view } = mount(sessions,
      <Profiler id="readers" onRender={() => commits++}>
        {Array.from({ length: 32 }, (_, i) => <Reader key={i} />)}
      </Profiler>,
    )
    expect(counts().builds).toBe(legacy ? 0 : 1)
    storeStats.reset()
    comparisons = 0
    commits = 0
    const window = storeStats.begin('feed')
    for (let coarseNow = 1; coarseNow <= 3; coarseNow++) {
      act(() => store.publish({ ...store.getSnapshot(), coarseNow }, new Set(['coarseNow'])))
    }
    storeStats.end(window)
    const unrelated = { ...counts(), comparisons, commits }
    expect(unrelated).toEqual({
      publishes: 3, wakes: 96, selectors: 96, builds: 0,
      comparisons: legacy ? 24576 : 0, commits: 0,
    })
    expect(view.container.textContent).toBe('s255'.repeat(32))
    storeStats.reset()
    comparisons = 0
    // New collection, same rows: one shared rebuild, zero reader commits.
    const changed = [...sessions]
    watch(changed)
    act(() => store.publish({ ...store.getSnapshot(), sessions: changed }, new Set(['sessions'])))
    const replaced = { ...counts(), comparisons, commits }
    expect(replaced).toEqual({
      publishes: 1, wakes: 32, selectors: 32, builds: legacy ? 0 : 1,
      comparisons: legacy ? 8192 : 0, commits: 0,
    })
    expect(view.container.textContent).toBe('s255'.repeat(32))
    results.push({ legacy, unrelated, replaced })
    view.unmount()
  }
  console.info('session readers A/B (32 readers, 256 sessions, 3 unrelated deltas)', results)
})

it('useSession preserves rows across replacement and observes missing/reappearing effective rows', () => {
  const a = row('a')
  const b = row('b')
  const observed: Array<SessionMeta | undefined> = []
  function Reader() {
    const selected = useSession(asSessionId('a'))
    observed.push(selected)
    return <span>{selected?.name ?? 'missing'}</span>
  }
  const { store, view } = mount([a, b], <Reader />)
  const publish = (sessions: SessionMeta[]) => act(() => store.publish({ ...store.getSnapshot(), sessions }))
  expect(observed).toEqual([a])
  publish([a, { ...b, name: 'changed' }])
  expect(observed).toEqual([a])
  publish([b])
  expect(view.container.textContent).toBe('missing')
  publish([a, b])
  expect(observed).toEqual([a, undefined, a])
  const optimistic = { ...a, name: 'optimistic' }
  publish([optimistic, b])
  expect(observed.at(-1)).toBe(optimistic)
  expect(view.container.textContent).toBe('optimistic')
  publish([])
  expect(view.container.textContent).toBe('missing')
})

it('indexes keep first-match semantics, exact row references, and separate collection identities', () => {
  const first = row('a')
  const duplicate = { ...first, name: 'later' }
  const sessions = [first, duplicate]
  expect(sessionById(sessions).get('a')).toBe(first)
  expect(sessionById(sessions)).toBe(sessionById(sessions))
  expect(sessionById([...sessions])).not.toBe(sessionById(sessions))
  expect(sessionById([]).get('a')).toBeUndefined()
})
