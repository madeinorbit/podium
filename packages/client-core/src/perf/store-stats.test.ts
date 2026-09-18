import { asSessionId } from '@podium/model'
import { afterEach, expect, it } from 'vitest'
import { createSubscriptionStore } from '../store'
import { createSlicePublisher } from '../viewmodels/slices/publish'
import { beginSwitch, getRecentSwitchTraces, markSwitch, resetSwitchTraces } from './switch-trace'
import {
  bindStoreStatsOwner,
  markStoreStats,
  readStoreStats,
  recordIssueRowBuild,
  recordSliceDerivation,
  STORE_STATS_LIMITS,
  storeStats,
} from './store-stats'

afterEach(() => {
  resetSwitchTraces()
  storeStats.enable(false)
  storeStats.reset()
})

it('is off by default, preserves publication behavior, and counts only accepted publishes', () => {
  expect(readStoreStats().enabled).toBe(false)
  const owner = {}
  const store = createSubscriptionStore({ value: 0 }, undefined, owner)
  let wakes = 0
  store.subscribe(() => wakes++)
  store.publish({ value: 1 })
  expect(wakes).toBe(1)
  expect(readStoreStats().runtimes).toEqual([])
  storeStats.enable()
  store.publish({ value: 2 }, new Set(['value']))
  store.publish({ value: 2 })
  expect(wakes).toBe(2)
  expect(readStoreStats().runtimes[0]).toMatchObject({
    publishes: 1,
    subscriberWakes: 1,
    selectorRuns: 0,
    reactCommits: 0,
  })
  expect(readStoreStats().publishes[0]?.changedKeys).toEqual(['value'])
  const copy = readStoreStats()
  copy.runtimes[0]!.publishes = 100
  expect(readStoreStats().runtimes[0]?.publishes).toBe(1)
  storeStats.enable(false)
  store.publish({ value: 3 })
  expect(wakes).toBe(3)
  expect(readStoreStats().runtimes[0]?.publishes).toBe(1)
})

it('retains reentrant publish ordering, listener mutation and exceptions', () => {
  storeStats.enable()
  const store = createSubscriptionStore(0)
  const calls: string[] = []
  let off = () => {}
  store.subscribe(() => {
    calls.push(`a${store.getSnapshot()}`)
    if (store.getSnapshot() === 1) {
      off()
      store.publish(2)
    }
  })
  off = store.subscribe(() => calls.push(`b${store.getSnapshot()}`))
  store.publish(1)
  expect(calls).toEqual(['a1', 'a2', 'b2'])
  expect(readStoreStats().publishes.map((p) => p.subscriberWakes)).toEqual([2, 1])
  store.subscribe(() => {
    throw new Error('listener')
  })
  expect(() => store.publish(3)).toThrow('listener')
  expect(store.getSnapshot()).toBe(3)
  expect(readStoreStats().publishes.at(-1)?.subscriberWakes).toBe(2)
})

it('correlates actual slice work with switch IDs and checkpoints without metadata or payloads', () => {
  storeStats.enable()
  const owner = {}
  const replica = {}
  bindStoreStatsOwner(replica, owner)
  const store = createSubscriptionStore({ draft: 'secret draft' }, undefined, owner)
  const publisher = createSlicePublisher(store.getSnapshot, owner)
  const slice = { name: 'worklist', derive: (s: { draft: string }) => s.draft.length }
  const sid = asSessionId('session-private')
  beginSwitch({ sessionId: sid })
  store.subscribe(() => {
    publisher.read(slice)
    publisher.read(slice)
  })
  store.publish({ draft: 'secret prompt' }, new Set(['draft']))
  recordIssueRowBuild(replica)
  markSwitch(sid, 'chat:first-paint', { prompt: 'secret metadata' })
  markSwitch(sid, 'chat:interactable')
  const report = readStoreStats()
  expect(report.windows[0]).toMatchObject({
    ended: true,
    switchId: getRecentSwitchTraces()[0]?.switchId,
  })
  expect(report.windows[0]?.runtimes[0]).toMatchObject({
    publishes: 1,
    subscriberWakes: 1,
    rowBuilds: 1,
    slices: { worklist: 1 },
  })
  expect(report.windows[0]?.marks[0]?.counts).toMatchObject({
    publishes: 1,
    sliceDerivations: 1,
    rowBuilds: 1,
  })
  expect(JSON.stringify(report)).not.toMatch(/secret|session-private|prompt/)
  expect(publisher.derivations()).toEqual({ worklist: 1 })
})

