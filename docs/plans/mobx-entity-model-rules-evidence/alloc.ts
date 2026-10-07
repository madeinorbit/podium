// Heap cost of N model instances with 0 vs K unread computed getters, per MobX 7.0.3 style.
// Usage: bun alloc.ts <arm> [N] [K]
//   plain        : plain class, 1 observable-backed field via a shared observable map, no computeds (baseline)
//   mo0          : makeObservable class, 1 observable field, 0 computeds
//   mo30         : makeObservable class, 1 observable field, K computed getters (annotation map)
//   mao30        : makeAutoObservable class, 1 field, K getters
//   dec30        : 2022.3 @computed decorator class, 1 @observable accessor, K getters
//   keyed30      : plain class whose K getters route through keyedComputed (our cachedGroup pattern)
//   keyed30read  : keyed30, then every getter of every instance read once inside ONE autorun, then disposed
//   keyed30readNoName : keyed30read without per-key debug names (production cachedGroup passes none)
//   mo30read     : mo30, every getter read once inside one autorun, then disposed
//   dec30read    : dec30, every getter read once inside one autorun, then disposed
//   mao30read    : mao30, every getter read once inside one autorun, then disposed
import { heapStats } from 'bun:jsc'
import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
import { keyedComputed } from './keyed-computed.ts'

const { makeObservable, makeAutoObservable, observable, computed, autorun } = mobx as any
const arm = process.argv[2] ?? 'plain'
const N = Number(process.argv[3] ?? 20000)
const K = Number(process.argv[4] ?? 30)
let calls = 0

function getterNames(k: number) { return Array.from({ length: k }, (_, i) => `c${i}`) }

function defineGetters(proto: object, k: number, body: (self: any, i: number) => unknown) {
  for (let i = 0; i < k; i++) {
    Object.defineProperty(proto, `c${i}`, { configurable: true, enumerable: false, get(this: any) { return body(this, i) } })
  }
}

function makeClass(): new (id: number) => any {
  switch (arm) {
    case 'plain': {
      return class { constructor(readonly id: number) {} }
    }
    case 'mo0': {
      return class { x: number; constructor(readonly id: number) { this.x = id; makeObservable(this, { x: observable }) } }
    }
    case 'mo30': case 'mo30read': {
      class M { x: number; constructor(readonly id: number) { this.x = id; makeObservable(this, annotations) } }
      defineGetters(M.prototype, K, (self, i) => { calls++; return self.x + i })
      const annotations: Record<string, unknown> = { x: observable }
      for (const n of getterNames(K)) annotations[n] = computed
      return M
    }
    case 'mao30': case 'mao30read': {
      class M { x: number; constructor(readonly id: number) { this.x = id; makeAutoObservable(this) } }
      defineGetters(M.prototype, K, (self, i) => { calls++; return self.x + i })
      return M
    }
    case 'keyed30': case 'keyed30read': case 'keyed30readNoName': {
      const groups = getterNames(K).map((_, i) => keyedComputed(arm === 'keyed30readNoName' ? () => undefined : (m: any) => `M@${m.id}.c${i}`, (m: any) => { calls++; return m.x + i }, { context: (m: any) => m }))
      class M { x: number; constructor(readonly id: number) { this.x = id; makeObservable(this, { x: observable }) } }
      defineGetters(M.prototype, K, (self, i) => groups[i]!(self))
      ;(globalThis as any).__groups = groups
      return M
    }
    case 'dec30': case 'dec30read': case 'dec0': {
      // Build the class source so K is variable; TC39 2022.3 decorators via Bun's transpiler.
      return (globalThis as any).__decClass
    }
  }
  throw new Error(`unknown arm ${arm}`)
}

if (arm === 'dec30' || arm === 'dec30read' || arm === 'dec0') {
  const mod = await import(arm === 'dec0' ? './dec0-class.ts' : './dec-class.ts')
  ;(globalThis as any).__decClass = mod.Dec
  ;(globalThis as any).__decCalls = mod.decCalls
}

const Cls = makeClass()
function heap(): number { Bun.gc(true); Bun.gc(true); return heapStats().heapSize }
const keep: any[] = new Array(N)
const before = heap()
const t0 = performance.now()
for (let i = 0; i < N; i++) keep[i] = new Cls(i)
const t1 = performance.now()
const after = heap()
const out: Record<string, unknown> = {
  arm, N, K, env: process.env.NODE_ENV ?? '(unset)',
  heapBeforeMB: +(before / 1e6).toFixed(2), heapAfterMB: +(after / 1e6).toFixed(2),
  bytesPerInstance: Math.round((after - before) / N),
  constructMs: +(t1 - t0).toFixed(1),
  getterCallsAfterConstruct: calls + ((globalThis as any).__decCalls?.() ?? 0),
}
if (arm.includes('read')) {
  const dispose = autorun(() => { for (const m of keep) for (let i = 0; i < K; i++) void m[`c${i}`] })
  out.heapWhileObservedMB = +(heap() / 1e6).toFixed(2)
  out.bytesPerInstanceWhileObserved = Math.round((heap() - before) / N)
  out.callsWhileObserved = calls + ((globalThis as any).__decCalls?.() ?? 0)
  if (arm.startsWith('keyed30read')) out.keyedCacheEntriesWhileObserved = (globalThis as any).__groups.reduce((s: number, g: any) => s + g.size, 0)
  dispose()
  out.heapAfterDisposeMB = +(heap() / 1e6).toFixed(2)
  out.bytesPerInstanceAfterDispose = Math.round((heap() - before) / N)
  if (arm.startsWith('keyed30read')) out.keyedCacheEntriesAfterDispose = (globalThis as any).__groups.reduce((s: number, g: any) => s + g.size, 0)
}
console.log(JSON.stringify(out))
void keep.length
