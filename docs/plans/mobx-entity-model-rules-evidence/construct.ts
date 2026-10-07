// Construction time: N objects with K derived fields, three declarations, interleaved rounds.
import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
import { keyedComputed } from '/home/mgw/src/other/podium/.worktrees/issue-5708-mobx-entity-model-rules/docs/plans/mobx-entity-model-rules-evidence/keyed-computed.ts'
import { Dec } from './dec-class.ts'
import { Dec as Dec0 } from './dec0-class.ts'
const { makeObservable, observable, computed, autorun } = mobx as any
const N = Number(process.argv[2] ?? 2000), K = 30
const names = Array.from({ length: K }, (_, i) => `c${i}`)
function getters(proto: any, body: (s: any, i: number) => unknown) {
  names.forEach((n, i) => Object.defineProperty(proto, n, { configurable: true, get(this: any) { return body(this, i) } }))
}
class MO { x: number; constructor(id: number) { this.x = id; makeObservable(this, ann) } }
getters(MO.prototype, (s, i) => s.x + i)
const ann: any = { x: observable }; names.forEach(n => (ann[n] = computed))
class KO { x: number; constructor(id: number) { this.x = id; makeObservable(this, { x: observable }) } }
const kc = names.map((n, i) => keyedComputed(n, (o: any) => o.x + i))
names.forEach((n, i) => Object.defineProperty(KO.prototype, n, { configurable: true, get(this: any) { return kc[i](this) } }))
class P { x: number; constructor(id: number) { this.x = id; makeObservable(this, { x: observable }) } }
class PG { x: number; constructor(id: number) { this.x = id; makeObservable(this, { x: observable }) } }
getters(PG.prototype, (s, i) => s.x + i)
const arms: Record<string, any> = { base_1field: P, plainGetter_30: PG, docsDefault_30: MO, decBase_1field: Dec0, decorator_30: Dec, ours_30: KO }
const res: Record<string, number[]> = {}
const readRes: Record<string, number[]> = {}
const remount: Record<string, number[]> = {}
const cached: Record<string, number[]> = {}
for (let r = 0; r < 5; r++) for (const [name, C] of Object.entries(arms)) {
  const t0 = performance.now(); const xs = []; for (let i = 0; i < N; i++) xs.push(new C(i)); const t1 = performance.now()
  ;(res[name] ??= []).push(t1 - t0)
  // read every field of every object once inside one reaction, twice (second pass = cached reads)
  let d: any; const t2 = performance.now(); d = autorun(() => { for (const o of xs) for (const n of names) o[n] }); const t3 = performance.now()
  ;(readRes[name] ??= []).push(t3 - t2); d()
  // remount: a screen watches again after nothing watched
  const t4 = performance.now(); d = autorun(() => { for (const o of xs) for (const n of names) o[n] }); const t5 = performance.now()
  ;(remount[name] ??= []).push(t5 - t4)
  // cached reads: while watched, read everything again in an action
  const t6 = performance.now(); mobx.runInAction(() => { for (const o of xs) for (const n of names) o[n] }); const t7 = performance.now()
  ;(cached[name] ??= []).push(t7 - t6); d()
}
const med = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1].toFixed(1)
for (const k of Object.keys(arms)) console.log(k, 'construct ms (N objs):', med(res[k]), ' first observed read of all 30 fields ms:', med(readRes[k]), ' remount:', med(remount[k]), ' cached re-read:', med(cached[k]))
