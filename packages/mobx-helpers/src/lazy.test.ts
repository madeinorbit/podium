import { createRequire } from 'node:module'
import { autorun, compareStructural, configure, type IObservableValue, observable, onBecomeObserved, onBecomeUnobserved, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import { lazy, lazyKeptCount } from './lazy'

/** Lets the current synchronous code finish, and with it the release of held fields. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

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

  it('works a field out once per action and keeps nothing after it', async () => {
    const price = observable.box(3)
    const watching = watchers(price)
    const order = new Order(price)
    runInAction(() => {
      expect([order.total, order.total]).toEqual([6, 6])
      expect(lazyKeptCount(order)).toBe(1)
    })
    expect(order.runs).toBe(1)
    // MobX's own batch cache, as for @computed: the data is never reported watched.
    expect(watching()).toBe(0)
    runInAction(() => { void order.total; void order.total })
    expect(order.runs).toBe(2)
    await settle()
    expect(lazyKeptCount(order)).toBe(0)
    expect(Object.getOwnPropertySymbols(order)).toEqual([])
    expect(watching()).toBe(0)
  })

  it('works a field out once in synchronous code outside an action, then lets go of its data', async () => {
    const price = observable.box(3)
    const watching = watchers(price)
    const order = new Order(price)
    expect([order.total, order.total, order.total]).toEqual([6, 6, 6])
    expect(order.runs).toBe(1)
    expect(lazyKeptCount(order)).toBe(1)
    expect(watching()).toBe(1)
    await settle()
    expect(lazyKeptCount(order)).toBe(0)
    expect(Object.getOwnPropertySymbols(order)).toEqual([])
    expect(watching()).toBe(0)
    expect(order.total).toBe(6)
    expect(order.runs).toBe(2)
  })

  it('answers a changed field freshly, with one extra computation', async () => {
    const price = observable.box(3)
    const order = new Order(price)
    runInAction(() => {
      expect(order.total).toBe(6)
      price.set(5)
      expect([order.total, order.total]).toEqual([10, 10])
    })
    expect(order.runs).toBe(2)
    expect([order.total, order.total]).toEqual([10, 10])
    expect(order.runs).toBe(3)
    runInAction(() => price.set(7))
    expect([order.total, order.total]).toEqual([14, 14])
    expect(order.runs).toBe(4)
    await settle()
  })

  it('reads after an action in the same code once more, then from the cache', async () => {
    const order = new Order(observable.box(3))
    runInAction(() => { void order.total })
    expect([order.total, order.total]).toEqual([6, 6])
    expect(order.runs).toBe(2)
    await settle()
    expect(lazyKeptCount(order)).toBe(0)
  })

  it('turns a held field into a watched slot when a reaction starts reading it', async () => {
    const price = observable.box(3)
    const watching = watchers(price)
    const order = new Order(price)
    const seen: number[] = []
    expect(order.total).toBe(6)
    const stop = autorun(() => { seen.push(order.total) })
    let stopInAction = () => {}
    const other = new Order(price, 3)
    runInAction(() => {
      expect(other.total).toBe(9)
      stopInAction = autorun(() => { seen.push(other.total) })
    })
    try {
      expect([order.runs, other.runs]).toEqual([1, 1])
      await settle()
      expect([lazyKeptCount(order), lazyKeptCount(other)]).toEqual([1, 1])
      runInAction(() => price.set(4))
      expect(seen).toEqual([6, 9, 8, 12])
      expect([order.runs, other.runs]).toEqual([2, 2])
    } finally { stop(); stopInAction() }
    expect([lazyKeptCount(order), lazyKeptCount(other)]).toEqual([0, 0])
    expect(watching()).toBe(0)
  })

  it('lets go of every field read in one handler in one pass', async () => {
    await settle()
    const queued = vi.spyOn(globalThis, 'queueMicrotask')
    try {
      class Line extends Order {
        @lazy get label() { return `${this.quantity} at ${this.price.get()}` }
      }
      const price = observable.box(3)
      const watching = watchers(price)
      const lines = [1, 2, 3, 4].map(quantity => new Line(price, quantity))
      expect(lines.map(line => `${line.label} = ${line.total}`)).toEqual(['1 at 3 = 3', '2 at 3 = 6', '3 at 3 = 9', '4 at 3 = 12'])
      expect(lines.map(line => lazyKeptCount(line))).toEqual([2, 2, 2, 2])
      expect(watching()).toBe(1)
      expect(queued).toHaveBeenCalledTimes(1)
      await settle()
      expect(queued).toHaveBeenCalledTimes(1)
      expect(lines.map(line => lazyKeptCount(line))).toEqual([0, 0, 0, 0])
      expect(watching()).toBe(0)
    } finally { queued.mockRestore() }
  })

  it('releases a held field with a custom equals without calling it on the released value', async () => {
    class Box {
      constructor(readonly n: IObservableValue<number>) {}
      @lazy({ equals: (previous: { n: number }, next: { n: number }) => previous.n === next.n }) get wrapped() {
        return { n: this.n.get() }
      }
    }
    const n = observable.box(1)
    const box = new Box(n)
    expect(box.wrapped).toEqual({ n: 1 })
    runInAction(() => n.set(2))
    expect(box.wrapped).toEqual({ n: 2 })
    await settle()
    expect(lazyKeptCount(box)).toBe(0)
  })

  it('releases a field first read while an earlier release lets go of its data', async () => {
    const price = observable.box(3)
    const watching = watchers(price)
    const order = new Order(price)
    const trigger = observable.box(0)
    let reread = false
    onBecomeUnobserved(trigger, () => {
      if (reread) return
      reread = true
      expect(order.total).toBe(6)
    })
    class Reader {
      @lazy get value() { return trigger.get() }
    }
    expect(new Reader().value).toBe(0)
    await settle()
    expect(reread).toBe(true)
    await settle()
    expect(lazyKeptCount(order)).toBe(0)
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

  it('stays quiet under every strict MobX flag inside actions and reactions, and leaves MobX sound', async () => {
    // As the pool's test trap does: a warning throws where MobX raised it.
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      throw new Error(`console.warn: ${args.map(String).join(' ')}`)
    })
    configure({ enforceActions: 'always', computedRequiresReaction: true, observableRequiresReaction: true, reactionRequiresObservable: true })
    try {
      const price = observable.box(3)
      const order = new Order(price)
      runInAction(() => expect([order.total, order.total]).toEqual([6, 6]))
      expect(order.runs).toBe(1)
      const seen: number[] = []
      const stop = autorun(() => { seen.push(new Order(price).total) })
      runInAction(() => price.set(4))
      stop()
      expect(seen).toEqual([6, 8])
      // A reaction made outside any batch still runs at once.
      let ran = false
      autorun(() => { ran = price.get() > 0 })()
      expect(ran).toBe(true)
      await settle()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      configure({ enforceActions: 'never', computedRequiresReaction: false, observableRequiresReaction: false, reactionRequiresObservable: false })
    }
  })

  it('keeps and releases an owned helper with no changing factory inputs under strict flags', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    configure({ enforceActions: 'always', computedRequiresReaction: true, observableRequiresReaction: true, reactionRequiresObservable: true })
    class View {
      runs = 0
      @lazy get helper() { this.runs++; return { owner: this } }
    }
    const view = new View()
    let stop = () => {}
    try {
      runInAction(() => expect(view.helper).toBe(view.helper))
      expect(view.runs).toBe(1)
      await settle()
      expect(lazyKeptCount(view)).toBe(0)
      let first: View['helper'] | undefined
      stop = autorun(() => { first = view.helper; expect(view.helper).toBe(first) })
      expect(view.runs).toBe(2)
      expect(lazyKeptCount(view)).toBe(1)
      stop()
      expect(lazyKeptCount(view)).toBe(0)
      runInAction(() => {
        expect(view.helper).not.toBe(first)
        expect(view.helper.owner).toBe(view)
      })
      expect(view.runs).toBe(3)
      await settle()
      expect(lazyKeptCount(view)).toBe(0)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      stop()
      warn.mockRestore()
      configure({ enforceActions: 'never', computedRequiresReaction: false, observableRequiresReaction: false, reactionRequiresObservable: false })
    }
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

  it('works on a subclass, with separate slots for an override that reads super', async () => {
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
    expect(lazyKeptCount(order)).toBe(2)
    expect(watching()).toBe(1)
    await settle()
    expect(lazyKeptCount(order)).toBe(0)
    expect(watching()).toBe(0)
  })

  it('refuses a legacy decorator call', () => {
    expect(() => (lazy as unknown as (...args: unknown[]) => unknown)({}, 'total', {})).toThrow(/standard decorators/)
  })

  it('costs nothing per unread object over a plain class', async () => {
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
    // (the computeds a read outside a reaction holds until the code finishes).
    const alive: object[][] = []
    const bytesPerObject = async (make: (i: number) => object, read: boolean) => {
      const before = heap()
      const objects = Array.from({ length: N }, (_, i) => make(i))
      if (read) for (const object of objects) void (object as Plain).sum
      alive.push(objects)
      // Held reads are released once the code that read them has finished.
      await settle()
      return (heap() - before) / N
    }
    const extra: number[] = []
    for (let round = 0; round < 5; round++) {
      const plain = await bytesPerObject(i => new Plain(i, 2), false)
      const unread = await bytesPerObject(i => new Lazy(i, 2), false)
      const readOutside = await bytesPerObject(i => new Lazy(i, 2), true)
      expect(plain).toBeGreaterThan(16)
      extra.push(Math.max(Math.abs(unread - plain), Math.abs(readOutside - plain)))
    }
    extra.sort((x, y) => x - y)
    // Median over interleaved rounds; a slot holder or a kept computed would be ~100+ bytes.
    expect(extra[2]).toBeLessThan(4)
    expect(alive).toHaveLength(15)
  })
})
