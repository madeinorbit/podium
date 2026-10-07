// Byte cost of each building block of the eviction layer, measured one at a time (20,000 each).
import { heapStats } from 'bun:jsc'
import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
const { computed, observable, autorun, runInAction, onBecomeObserved, onBecomeUnobserved } = mobx as any
const N = 20000
const heap = () => { Bun.gc(true); Bun.gc(true); return heapStats().heapSize }
const src = observable.box(1)
function size(name: string, make: (i: number) => unknown, after?: (xs: unknown[]) => void) {
  const b = heap(); const xs = Array.from({ length: N }, (_, i) => make(i)); after?.(xs); const a = heap()
  console.log(name.padEnd(62), Math.round((a - b) / N - 8), 'B')   // -8: the slot in our holding array
  return xs
}
size('closure () => fn(k)', i => () => i)
size('small value { id, label }', i => ({ id: i, label: 'issue ' + i }))
size('Map entry (key -> true)', () => 0, xs => { const m = new Map(); xs.forEach((_, i) => m.set(i, true)); (globalThis as any).m1 = m })
size('computed, never read', i => computed(() => src.get() + i))
size('computed, read once by an autorun still running (dependency links)', i => computed(() => src.get() + i), xs => { (globalThis as any).d1 = autorun(() => { for (const c of xs as any[]) c.get() }) })
size('computed + onBecomeObserved + onBecomeUnobserved listeners', i => { const c = computed(() => i); onBecomeObserved(c, () => {}); onBecomeUnobserved(c, () => {}); return c })
size('observable.box(false)', () => observable.box(false))
size('keepAlive holder computed reading a box + one other computed (after get)', i => { const off = observable.box(false); const inner = computed(() => src.get() + i); const h = computed(() => off.get() ? 0 : inner.get(), { keepAlive: true }); h.get(); return h })
