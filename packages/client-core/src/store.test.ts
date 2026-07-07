import { describe, expect, it, vi } from 'vitest'
import { createSubscriptionStore, shallowEqual } from './store'

describe('shallowEqual', () => {
  it('matches identical and shallow-equal objects', () => {
    const arr = [1, 2]
    expect(shallowEqual({ a: 1, b: arr }, { a: 1, b: arr })).toBe(true)
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(shallowEqual({ a: [1] }, { a: [1] })).toBe(false) // deep values differ by identity
    expect(shallowEqual(null, {})).toBe(false)
    expect(shallowEqual(1, 1)).toBe(true)
  })
})

describe('createSubscriptionStore', () => {
  it('publishes changed snapshots and notifies subscribers', () => {
    const store = createSubscriptionStore({ n: 1, s: 'x' })
    const seen: number[] = []
    store.subscribe(() => seen.push(store.getSnapshot().n))
    store.publish({ n: 2, s: 'x' })
    expect(seen).toEqual([2])
    expect(store.getSnapshot()).toEqual({ n: 2, s: 'x' })
  })

  it('keeps the OLD snapshot identity and stays silent on a shallow-equal publish', () => {
    const first = { n: 1, s: 'x' }
    const store = createSubscriptionStore(first)
    const listener = vi.fn()
    store.subscribe(listener)
    store.publish({ n: 1, s: 'x' }) // new object, same contents
    expect(listener).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toBe(first)
  })

  it('unsubscribe stops notifications; listeners may unsubscribe during notify', () => {
    const store = createSubscriptionStore({ n: 0 })
    const a = vi.fn()
    const offA = store.subscribe(() => {
      a()
      offA() // self-removal mid-notify must not break iteration
    })
    const b = vi.fn()
    store.subscribe(b)
    store.publish({ n: 1 })
    store.publish({ n: 2 })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
  })
})
