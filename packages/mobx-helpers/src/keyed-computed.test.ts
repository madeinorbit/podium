import { autorun, comparer, observable, onBecomeObserved, onBecomeUnobserved, runInAction, untracked } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { keyedComputed } from './keyed-computed'

describe('keyedComputed', () => {
  it('shares each observed key and releases it after the last reader', () => {
    const input = observable.box(1)
    const read = vi.fn((key: string) => ({ key, value: input.get() }))
    const memo = keyedComputed('shared', read)
    const first = autorun(() => memo('a'))
    const second = autorun(() => memo('a'))
    const other = autorun(() => memo('b'))
    expect(read.mock.calls.map(([key]) => key)).toEqual(['a', 'b'])
    first()
    runInAction(() => input.set(2))
    expect(read).toHaveBeenCalledTimes(4)
    second(); other()
    const fresh = autorun(() => memo('a'))
    expect(read).toHaveBeenCalledTimes(5)
    fresh()
  })

  it('creates no persistent entry on imperative, action or untracked reads', () => {
    const read = vi.fn((key: object) => ({ key }))
    const memo = keyedComputed('untracked', read)
    const key = {}
    expect(memo(key)).not.toBe(memo(key))
    runInAction(() => { expect(memo(key)).not.toBe(memo(key)) })
    const stop = autorun(() => untracked(() => memo(key)))
    stop()
    const observing = autorun(() => memo(key))
    expect(read).toHaveBeenCalledTimes(6)
    observing()
  })

  it('defaults to identity and only suppresses fresh results with an explicit comparer', () => {
    const input = observable.box(0)
    const fn = (_key: string) => { input.get(); return { same: true } }
    const identity = keyedComputed('identity', fn)
    const structural = keyedComputed('structural', fn, { equals: comparer.structural })
    const identityReader = vi.fn(() => identity('a'))
    const structuralReader = vi.fn(() => structural('a'))
    const stopIdentity = autorun(identityReader), stopStructural = autorun(structuralReader)
    runInAction(() => input.set(1))
    expect(identityReader).toHaveBeenCalledTimes(2)
    expect(structuralReader).toHaveBeenCalledTimes(1)
    stopIdentity(); stopStructural()
  })

  it('uses object identity as the key', () => {
    const read = vi.fn((key: { id: string }) => key.id)
    const memo = keyedComputed((key: { id: string }) => key.id, read)
    const one = { id: 'same' }, two = { id: 'same' }
    const stop = autorun(() => { memo(one); memo(one); memo(two) })
    expect(read).toHaveBeenCalledTimes(2)
    stop()
  })

  it('does not let an old reader erase a newer entry after clear', () => {
    const input = observable.box(1)
    const read = vi.fn((_key: string) => input.get())
    const memo = keyedComputed('clear', read)
    const old = autorun(() => memo('a'))
    memo.clear()
    const newer = autorun(() => memo('a'))
    old()
    const another = autorun(() => memo('a'))
    expect(read).toHaveBeenCalledTimes(2)
    newer(); another()
  })

  it('releases observable dependencies and captures arguments for a key only while observed', () => {
    const input = observable.box(1)
    const becameObserved = vi.fn(), becameUnobserved = vi.fn()
    const observed = onBecomeObserved(input, becameObserved)
    const unobserved = onBecomeUnobserved(input, becameUnobserved)
    const memo = keyedComputed('body', (_key: string, read: () => number) => read())
    const stop = autorun(() => memo('a', () => input.get()))
    expect(becameObserved).toHaveBeenCalledTimes(1)
    stop()
    expect(becameUnobserved).toHaveBeenCalledTimes(1)
    const other = autorun(() => expect(memo('a', () => 2)).toBe(2))
    other(); observed(); unobserved()
  })

  it('provides a public development assertion without retaining an untracked entry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const read = vi.fn((_key: string) => 1)
      const memo = keyedComputed('guarded', read, { requiresReaction: true })
      memo('a')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('outside a reactive context'))
      const stop = autorun(() => memo('a'))
      expect(read).toHaveBeenCalledTimes(2)
      stop()
    } finally { warn.mockRestore() }
  })
})
