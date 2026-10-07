// Does mobx-utils createViewModel work on a model shaped like ours (plain class, schema fields as
// non-enumerable prototype getters/setters reading a shared row store, @lazy-style derived getters)?
import { observable, runInAction, makeObservable, computed } from 'mobx'
import { createViewModel } from './mu/create-view-model.js'
const rows = observable.map([[1, { title: 'Fix login', stage: 'open' }]])
const edits = []
class IssueModel {                                   // like models.ts: no makeObservable
  constructor(id) { this.id = id }
  get row() { return rows.get(this.id) }
}
for (const f of ['title', 'stage']) Object.defineProperty(IssueModel.prototype, f, {
  enumerable: false, configurable: false,
  get() { return this.row[f] },
  set(v) { edits.push([f, v]); runInAction(() => rows.set(this.id, { ...this.row, [f]: v })) },   // like update(): sends at once
})
const issue = new IssueModel(1)
try { createViewModel(issue); console.log('A our model as-is: accepted') } catch (e) { console.log('A our model as-is: REFUSED -', e.message) }

// Same model, but made a MobX observable object (empty makeObservable gives it MobX bookkeeping)
class IssueModel2 extends IssueModel { constructor(id) { super(id); makeObservable(this, {}) } }
const i2 = new IssueModel2(1)
try {
  const draft = createViewModel(i2)
  draft.title = 'Fix login page'
  console.log('B observable model: draft.title =', draft.title, '| live title =', i2.title, '| sent edits =', edits.length)
  draft.submit()
  console.log('B after submit: live title =', i2.title, '| sent edits =', JSON.stringify(edits))
} catch (e) { console.log('B observable model: REFUSED -', e.message) }
