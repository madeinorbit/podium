// One project decorator, @lazy, whose implementation is chosen once at startup:
//   LAZY_MODE=ours -> keyedComputed (cache built on first watched read, dropped when unwatched)
//   LAZY_MODE=mobx -> hands the getter straight to MobX's own @computed decorator
// Model classes are written once and never change between modes.
import { heapStats } from 'bun:jsc'
import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
import { keyedComputed } from '/home/mgw/src/other/podium/.worktrees/issue-5708-mobx-entity-model-rules/docs/plans/mobx-entity-model-rules-evidence/keyed-computed.ts'
const { computed, autorun, observable, runInAction, compareStructural } = mobx as any
const MODE = process.env.LAZY_MODE ?? 'ours'

function lazy(options: { equals?: (a: any, b: any) => boolean } = {}) {
  return function (get: (this: any) => any, context: ClassGetterDecoratorContext) {
    if (MODE === 'mobx') return computed(options)(get, context)
    const cache = keyedComputed(String(context.name), (self: any) => get.call(self), { equals: options.equals })
    return function (this: any) { return cache(this) }
  }
}

// A model like ours: no observable fields of its own; it reads its row from a shared store.
const rows = observable.map<number, { title: string; done: number; total: number }>()
let runs = 0
class EntityModel { constructor(readonly id: number) {} get row() { return rows.get(this.id)! } }
class IssueModel extends EntityModel {
  @lazy() get label() { runs++; return `${this.row.title} (${this.row.done}/${this.row.total})` }
  @lazy({ equals: compareStructural }) get progress() { runs++; return { done: this.row.done, total: this.row.total } }
}

const check = (name: string, ok: boolean, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'} [${MODE}] ${name}${detail ? ' — ' + detail : ''}`)
runInAction(() => { rows.set(1, { title: 'a', done: 1, total: 3 }) })
const issue = new IssueModel(1)
check('nothing runs at construction', runs === 0)
runs = 0; issue.label; issue.label; check('untracked reads recompute each time', runs === 2, `runs=${runs}`)
runs = 0; let seen = 0
const d1 = autorun(() => { issue.label; issue.label; seen++ })
check('cached inside a reaction', runs === 1, `runs=${runs}`)
runInAction(() => rows.set(1, { title: 'b', done: 1, total: 3 }))
check('recomputes on change', runs === 2 && seen === 2, `runs=${runs} seen=${seen}`)
d1()
let pSeen = 0
const d2 = autorun(() => { issue.progress; pSeen++ })
runInAction(() => rows.set(1, { title: 'c', done: 1, total: 3 }))
check('equals option honoured (structurally equal progress does not notify)', pSeen === 1, `pSeen=${pSeen}`)
d2()

// Memory: 20,000 issues, every lazy field read in one reaction, then the reaction disposed.
const N = 20000
runInAction(() => { for (let i = 0; i < N; i++) rows.set(100 + i, { title: 't' + i, done: i % 5, total: 5 }) })
const heap = () => { Bun.gc(true); Bun.gc(true); return heapStats().heapSize }
const before = heap()
const keep = Array.from({ length: N }, (_, i) => new IssueModel(100 + i))
const built = heap()
const d3 = autorun(() => { for (const m of keep) { m.label; m.progress } })
const shown = heap()
d3()
const after = heap()
const per = (x: number) => Math.round((x - before) / N)
console.log(`[${MODE}] bytes/issue (2 lazy fields): built=${per(built)} shown=${per(shown)} afterClose=${per(after)}`)
