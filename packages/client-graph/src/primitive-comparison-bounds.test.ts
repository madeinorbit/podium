import {
  autorun,
  compareDefault,
  compareIdentity,
  compareShallow,
  compareStructural,
  observable,
  runInAction,
} from 'mobx'
import { describe, expect, it } from 'vitest'
import { cachedKey } from './cached'
import { LOADING } from './loading'
import { workProbe } from './primitive-work.test.helpers'

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
    ['compareStructural', compareStructural],
    ['compareShallow', compareShallow],
  ] as const) {
    it.each(changes)(name + ': %s', (change) => {
      const one = compareArray(compare, 128, change),
        four = compareArray(compare, 512, change)
      console.info(`[primitive bounds] ${name}/${change} ${JSON.stringify({ one, four })}`)
      expect(one.reads).toBe(change === 'membership' ? 0 : 256)
      expect(four.reads).toBe(change === 'membership' ? 0 : 1024)
    })
  }

  it.each([
    compareStructural,
    compareShallow,
    compareDefault,
    compareIdentity,
  ])('identity fast path does not read elements (%#)', (compare) => {
    const probe = workProbe(),
      array = counted(
        Array.from({ length: 512 }, (_, i) => i),
        () => probe.count('reads'),
      )
    const result = probe.measure(() => compare(array, array))
    expect(result.value).toBe(true)
    expect(result.work.reads).toBe(0)
  })

  it.each(changes)('identity and default comparers stay flat with unrelated data: %s', (change) => {
    const run = (scale: number) => {
      const probe = workProbe()
      // Hold 1x/4x unrelated structures alive, never pass them to the helper.
      const unrelated = Array.from({ length: 128 * scale }, (_, i) => ({ id: i }))
      const row = { open: 'idle', finished: 'idle', working: false, workingSinceMs: null }
      const a = new Proxy(row, {
        get(target, key, receiver) {
          probe.count('reads')
          return Reflect.get(target, key, receiver)
        },
      })
      const b =
        change === 'row'
          ? { ...row, working: true }
          : change === 'membership'
            ? undefined
            : { ...row }
      const result = probe.measure(() => ({
        identity: compareIdentity(a, b),
        default: compareDefault(a, b),
      }))
      expect(result.value.identity).toBe(false)
      expect(result.value.default).toBe(false)
      expect(unrelated.length).toBe(128 * scale)
      return result.work
    }
    const one = run(1),
      four = run(4)
    console.info(`[primitive bounds] identity/${change} ${JSON.stringify({ one, four })}`)
    expect(four).toEqual(one)
    expect(compareIdentity(LOADING, LOADING)).toBe(true)
    expect(compareIdentity(LOADING, undefined)).toBe(false)
  })
})

it.each(changes)('cachedKey/keyedComputed only reruns the addressed key: %s', (change) => {
  const run = (scale: number) => {
    const probe = workProbe()
    const rows = observable.map<string, number>(
      Array.from({ length: 128 * scale }, (_, index) => [`key-${index}`, index] as const),
    )
    const read = cachedKey('primitive', 'row', (id) => {
      probe.count('reads')
      return rows.get(id)
    })
    const stops = [...rows.keys()].map((id) => autorun(() => read(id)))
    try {
      const result = probe.measure(() =>
        runInAction(() => {
          if (change === 'membership') rows.delete('key-0')
          else if (change === 'row') rows.set('key-0', -1)
          else rows.set('unobserved', -1)
        }),
      )
      expect(read('key-0')).toBe(change === 'membership' ? undefined : change === 'row' ? -1 : 0)
      expect(result.work.reads).toBe(change === 'irrelevant' ? 0 : 1)
      return result.work
    } finally {
      for (const stop of stops) stop()
    }
  }
  const one = run(1),
    four = run(4)
  console.info(`[primitive bounds] cachedKey/${change} ${JSON.stringify({ one, four })}`)
  expect(four).toEqual(one)
})
