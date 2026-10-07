// Can @lazy tell "read inside a screen" from "read outside" with PUBLIC MobX API only?
// Idea: on a cache miss, create the computed, listen for onBecomeObserved, read it; keep it only if that fired.
import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
const { computed, observable, autorun, runInAction, onBecomeObserved, onBecomeUnobserved } = mobx as any
const src = observable.box(1)
let runs = 0
const slots = new Map<string, any>()
function lazyRead(key: string) {
  const hit = slots.get(key); if (hit) return hit.get()
  const c = computed(() => { runs++; return src.get() * 2 })
  let watched = false
  const stop = onBecomeObserved(c, () => { watched = true })
  const v = c.get(); stop()
  if (watched) { slots.set(key, c); onBecomeUnobserved(c, () => slots.delete(key)) }
  return v
}
const check = (n: string, ok: boolean, d: string) => console.log(`${ok ? 'PASS' : 'FAIL'} ${n} — ${d}`)
runs = 0; lazyRead('a'); lazyRead('a'); check('outside a screen: computed each time, nothing kept', runs === 2 && slots.size === 0, `runs=${runs} kept=${slots.size}`)
runs = 0; const d = autorun(() => { lazyRead('a'); lazyRead('a') }); check('inside a screen: computed once, kept', runs === 1 && slots.size === 1, `runs=${runs} kept=${slots.size}`)
d(); check('screen closed: dropped', slots.size === 0, `kept=${slots.size}`)
runs = 0; let inBatchKept = -1; runInAction(() => { lazyRead('a'); lazyRead('a'); inBatchKept = slots.size }); check('inside an action (no screen): computed once, kept only for the action', runs === 1 && slots.size === 0, `runs=${runs} keptDuring=${inBatchKept} keptAfter=${slots.size}`)
