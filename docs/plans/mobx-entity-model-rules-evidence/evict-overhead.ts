// Bookkeeping cost of the eviction layer vs today's plain @lazy cache (keyedComputed).
//   plain : one computed per shown field, dropped on close (today)
//   evict : outer+inner computed per field; on close a keepAlive holder + switch keeps it; LRU Map with a cap
//   bare  : inner computed with keepAlive and nothing else (the cached value alone, no bookkeeping)
import { heapStats } from 'bun:jsc'
import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
import { keyedComputed } from '/home/mgw/src/other/podium/.worktrees/issue-5708-mobx-entity-model-rules/docs/plans/mobx-entity-model-rules-evidence/keyed-computed.ts'
const { computed, observable, autorun, runInAction, onBecomeObserved, onBecomeUnobserved } = mobx as any
const ARM = process.argv[2]; const N = Number(process.argv[3] ?? 20000); const CAP = Number(process.argv[4] ?? N)

function evictField<K>(fn: (k: K) => unknown, cap: number) {
  type E = { outer: any; release?: () => void }
  const entries = new Map<K, E>(); const lru = new Map<K, true>()
  const evict = (k: K) => { const e = entries.get(k)!; lru.delete(k); e.release!(); e.release = undefined; entries.delete(k) }
  return (k: K) => {
    const f = entries.get(k); if (f) return f.outer.get()
    const inner = computed(() => fn(k)); const outer = computed(() => inner.get())
    const e: E = { outer }; entries.set(k, e)
    onBecomeObserved(outer, () => { if (lru.delete(k)) lru.set(k, true) })
    onBecomeUnobserved(outer, () => {
      if (e.release) { lru.delete(k); lru.set(k, true); return }
      const off = observable.box(false)
      const holder = computed(() => (off.get() ? undefined : inner.get()), { keepAlive: true }); holder.get()
      e.release = () => { runInAction(() => off.set(true)); holder.get() }
      lru.set(k, true); if (lru.size > cap) evict(lru.keys().next().value as K)
    })
    return outer.get()
  }
}
// slim: ONE keepAlive computed per field, released through its own switch; no outer layer, no holder.
function slimField<K>(fn: (k: K) => unknown, cap: number) {
  type E = { c: any; off: any }
  const entries = new Map<K, E>(); const lru = new Map<K, true>()
  const evict = (k: K) => { const e = entries.get(k)!; lru.delete(k); entries.delete(k); runInAction(() => e.off.set(true)); e.c.get() }
  return (k: K) => {
    const f = entries.get(k); if (f) { if (lru.delete(k)) {} return f.c.get() }
    if (!(mobx as any)._getGlobalState().trackingDerivation) return fn(k)   // untracked read: no cache (as keyedComputed)
    const off = observable.box(false)
    const c = computed(() => (off.get() ? undefined : fn(k)), { keepAlive: true })
    entries.set(k, { c, off })
    onBecomeUnobserved(c, () => { lru.set(k, true); if (lru.size > cap) evict(lru.keys().next().value as K) })
    return c.get()
  }
}
const rows = observable.map<number, number>(); runInAction(() => { for (let i = 0; i < N; i++) rows.set(i, i) })
const fn = (id: number) => ({ id, label: 'issue ' + rows.get(id) })
let read: (k: number) => unknown
if (ARM === 'plain') read = keyedComputed(() => undefined, fn) as any
else if (ARM === 'evict') read = evictField(fn, CAP)
else if (ARM === 'slim') read = slimField(fn, CAP)
else { const cs = new Map<number, any>(); read = (k) => { let c = cs.get(k); if (!c) { c = computed(() => fn(k), { keepAlive: true }); cs.set(k, c) } return c.get() } }
const heap = () => { Bun.gc(true); Bun.gc(true); return heapStats().heapSize }
const all = Array.from({ length: N }, (_, i) => i)
const base = heap()
let t = performance.now(); let d = autorun(() => { for (const i of all) read(i) }); const firstShow = performance.now() - t
const shown = heap()
t = performance.now(); runInAction(() => { for (const i of all) read(i) }); const reread = performance.now() - t
t = performance.now(); d(); const close = performance.now() - t
const closed = heap()
t = performance.now(); d = autorun(() => { for (const i of all) read(i) }); const reopen = performance.now() - t; d()
const per = (x: number) => Math.round((x - base) / N)
console.log(JSON.stringify({ ARM, N, CAP, bytesShown: per(shown), bytesAfterClose: per(closed), firstShowMs: +firstShow.toFixed(1), rereadMs: +reread.toFixed(1), closeMs: +close.toFixed(1), reopenMs: +reopen.toFixed(1) }))
