import { createRequire } from 'node:module'
import { autorun, compareStructural, configure, type IObservableValue, observable, onBecomeObserved, onBecomeUnobserved, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { lazy, lazyKeptCount } from './lazy'

/** Counts the reactions currently watching a source, through public MobX only. */
function watchers(source: IObservableValue<unknown>): () => number {
  let count = 0
  onBecomeObserved(source, () => { count++ })
  onBecomeUnobserved(source, () => { count-- })
  return () => count
}

class Order {
  runs = 0
  constructor(readonly price: IObservableValue<number>, readonly quantity = 2) {}
  @lazy get total() {
    this.runs++
    return this.price.get() * this.quantity
  }
}

describe('lazy', () => {
  it('runs nothing and adds nothing at construction', () => {
    const order = new Order(observable.box(3))
    expect(order.runs).toBe(0)
    expect(Object.getOwnPropertySymbols(order)).toEqual([])
    expect(Object.keys(order).sort()).toEqual(['price', 'quantity', 'runs'])
  })

  it('recomputes each read outside a reaction and keeps nothing', () => {
    const price = observable.box(3)
    const watching = watchers(price)
    const order = new Order(price)
    expect([order.total, order.total]).toEqual([6, 6])
    expect(order.runs).toBe(2)
    runInAction(() => { void order.total; void order.total })
    expect(order.runs).toBe(4)
    expect(lazyKeptCount(order)).toBe(0)
    expect(Object.getOwnPropertySymbols(order)).toEqual([])
    expect(watching()).toBe(0)
  })

  it('stays quiet under computedRequiresReaction for a read outside a reaction', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    configure({ computedRequiresReaction: true })
    try {
      expect(new Order(observable.box(1)).total).toBe(2)
      expect(warn).not.toHaveBeenCalled()
    } finally { warn.mockRestore(); configure({ computedRequiresReaction: false }) }
  })

  it('computes once inside a reaction and keeps one slot', () => {
    const order = new Order(observable.box(3))
    const other = observable.box(0)
    const seen: number[] = []
    const stop = autorun(() => { other.get(); seen.push(order.total, order.total) })
    try {
      expect(order.runs).toBe(1)
      expect(lazyKeptCount(order)).toBe(1)
      runInAction(() => other.set(1))
      expect(seen).toEqual([6, 6, 6, 6])
      expect(order.runs).toBe(1)
      // A read outside the reaction while it is kept uses the kept value.
      expect(order.total).toBe(6)
      expect(order.runs).toBe(1)
    } finally { stop() }
  })

  it('recomputes when its data changes', () => {
    const price = observable.box(3)
    const order = new Order(price)
    const seen: number[] = []
    const stop = autorun(() => { seen.push(order.total) })
    try {
      runInAction(() => price.set(5))
      expect(seen).toEqual([6, 10])
      expect(order.runs).toBe(2)
    } finally { stop() }
  })

  it('passes equals through: a structurally equal answer does not notify', () => {
    class Parity {
      runs = 0
      constructor(readonly n: IObservableValue<number>) {}
      @lazy({ equals: compareStructural }) get odd() {
        this.runs++
        return [this.n.get() % 2]
      }
      @lazy get oddByIdentity() {
        return [this.n.get() % 2]
      }
    }
    const n = observable.box(1)
    const parity = new Parity(n)
    const structural = vi.fn(() => parity.odd)
    const identity = vi.fn(() => parity.oddByIdentity)
    const stops = [autorun(structural), autorun(identity)]
    try {
      runInAction(() => n.set(3))
      expect(parity.runs).toBe(2)
      expect(structural).toHaveBeenCalledTimes(1)
      expect(identity).toHaveBeenCalledTimes(2)
    } finally { for (const stop of stops) stop() }
  })

  it('drops the slot and stops watching its data when the last reaction leaves', () => {
    const price = observable.box(3)
    const watching = watchers(price)
    const order = new Order(price)
    const first = autorun(() => order.total)
    const second = autorun(() => order.total)
    expect(watching()).toBe(1)
    first()
    expect(lazyKeptCount(order)).toBe(1)
    second()
    expect(lazyKeptCount(order)).toBe(0)
    expect(watching()).toBe(0)
    // The next watched read starts a fresh computed.
    const again = autorun(() => order.total)
    expect(order.runs).toBe(2)
    expect(lazyKeptCount(order)).toBe(1)
    again()
    expect(lazyKeptCount(order)).toBe(0)
  })

  it('reuses a slot re-observed in one action, then drops and re-creates it independently', () => {
    const price = observable.box(3)
    const watching = watchers(price)
    const order = new Order(price)
    const other = new Order(price, 3)
    let stop = autorun(() => order.total)
    const stopOther = autorun(() => other.total)
    try {
      runInAction(() => {
        stop()
        stop = autorun(() => order.total)
        expect(lazyKeptCount(order)).toBe(1)
        expect(order.runs).toBe(1)
      })
      expect(watching()).toBe(1)
      stop()
      expect(lazyKeptCount(order)).toBe(0)
      expect(lazyKeptCount(other)).toBe(1)
      stop = autorun(() => order.total)
      expect(order.runs).toBe(2)
      expect(lazyKeptCount(order)).toBe(1)
      stop()
      expect(lazyKeptCount(order)).toBe(0)
      expect(lazyKeptCount(other)).toBe(1)
    } finally { stop(); stopOther() }
    expect(lazyKeptCount(other)).toBe(0)
    expect(watching()).toBe(0)
  })

  it('keeps the slot until the end of the action in which the last reaction left', () => {
    const order = new Order(observable.box(3))
    const stop = autorun(() => order.total)
    runInAction(() => {
      stop()
      expect(lazyKeptCount(order)).toBe(1)
      expect(order.total).toBe(6)
      expect(order.runs).toBe(1)
    })
    expect(lazyKeptCount(order)).toBe(0)
  })

  it('works on a subclass, with separate slots for an override that reads super', () => {
    class Discounted extends Order {
      @lazy override get total() {
        return super.total - 1
      }
      @lazy get label() {
        return `${this.total} for ${this.quantity}`
      }
    }
    const price = observable.box(3)
    const watching = watchers(price)
    const order = new Discounted(price)
    const seen: string[] = []
    const stop = autorun(() => { seen.push(order.label) })
    expect(seen).toEqual(['5 for 2'])
    expect(lazyKeptCount(order)).toBe(3)
    runInAction(() => price.set(4))
    expect(seen).toEqual(['5 for 2', '7 for 2'])
    expect(order.runs).toBe(2)
    stop()
    expect(lazyKeptCount(order)).toBe(0)
    expect(watching()).toBe(0)
    expect(order.total).toBe(7)
  })

  it('refuses a legacy decorator call', () => {
    expect(() => (lazy as unknown as (...args: unknown[]) => unknown)({}, 'total', {})).toThrow(/standard decorators/)
  })

  it('costs nothing per unread object over a plain class', () => {
    // Bun's own require: the test runner's module graph does not know bun: modules.
    const { heapStats } = createRequire(import.meta.url)('bun:jsc') as { heapStats(): { heapSize: number } }
    const gc = () => (globalThis as unknown as { Bun: { gc(force: boolean): void } }).Bun.gc(true)
    class Plain {
      constructor(readonly a: number, readonly b: number) {}
      get sum() { return this.a + this.b }
      get product() { return this.a * this.b }
      get label() { return `${this.a}:${this.b}` }
    }
    class Lazy {
      constructor(readonly a: number, readonly b: number) {}
      @lazy get sum() { return this.a + this.b }
      @lazy get product() { return this.a * this.b }
      @lazy get label() { return `${this.a}:${this.b}` }
    }
    const N = 20_000
    const heap = () => { gc(); return heapStats().heapSize }
    // Every measured object stays alive to the end, so a measurement only ever
    // sees the objects it made and the garbage collector frees only temporaries
    // (the computeds a read outside a reaction creates and drops).
    const alive: object[][] = []
    const bytesPerObject = (make: (i: number) => object, read: boolean) => {
      const before = heap()
      const objects = Array.from({ length: N }, (_, i) => make(i))
      if (read) for (const object of objects) void (object as Plain).sum
      alive.push(objects)
      return (heap() - before) / N
    }
    const extra: number[] = []
    for (let round = 0; round < 5; round++) {
      const plain = bytesPerObject(i => new Plain(i, 2), false)
      const unread = bytesPerObject(i => new Lazy(i, 2), false)
      const readOutside = bytesPerObject(i => new Lazy(i, 2), true)
      expect(plain).toBeGreaterThan(16)
      extra.push(Math.max(Math.abs(unread - plain), Math.abs(readOutside - plain)))
    }
    extra.sort((x, y) => x - y)
    // Median over interleaved rounds; a slot holder or a kept computed would be ~100+ bytes.
    expect(extra[2]).toBeLessThan(4)
    expect(alive).toHaveLength(15)
  })
})
