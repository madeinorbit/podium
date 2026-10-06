import { compareDefault, compareIdentity, compareShallow, compareStructural, autorun, observable, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { cachedKey, type cachedGroup } from './cached'
import { workProbe } from './primitive-work.test.helpers'
import { EMPTY_OWN, type Attention } from './worklist/rollup'
import { LOADING } from './loading'
import './models'

// Capture the exact private comparers supplied by the models, while delegating
// all cachedGroup behavior unchanged. No test-only product exports are needed.
const modelComparers = vi.hoisted(() => new Map<string, (a: unknown, b: unknown) => boolean>())
vi.mock('./cached', async importOriginal => {
  const original = await importOriginal<typeof import('./cached')>()
  const capture: typeof cachedGroup = (group, compute, equals) => {
    if (equals) modelComparers.set(group, equals as (a: unknown, b: unknown) => boolean)
    return original.cachedGroup(group, compute, equals)
  }
  return { ...original, cachedGroup: capture }
})

type Change = 'row' | 'membership' | 'irrelevant'
const changes: Change[] = ['row', 'membership', 'irrelevant']
function counted<T>(values: T[], visit: () => void): T[] {
  return new Proxy(values, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) visit()
      return Reflect.get(target, key, receiver)
    },
  })
}
function compareArray(compare: (a: unknown, b: unknown) => boolean, count: number, change: Change) {
  const probe = workProbe()
  const before = Array.from({ length: count }, (_, index) => `seat-${index}`)
  const after = [...before]
  // MobX walks arrays backwards: a difference at zero is reached last.
  if (change === 'row') after[0] = 'changed-seat'
  if (change === 'membership') after.push('new-seat')
  const a = counted(before, () => probe.count('reads'))
  const b = counted(after, () => probe.count('reads'))
  const result = probe.measure(() => compare(a, b))
  expect(result.value).toBe(change === 'irrelevant')
  return result.work
}

describe('comparison primitive costs (128/512 compared elements)', () => {
  for (const [name, compare] of [
    ['compareStructural', compareStructural], ['compareShallow', compareShallow],
  ] as const) {
    it.each(changes)(name + ': %s', change => {
      const one = compareArray(compare, 128, change), four = compareArray(compare, 512, change)
      console.info(`[primitive bounds] ${name}/${change} ${JSON.stringify({ one, four })}`)
      expect(one.reads).toBe(change === 'membership' ? 0 : 256)
      expect(four.reads).toBe(change === 'membership' ? 0 : 1024)
    })
  }

  it.each(changes)('sameAttention: %s', change => {
    const compare = modelComparers.get('attention')!
    expect(compare).toBeTypeOf('function')
    const run = (count: number) => {
      const probe = workProbe()
      const ids = Array.from({ length: count }, (_, index) => `seat-${index}`), next = [...ids]
      if (change === 'row') next[0] = 'changed-seat'
      if (change === 'membership') next.push('new-seat')
      const attention = (values: string[]): Attention => ({
        ownAttention: EMPTY_OWN,
        aggregate: { ...EMPTY_OWN, sessionIds: counted(values, () => probe.count('reads')) },
      })
      const a = attention(ids), b = attention(next)
      const result = probe.measure(() => compare(a, b))
      expect(result.value).toBe(change === 'irrelevant')
      return result.work
    }
    const one = run(128), four = run(512)
    console.info(`[primitive bounds] sameAttention/${change} ${JSON.stringify({ one, four })}`)
    expect(one.reads).toBe(change === 'membership' ? 0 : 256)
    expect(four.reads).toBe(change === 'membership' ? 0 : 1024)
  })

  it.each([compareStructural, compareShallow, compareDefault, compareIdentity])('identity fast path does not read elements (%#)', compare => {
    const probe = workProbe(), array = counted(Array.from({ length: 512 }, (_, i) => i), () => probe.count('reads'))
    const result = probe.measure(() => compare(array, array))
    expect(result.value).toBe(true)
    expect(result.work.reads).toBe(0)
  })

  it('sameAttention skips shared roster arrays when only a scalar changes', () => {
    const probe = workProbe()
    const ids = counted(Array.from({ length: 512 }, (_, i) => `seat-${i}`), () => probe.count('reads'))
    const a: Attention = { ownAttention: EMPTY_OWN, aggregate: { ...EMPTY_OWN, sessionIds: ids } }
    const b: Attention = { ...a, aggregate: { ...a.aggregate, working: true } }
    const result = probe.measure(() => modelComparers.get('attention')!(a, b))
    expect(result.value).toBe(false)
    expect(result.work.reads).toBe(0)
  })

  it.each(changes)('sameVerdict and identity comparers stay flat with unrelated data: %s', change => {
    const run = (scale: number) => {
      const probe = workProbe()
      // Hold 1x/4x unrelated structures alive, never pass them to the helper.
      const unrelated = Array.from({ length: 128 * scale }, (_, i) => ({ id: i }))
      const row = { open: 'idle', finished: 'idle', working: false, workingSinceMs: null }
      const a = new Proxy(row, { get(target, key, receiver) { probe.count('reads'); return Reflect.get(target, key, receiver) } })
      const b = change === 'row' ? { ...row, working: true } : change === 'membership' ? undefined : { ...row }
      const result = probe.measure(() => ({
        verdict: modelComparers.get('verdict')!(a, b),
        identity: compareIdentity(a, b), default: compareDefault(a, b),
      }))
      expect(result.value.verdict).toBe(change === 'irrelevant')
      expect(result.value.identity).toBe(false)
      expect(result.value.default).toBe(false)
      expect(unrelated.length).toBe(128 * scale)
      return result.work
    }
    const one = run(1), four = run(4)
    console.info(`[primitive bounds] sameVerdict/${change} ${JSON.stringify({ one, four })}`)
    expect(four).toEqual(one)
    expect(modelComparers.get('verdict')!(LOADING, LOADING)).toBe(true)
    expect(modelComparers.get('verdict')!(LOADING, undefined)).toBe(false)
  })
})

it.each(changes)('cachedKey/keyedComputed only reruns the addressed key: %s', change => {
  const run = (scale: number) => {
    const probe = workProbe()
    const rows = observable.map<string, number>(Array.from({ length: 128 * scale }, (_, index) => [`key-${index}`, index] as const))
    const read = cachedKey('primitive', 'row', id => { probe.count('reads'); return rows.get(id) })
    const stops = [...rows.keys()].map(id => autorun(() => read(id)))
    try {
      const result = probe.measure(() => runInAction(() => {
        if (change === 'membership') rows.delete('key-0')
        else if (change === 'row') rows.set('key-0', -1)
        else rows.set('unobserved', -1)
      }))
      expect(read('key-0')).toBe(change === 'membership' ? undefined : change === 'row' ? -1 : 0)
      expect(result.work.reads).toBe(change === 'irrelevant' ? 0 : 1)
      return result.work
    } finally { for (const stop of stops) stop() }
  }
  const one = run(1), four = run(4)
  console.info(`[primitive bounds] cachedKey/${change} ${JSON.stringify({ one, four })}`)
  expect(four).toEqual(one)
})
