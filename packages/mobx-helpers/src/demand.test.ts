import { autorun, computed, createAtom, runInAction, untracked } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { createDemandAtoms } from './demand'

vi.mock('mobx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mobx')>()
  return { ...actual, createAtom: vi.fn(actual.createAtom) }
})

describe('createDemandAtoms', () => {
  it('allocates nothing for imperative probes and preserves another tracked reader', () => {
    const observed = vi.fn(), released = vi.fn()
    const demand = createDemandAtoms<string>((key) => key, { onObserved: observed, onUnobserved: released })
    vi.mocked(createAtom).mockClear()
    expect(demand.observe('absent')).toBe(false)
    runInAction(() => { expect(demand.observe('action')).toBe(false) })
    untracked(() => { expect(demand.observe('untracked')).toBe(false) })
    expect(createAtom).not.toHaveBeenCalled()
    expect(demand.size).toBe(0)
    expect(observed).not.toHaveBeenCalled()
    const stop = autorun(() => demand.observe('live'))
    try {
      expect(createAtom).toHaveBeenCalledTimes(1)
      const atom = demand.get('live')
      vi.mocked(createAtom).mockClear()
      for (let at = 0; at < 100; at++) {
        expect(demand.observe(`missing-${at}`)).toBe(false)
        expect(demand.observe('live')).toBe(false)
      }
      expect(createAtom).not.toHaveBeenCalled()
      expect(demand.get('live')).toBe(atom)
      expect([...demand.keys()]).toEqual(['live'])
      expect(released).not.toHaveBeenCalled()
    } finally { stop() }
    expect(demand.size).toBe(0)
    expect(released.mock.calls).toEqual([['live']])
  })

  it('shares demand, notifies only its key, and releases after the last reader', () => {
    const observed = vi.fn(), released = vi.fn()
    const demand = createDemandAtoms<string>((key) => key, { onObserved: observed, onUnobserved: released })
    const firstRead = vi.fn(() => demand.observe('a')), secondRead = vi.fn(() => demand.observe('a')),
      otherRead = vi.fn(() => demand.observe('b'))
    const first = autorun(firstRead), second = autorun(secondRead), other = autorun(otherRead)
    try {
      expect(observed.mock.calls).toEqual([['a'], ['b']])
      first()
      expect(released).not.toHaveBeenCalled()
      runInAction(() => demand.get('a')!.reportChanged())
      expect(firstRead).toHaveBeenCalledTimes(1)
      expect(secondRead).toHaveBeenCalledTimes(2)
      expect(otherRead).toHaveBeenCalledTimes(1)
      second()
      expect([...demand.keys()]).toEqual(['b'])
      expect(released.mock.calls).toEqual([['a']])
      const reopen = autorun(() => demand.observe('a'))
      reopen()
      expect(observed.mock.calls).toEqual([['a'], ['b'], ['a']])
    } finally { first(); second(); other() }
    expect(demand.size).toBe(0)
    expect(released.mock.calls).toEqual([['a'], ['a'], ['b']])
  })

  it('does not let a disposed observer release a replacement key', () => {
    const released = vi.fn()
    const demand = createDemandAtoms<string>((key) => key, { onUnobserved: released })
    const old = autorun(() => demand.observe('a'))
    const previous = demand.get('a')
    demand.clear()
    const current = autorun(() => demand.observe('a'))
    try {
      expect(demand.get('a')).not.toBe(previous)
      old()
      expect(demand.has('a')).toBe(true)
      expect(released).not.toHaveBeenCalled()
    } finally { old(); current() }
    expect(released.mock.calls).toEqual([['a']])
  })

  it('borrows the owner atom without a duplicate and detaches its release hook on clear', () => {
    const atom = createAtom('owner'), observed = vi.fn(), released = vi.fn()
    const demand = createDemandAtoms<string>((key) => key, {
      borrowAtom: () => atom, onObserved: observed, onUnobserved: released,
    })
    vi.mocked(createAtom).mockClear()
    const owner = autorun(() => atom.reportObserved())
    const reader = autorun(() => demand.observe('field'))
    try {
      expect(demand.get('field')).toBe(atom)
      expect(createAtom).not.toHaveBeenCalled()
      reader()
      expect(demand.has('field')).toBe(true)
      owner()
      expect(demand.size).toBe(0)
      expect(released.mock.calls).toEqual([['field']])
      const fresh = autorun(() => demand.observe('field'))
      demand.clear()
      fresh()
      expect(released).toHaveBeenCalledTimes(1)
      expect(observed).toHaveBeenCalledTimes(2)
    } finally { reader(); owner(); demand.clear() }
  })

  it('does not retain demand for a suspended computed', () => {
    const observed = vi.fn()
    const demand = createDemandAtoms<string>((key) => key, { onObserved: observed })
    const value = computed(() => demand.observe('suspended'))
    expect(value.get()).toBe(false)
    expect(demand.size).toBe(0)
    expect(observed).not.toHaveBeenCalled()
  })
})
