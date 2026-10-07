// V8 cross-check of alloc.ts arms mo0 / mo30 / keyed30 (keyedComputed logic inlined, same as pilot minus logger).
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const mobx = require('/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js')
const { makeObservable, observable, computed, onBecomeUnobserved, _getGlobalState, autorun } = mobx
const arm = process.argv[2], N = 20000, K = 30
let calls = 0
function keyedComputed(fn) {
  const cache = new Map()
  const read = key => {
    const c = cache.get(key); if (c) return c.get()
    if (!_getGlobalState().trackingDerivation) return fn(key)
    const v = computed(() => fn(key), { context: key }); cache.set(key, v)
    onBecomeUnobserved(v, () => { if (cache.get(key) === v) cache.delete(key) })
    return v.get()
  }
  read.size = () => cache.size
  return read
}
const names = Array.from({ length: K }, (_, i) => `c${i}`)
let Cls, groups
if (arm === 'mo0') Cls = class { constructor(id) { this.id = id; this.x = id; makeObservable(this, { x: observable }) } }
if (arm === 'mo30') {
  const ann = { x: observable }; for (const n of names) ann[n] = computed
  Cls = class { constructor(id) { this.id = id; this.x = id; makeObservable(this, ann) } }
  names.forEach((n, i) => Object.defineProperty(Cls.prototype, n, { configurable: true, get() { calls++; return this.x + i } }))
}
if (arm === 'keyed30') {
  groups = names.map((_, i) => keyedComputed(m => { calls++; return m.x + i }))
  Cls = class { constructor(id) { this.id = id; this.x = id; makeObservable(this, { x: observable }) } }
  names.forEach((n, i) => Object.defineProperty(Cls.prototype, n, { configurable: true, get() { return groups[i](this) } }))
}
const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed }
const keep = new Array(N)
const before = heap()
for (let i = 0; i < N; i++) keep[i] = new Cls(i)
const after = heap()
const out = { engine: 'v8 ' + process.version, arm, N, K, bytesPerInstance: Math.round((after - before) / N), getterCallsAfterConstruct: calls }
// Unobserved read: recomputes every time
const m0 = keep[0]
if (arm !== 'mo0') { calls = 0; void m0.c0; void m0.c0; void m0.c0; out.callsFor3UntrackedReads = calls
  calls = 0; const d = autorun(() => { void m0.c0; void m0.c0 }); void m0.c0; out.callsInsideAutorunPlusOneReadWhileObserved = calls; d() }
console.log(JSON.stringify(out))
