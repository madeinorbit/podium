// Bookkeeping cost of the eviction layer vs today's plain @lazy cache (keyedComputed).
//   plain : one computed per shown field, dropped on close (today)
//   evict : outer+inner computed per field; on close a keepAlive holder + switch keeps it; LRU Map with a cap
//   bare  : inner computed with keepAlive and nothing else (the cached value alone, no bookkeeping)
import { heapStats } from 'bun:jsc'
import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
import { keyedComputed } from '/home/mgw/src/other/podium/.worktrees/issue-5708-mobx-entity-model-rules/docs/plans/mobx-entity-model-rules-evidence/keyed-computed.ts'
const { computed, observable, autorun, runInAction, onBecomeObserved, onBecomeUnobserved } = mobx as any


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

const check = (n: string, ok: boolean, d: string) => console.log(`${ok ? 'PASS' : 'FAIL'} [slim] ${n} — ${d}`)
const box = new Map<number, any>(); for (let i = 1; i <= 4; i++) box.set(i, observable.box(i))
let watching = 0; for (const b of box.values()) { onBecomeObserved(b, () => watching++); onBecomeUnobserved(b, () => watching--) }
let runs = 0; const field = slimField((id: number) => { runs++; return box.get(id).get() * 10 }, 2)
const show = (ids: number[]) => autorun(() => { for (const id of ids) field(id) })
runs = 0; field(1); field(1); check('untracked reads compute directly, nothing cached', runs === 2 && watching === 0, `runs=${runs} watching=${watching}`)
let s = show([1]); s()
runs = 0; s = show([1]); check('reopen, data unchanged: free', runs === 0, `runs=${runs}`); s()
runs = 0; runInAction(() => box.get(1).set(99)); check('data change while closed: no work', runs === 0, `runs=${runs}`)
runs = 0; s = show([1]); check('reopen after a change: once', runs === 1, `runs=${runs}`)
runInAction(() => box.get(1).set(5)); check('while shown, updates as usual', runs === 2, `runs=${runs}`); s()
for (const id of [2, 3, 4]) { const t = show([id]); t() }
check('only kept entries still watch their data (cap 2)', watching === 2, `watching=${watching}`)
runs = 0; s = show([1]); check('oldest evicted past the cap', runs === 1, `runs=${runs}`); s()
