// Reads outside a screen: @computed vs @lazy today vs @lazy with release deferred to the end of the current task.
import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
const { computed, observable, autorun, runInAction, onBecomeObserved, onBecomeUnobserved } = mobx as any
const src = observable.box(1)
let watchers = 0; onBecomeObserved(src, () => watchers++); onBecomeUnobserved(src, () => watchers--)
let runs = 0
const check = (n: string, ok: boolean, d: string) => console.log(`${ok ? 'PASS' : 'FAIL'} ${n} — ${d}`)

// MobX @computed equivalent: one computed per object field, kept on the object
const plain = computed(() => (runs++, src.get() * 2))
runs = 0; runInAction(() => { plain.get(); plain.get() }); const pAct = runs
runs = 0; plain.get(); plain.get(); const pOut = runs

// @lazy with deferred release: an unwatched miss stays cached until the current task ends, then is released
const slots = new Map<string, { c: any; off: any }>(); const pending = new Set<string>(); let flushQueued = false
const flush = () => { flushQueued = false; runInAction(() => { for (const k of pending) { const e = slots.get(k)!; e.off.set(true); e.c.get(); slots.delete(k) } }); pending.clear() }
function lazyRead(key: string) {
  const hit = slots.get(key); if (hit) return hit.c.get()
  const off = observable.box(false)
  const c = computed(() => (off.get() ? undefined : (runs++, src.get() * 2)), { keepAlive: true })
  let watched = false; const stop = onBecomeObserved(c, () => { watched = true }); const v = c.get(); stop()
  slots.set(key, { c, off })
  if (!watched) { pending.add(key); if (!flushQueued) { flushQueued = true; queueMicrotask(flush) } }
  return v
}
runs = 0; runInAction(() => { lazyRead('a'); lazyRead('a') }); const lAct = runs
runs = 0; lazyRead('b'); lazyRead('b'); const lOut = runs
runs = 0; runInAction(() => src.set(5)); const v = lazyRead('b'); const fresh = v === 10 && runs === 1
check('@computed: inside an action computes once', pAct === 1, `runs=${pAct}`)
check('@computed: outside an action computes every read', pOut === 2, `runs=${pOut}`)
check('@lazy deferred: inside an action computes once', lAct === 1, `runs=${lAct}`)
check('@lazy deferred: outside an action, same task, computes once', lOut === 1, `runs=${lOut}`)
check('@lazy deferred: a change before release gives a fresh value', fresh, `value=${v} runs=${runs}`)
await Promise.resolve(); await Promise.resolve()
check('after the task ends: released, data no longer watched', slots.size === 0 && watchers === 0, `kept=${slots.size} watchers=${watchers}`)