it('bounds every accumulating dimension and exposes dropped data', () => {
  storeStats.enable()
  for (let w = 0; w <= STORE_STATS_LIMITS.windows; w++) {
    const id = storeStats.begin('feed')
    storeStats.end(id)
  }
  storeStats.begin('feed')
  for (let r = 0; r <= STORE_STATS_LIMITS.runtimes; r++) createSubscriptionStore(0).publish(1)
  const owner = {}
  const store = createSubscriptionStore(0, undefined, owner)
  for (let p = 0; p <= STORE_STATS_LIMITS.publishes; p++) store.publish(p + 1)
  for (let n = 0; n <= STORE_STATS_LIMITS.names; n++) recordSliceDerivation(owner, `slice${n}`)
  for (let m = 0; m <= STORE_STATS_LIMITS.marks; m++) markStoreStats('point')
  const report = readStoreStats()
  expect(report.runtimes).toHaveLength(STORE_STATS_LIMITS.runtimes)
  expect(report.windows).toHaveLength(STORE_STATS_LIMITS.windows)
  expect(report.publishes).toHaveLength(STORE_STATS_LIMITS.publishes)
  expect(Object.keys(report.runtimes.at(-1)!.slices)).toHaveLength(STORE_STATS_LIMITS.names)
  expect(report.windows.at(-1)?.marks).toHaveLength(STORE_STATS_LIMITS.marks)
  expect(report.dropped).toBeGreaterThan(0)
  storeStats.reset()
  expect(readStoreStats()).toMatchObject({
    enabled: true,
    runtimes: [],
    windows: [],
    publishes: [],
    dropped: 0,
  })
})

it('measures disabled and enabled boundary overhead against the original loop', () => {
  const iterations = 20_000
  const rounds = 7
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
  const samples: Record<string, number[]> = { original: [], disabled: [], enabled: [] }
  for (let round = 0; round < rounds; round++) {
    // Rotate order to reduce warm-up/order bias. This is a local microbenchmark,
    // not an end-to-end latency budget or a timing assertion on a shared host.
    const modes = ['original', 'disabled', 'enabled'] as const
    for (let offset = 0; offset < modes.length; offset++) {
      const mode = modes[(round + offset) % modes.length]!
      storeStats.reset()
      storeStats.enable(mode === 'enabled')
      if (mode === 'enabled') storeStats.begin('feed')
      let wakes = 0
      const listeners = new Set<() => void>([() => wakes++, () => wakes++])
      let snapshot = 0
      const store = createSubscriptionStore<number>(0, Object.is)
      for (const l of listeners) store.subscribe(l)
      const original = (next: number) => {
        if (Object.is(snapshot, next)) return
        snapshot = next
        for (const l of [...listeners]) l()
      }
      const publish = mode === 'original' ? original : store.publish
      const start = performance.now()
      for (let i = 1; i <= iterations; i++) publish(i)
      samples[mode]!.push(((performance.now() - start) * 1_000) / iterations)
      expect(wakes).toBe(iterations * 2)
      if (mode === 'enabled')
        expect(readStoreStats().runtimes[0]).toMatchObject({
          publishes: iterations,
          subscriberWakes: iterations * 2,
        })
      else expect(readStoreStats().runtimes).toHaveLength(0)
    }
  }
  console.info(
    '[store-stats overhead microseconds/publish, 2 subscribers, median of 7 x 20000]',
    JSON.stringify(Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, median(v)]))),
  )
})
