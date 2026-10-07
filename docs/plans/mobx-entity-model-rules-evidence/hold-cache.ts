// Proof of a "keep after the screen leaves, until the data changes or space runs out" cache,
// using only public MobX API (computed, Reaction, onBecomeObserved/Unobserved).
// Layout per (object, field): `inner` = the real cached value; `outer` = what screens read.
// When the last screen stops reading `outer`, a cheap holder starts watching `inner` instead,
// so MobX keeps inner's value. The holder lets go on the first change of inner's inputs
// (no background recompute) or when it is the oldest of more than CAP held entries.
import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
const { computed, observable, autorun, runInAction, Reaction, onBecomeObserved, onBecomeUnobserved } = mobx as any

function heldComputed<K, V>(fn: (key: K) => V, CAP: number) {
  const entries = new Map<K, { outer: any; holder?: any }>()
  const held = new Set<K>()                                  // insertion order = oldest first
  const release = (key: K) => {
    const e = entries.get(key); if (!e?.holder) return
    held.delete(key); const h = e.holder; e.holder = undefined; h.dispose()
    entries.delete(key)                                      // inner now suspends; nothing kept
  }
  return (key: K): V => {
    const found = entries.get(key)
    if (found) return found.outer.get()
    const inner = computed(() => fn(key))
    const outer = computed(() => inner.get())
    const entry: { outer: any; holder?: any } = { outer }
    entries.set(key, entry)
    onBecomeObserved(outer, () => {                          // a screen is back: stop holding
      if (entry.holder) { held.delete(key); const h = entry.holder; entry.holder = undefined; h.dispose() }
    })
    onBecomeUnobserved(outer, () => {                        // last screen left: hold inner
      const holder: any = new Reaction('hold', () => {       // value changed while kept
        if (MODE === 'drop') release(key); else holder.track(() => inner.get())  // keep-warm: re-watch
      })
      holder.track(() => inner.get())
      entry.holder = holder; held.add(key)
      if (held.size > CAP) release(held.values().next().value as K)
    })
    return outer.get()
  }
}

const MODE = process.env.HOLD_MODE ?? 'warm'
const rows = observable.map<number, number>()
runInAction(() => { for (let i = 1; i <= 4; i++) rows.set(i, i) })
let runs = 0
const field = heldComputed((id: number) => { runs++; return rows.get(id)! * 10 }, 2)
const show = (ids: number[]) => autorun(() => { for (const id of ids) field(id) })
const check = (name: string, ok: boolean, d: string) => console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${d}`)

let s = show([1]); s()                                       // show, then close
runs = 0; s = show([1]); check('reopen after close reuses the kept value', runs === 0, `runs=${runs}`); s()
runs = 0; runInAction(() => rows.set(1, 99))
check(`[${MODE}] a change while kept recomputes once in the background`, runs === 1, `runs=${runs}`)
runs = 0; s = show([1]); check(`[${MODE}] reopen after a change`, MODE === 'warm' ? runs === 0 : runs === 1, `runs=${runs} (warm expects 0, drop expects 1)`); s()
runs = 0; runInAction(() => rows.set(1, 99)); check(`[${MODE}] a no-op write while kept does no work`, runs === 0, `runs=${runs}`)
for (const id of [2, 3, 4]) { const t = show([id]); t() }   // close 2, 3, 4 with CAP = 2 (1 was kept too)
runs = 0; s = show([4]); check(`[${MODE}] newest kept entry reused`, runs === 0, `runs=${runs}`); s()
runs = 0; s = show([1]); check(`[${MODE}] oldest entry dropped once over the cap`, runs === 1, `runs=${runs}`); s()
runs = 0; s = show([2, 3]); check('entries over the cap were dropped (2 and 3 oldest)', runs >= 1, `runs=${runs}`); s()
