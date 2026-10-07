// Is part of a watched computed's ~1.7 KB MobX's 100-slot first-run dependency array (trimmed by length = n)?
import { heapStats } from 'bun:jsc'
import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
const { computed, observable, autorun, runInAction } = mobx as any
const N = 20000; const heap = () => { Bun.gc(true); Bun.gc(true); return heapStats().heapSize }
const srcs = Array.from({ length: N }, (_, i) => observable.box(i))
const b0 = heap()
const cs = Array.from({ length: N }, (_, i) => computed(() => srcs[i].get() + 1))
const b1 = heap()
const d = autorun(() => { for (const c of cs) c.get() })
const b2 = heap()
runInAction(() => { for (const s of srcs) s.set(s.get() + 1) })   // every computed re-runs: array sized to its real deps
const b3 = heap()
const arr = () => { const b = heap(); const xs = Array.from({ length: N }, () => { const a = new Array(100); a[0] = 1; a.length = 1; return a }); const a = heap(); void xs.length; return Math.round((a - b) / N) }
console.log({ computedUnread: Math.round((b1 - b0) / N), afterFirstRunWatched: Math.round((b2 - b0) / N), afterSecondRun: Math.round((b3 - b0) / N), array100TrimmedTo1: arr() })
d()
