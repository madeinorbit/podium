// Public-API tracked-read detection combined with the slim eviction shape (keepAlive computed + off switch).
import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
const { computed, observable, autorun, runInAction, onBecomeObserved, onBecomeUnobserved } = mobx as any
const src = observable.box(1)
let srcWatchers = 0; onBecomeObserved(src, () => srcWatchers++); onBecomeUnobserved(src, () => srcWatchers--)
let runs = 0
const slots = new Map<string, { c: any; off: any }>(); const lru = new Map<string, true>()
function lazyRead(key: string) {
  const hit = slots.get(key); if (hit) { lru.delete(key); return hit.c.get() }
  const off = observable.box(false)
  const c = computed(() => (off.get() ? undefined : (runs++, src.get() * 2)), { keepAlive: true })
  let watched = false
  const stop = onBecomeObserved(c, () => { watched = true })
  const v = c.get(); stop()
  if (watched) { slots.set(key, { c, off }); onBecomeUnobserved(c, () => lru.set(key, true)) }
  else runInAction(() => { off.set(true); c.get() })   // not on a screen: release at once (inside one action so MobX finishes the unhooking)
  return v
}
const check = (n: string, ok: boolean, d: string) => console.log(`${ok ? 'PASS' : 'FAIL'} ${n} — ${d}`)
runs = 0; lazyRead('a'); lazyRead('a'); check('outside a screen: computed each time, nothing kept, data not watched', runs === 2 && slots.size === 0 && srcWatchers === 0, `runs=${runs} kept=${slots.size} watchers=${srcWatchers}`)
runs = 0; runInAction(() => { lazyRead('a'); lazyRead('a') }); check('inside an action: same as today (computed per read), nothing left watching', slots.size === 0 && srcWatchers === 0, `runs=${runs} kept=${slots.size} watchers=${srcWatchers}`)
runs = 0; const d = autorun(() => { lazyRead('a'); lazyRead('a') }); check('inside a screen: computed once, kept', runs === 1 && slots.size === 1, `runs=${runs} kept=${slots.size}`)
d(); check('screen closed: kept in the list, still watching its data', lru.size === 1 && srcWatchers === 1, `listed=${lru.size} watchers=${srcWatchers}`)
