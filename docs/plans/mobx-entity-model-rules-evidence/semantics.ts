// Laziness / suspension / keepAlive / fan-out semantics of MobX 7.0.3 computeds, plus the pilot's keyedComputed.
import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
import { keyedComputed } from './keyed-computed.ts'
const { makeObservable, observable, computed, autorun, runInAction, configure, onBecomeUnobserved, getDependencyTree, isComputedProp } = mobx as any

const log = (k: string, v: unknown) => console.log(`${k}: ${JSON.stringify(v)}`)
const counts: Record<string, number> = {}
const hit = (k: string) => { counts[k] = (counts[k] ?? 0) + 1 }

class Issue {
  title = 't'
  done = false
  constructor(readonly id: number) {
    makeObservable(this, { title: observable, done: observable, sidebarLabel: computed, detailSummary: computed, kept: computed({ keepAlive: true }) })
  }
  get sidebarLabel() { hit('sidebarLabel'); return `#${this.id} ${this.title}` }
  get detailSummary() { hit('detailSummary'); return `${this.title} done=${this.done}` }
  get kept() { hit('kept'); return this.title.length }
}

const a = new Issue(1)
// 1. A declared computed nobody reads never runs.
log('1 calls after construct (no reads)', counts)

// 2. Read outside any reaction: recomputes on every read (no cache), outside a batch.
void a.sidebarLabel; void a.sidebarLabel; void a.sidebarLabel
log('2 sidebarLabel calls after 3 untracked reads', counts.sidebarLabel)

// 3. Inside a batch (runInAction), an untracked computed is cached for the batch duration only.
counts.sidebarLabel = 0
runInAction(() => { void a.sidebarLabel; void a.sidebarLabel; void a.sidebarLabel })
log('3 sidebarLabel calls for 3 reads inside one runInAction', counts.sidebarLabel)

// 4. Observed by a reaction (the "sidebar"): cached; a change to an input the OTHER computed reads does not run it.
counts.sidebarLabel = 0; counts.detailSummary = 0
const sidebar = autorun(() => { void a.sidebarLabel })
runInAction(() => { a.done = true })            // only detailSummary depends on done
log('4 after done=true with only sidebar observing: {sidebarLabel, detailSummary}', { s: counts.sidebarLabel, d: counts.detailSummary })
runInAction(() => { a.title = 'u' })
log('4b after title change: sidebarLabel calls', counts.sidebarLabel)

// 5. A detail screen observes detailSummary too; sidebar cost unchanged by detail's existence.
counts.sidebarLabel = 0; counts.detailSummary = 0
const detail = autorun(() => { void a.detailSummary })
runInAction(() => { a.done = false })
log('5 done toggled with both screens: {sidebarLabel, detailSummary}', { s: counts.sidebarLabel, d: counts.detailSummary })

// 6. Suspension: dispose detail -> detailSummary drops deps and value; next untracked read recomputes.
detail()
const adm = (a as any)[mobx.$mobx]
const cv = adm.values_.get('detailSummary')
log('6 after detail disposed: detailSummary observing_ length, value_', { deps: cv.observing_.length, value: cv.value_ })
sidebar()

// 7. keepAlive: keeps deps and value even with no observers (a leak if the object should die).
void a.kept
const kcv = adm.values_.get('kept')
log('7 keepAlive computed after one untracked read: deps, value', { deps: kcv.observing_.length, value: kcv.value_ })

// 8. requiresReaction warning on untracked read (dev builds only).
configure({ computedRequiresReaction: true })
void a.sidebarLabel
configure({ computedRequiresReaction: false })

// 9. Large collection getter: a filtered array over 10k entities re-runs on ANY member's input change,
//    and default comparer (identity) means every re-run notifies its observers (new array).
class Store {
  issues = Array.from({ length: 10000 }, (_, i) => new Issue(i))
  constructor() { makeObservable(this, { issues: observable.shallow ?? observable, openIssues: computed, openCount: computed }) }
  get openIssues() { hit('openIssues'); return this.issues.filter(i => !i.done) }
  get openCount() { hit('openCount'); return this.openIssues.length }
}
const store = new Store()
let sidebarRuns = 0, countRuns = 0
const listScreen = autorun(() => { void store.openIssues; sidebarRuns++ })
const badge = autorun(() => { void store.openCount; countRuns++ })
counts.openIssues = 0; counts.openCount = 0
runInAction(() => { store.issues[5].title = 'renamed' }) // not a dependency of openIssues (reads only .done)
log('9a rename (not read by filter): openIssues reruns, list screen reruns', { f: counts.openIssues, list: sidebarRuns - 1 })
runInAction(() => { store.issues[5].done = true; store.issues[5].done = false }) // net no change within one batch
log('9b done toggled & restored in one batch (net no change): openIssues reruns, openCount reruns, list reaction runs, badge runs', { f: counts.openIssues, c: counts.openCount, list: sidebarRuns - 1, badge: countRuns - 1 })
counts.openIssues = 0; counts.openCount = 0; sidebarRuns = 1; countRuns = 1
runInAction(() => { store.issues[7].done = true })
log('9c one issue closed: openIssues reruns (O(n) filter), openCount reruns, list/badge reaction runs', { f: counts.openIssues, c: counts.openCount, list: sidebarRuns - 1, badge: countRuns - 1 })
log('9d dependency count of openIssues (one per entity read)', getDependencyTree(store, 'openIssues').dependencies?.length)
listScreen(); badge()

// 10. The pilot's keyedComputed: untracked read never caches; tracked read caches; unobserve deletes the entry.
let kcalls = 0
const issueTitle = keyedComputed((m: Issue) => `Issue@${m.id}.title`, (m: Issue) => { kcalls++; return m.title.toUpperCase() }, { context: (m: Issue) => m })
void issueTitle(a); void issueTitle(a)
log('10a keyed: 2 untracked reads -> calls, cache size', { calls: kcalls, size: issueTitle.size })
kcalls = 0
const r = autorun(() => { void issueTitle(a); void issueTitle(a) })
log('10b keyed inside one reaction, 2 reads -> calls, cache size', { calls: kcalls, size: issueTitle.size })
r()
log('10c keyed after reaction disposed -> cache size', issueTitle.size)

// 11. isComputedProp for makeObservable getter
log('11 isComputedProp(a, sidebarLabel)', isComputedProp(a, 'sidebarLabel'))
