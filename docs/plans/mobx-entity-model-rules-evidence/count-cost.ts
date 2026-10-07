// Cost of an always-shown client count done the plain way: one cached fact per item + a total over them.
// One item changes; MobX re-works that item's fact and the total (which re-reads every cached fact).
import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
const { computed, observable, autorun, runInAction } = mobx as any
for (const N of [1000, 10000, 40000]) {
  const stage = Array.from({ length: N }, (_, i) => observable.box(i % 3 === 0 ? 'review' : 'open'))
  const needsYou = stage.map(s => computed(() => s.get() === 'review'))          // per-item cached fact
  const total = computed(() => { let n = 0; for (const f of needsYou) if (f.get()) n++; return n })
  let shown = 0; const d = autorun(() => { shown = total.get() })
  const times: number[] = []
  for (let r = 0; r < 200; r++) { const i = (r * 7919) % N; const t = performance.now(); runInAction(() => stage[i].set(stage[i].get() === 'review' ? 'open' : 'review')); times.push(performance.now() - t) }
  times.sort((a, b) => a - b); d()
  console.log(`N=${N}: one item changes -> count updated in median ${(times[100] * 1000).toFixed(0)} µs (p90 ${(times[180] * 1000).toFixed(0)} µs)`)
}
