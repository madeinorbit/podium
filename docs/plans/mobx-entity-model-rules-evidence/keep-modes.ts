// Option 2 ("warm": an observer holds the value) vs option 3 ("keep": a keepAlive computed holds it,
// released through a public switch). Public MobX API only.
import { heapStats } from 'bun:jsc'
import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
const { computed, observable, autorun, runInAction, Reaction, onBecomeUnobserved, onBecomeObserved } = mobx as any
const MODE = process.env.HOLD_MODE ?? 'keep'   // 'drop' (today) | 'warm' (option 2) | 'keep' (option 3)

function makeField<K>(fn: (key: K) => unknown, CAP: number) {
  type Entry = { outer: any; hold?: () => void }
  const entries = new Map<K, Entry>(); const held = new Set<K>()
  const evict = (key: K) => { const e = entries.get(key); if (!e?.hold) return; held.delete(key); const h = e.hold; e.hold = undefined; h(); entries.delete(key) }
  return (key: K) => {
    const found = entries.get(key); if (found) return found.outer.get()
    const inner = computed(() => fn(key)); const outer = computed(() => inner.get())
    const entry: Entry = { outer }; entries.set(key, entry)
    onBecomeObserved(outer, () => { if (entry.hold) { held.delete(key); held.add(key) } })   // refresh age
    onBecomeUnobserved(outer, () => {
      if (MODE === 'drop') { entries.delete(key); return }
      if (entry.hold) return
      if (MODE === 'warm') {
        const r: any = new Reaction('hold', () => r.track(() => inner.get())); r.track(() => inner.get())
        entry.hold = () => r.dispose()
      } else {
        const released = observable.box(false)
        const holder = computed(() => (released.get() ? undefined : inner.get()), { keepAlive: true })
        holder.get()
        entry.hold = () => { runInAction(() => released.set(true)); holder.get() }   // re-run reads only `released`: lets go of inner
      }
      held.add(key); if (held.size > CAP) evict(held.values().next().value as K)
    })
    return outer.get()
  }
}

const check = (name: string, ok: boolean, d: string) => console.log(`${ok ? 'PASS' : 'FAIL'} [${MODE}] ${name} — ${d}`)
// behaviour
{
  const box = new Map<number, any>(); for (let i = 1; i <= 4; i++) box.set(i, observable.box(i))
  let watching = 0; for (const b of box.values()) { onBecomeObserved(b, () => watching++); onBecomeUnobserved(b, () => watching--) }
  let runs = 0; const field = makeField((id: number) => { runs++; return box.get(id).get() * 10 }, 2)
  const show = (ids: number[]) => autorun(() => { for (const id of ids) field(id) })
  let s = show([1]); s()
  runs = 0; s = show([1]); check('reopen, data unchanged', MODE === 'drop' ? runs === 1 : runs === 0, `runs=${runs}`); s()
  runs = 0; runInAction(() => box.get(1).set(99)); check('work while closed when data changes', MODE === 'warm' ? runs === 1 : runs === 0, `runs=${runs}`)
  runs = 0; s = show([1]); check('reopen after a change', MODE === 'warm' ? runs === 0 : runs === 1, `runs=${runs}`); s()
  for (const id of [2, 3, 4]) { const t = show([id]); t() }
  check('inputs still watched = kept entries only', watching === (MODE === 'drop' ? 0 : 2), `watching=${watching}`)
  runs = 0; s = show([1]); check('oldest evicted past the cap', runs === 1, `runs=${runs}`); s()
}
// memory: 20,000 fields shown, then closed (all kept: cap above N)
{
  const N = 20000; const rows = observable.map<number, number>()
  runInAction(() => { for (let i = 0; i < N; i++) rows.set(i, i) })
  const field = makeField((id: number) => ({ id, label: 'issue ' + rows.get(id) }), N + 1)
  const heap = () => { Bun.gc(true); Bun.gc(true); return heapStats().heapSize }
  const before = heap()
  const d = autorun(() => { for (let i = 0; i < N; i++) field(i) }); const shown = heap()
  d(); const closed = heap()
  let runs2 = 0; const t0 = performance.now(); runInAction(() => { for (let i = 0; i < N; i++) rows.set(i, i + 1) }); const t1 = performance.now()
  console.log(`[${MODE}] bytes per field: shown=${Math.round((shown - before) / N)} afterClose=${Math.round((closed - before) / N)}; changing all ${N} inputs while closed took ${(t1 - t0).toFixed(1)} ms`)
}
