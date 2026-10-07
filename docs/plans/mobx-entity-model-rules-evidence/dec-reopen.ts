// Does MobX's built-in @computed keep the VALUE after the last screen closes?
import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
const { observable, computed, autorun, runInAction } = mobx as any
let runs = 0
class Issue {
  @observable accessor done = 1
  @computed get label() { runs++; return `done ${this.done}` }
}
const i = new Issue()
let d = autorun(() => i.label); console.log('first show: runs =', runs)
d(); runs = 0
d = autorun(() => i.label); console.log('reopen after close, data unchanged: runs =', runs, runs === 1 ? '(value was thrown away)' : '(value was kept)')
d(); runs = 0
const kept = computed(() => { runs++; return i.done * 2 }, { keepAlive: true })
d = autorun(() => kept.get()); d(); runs = 0
d = autorun(() => kept.get()); console.log('keepAlive reopen, unchanged: runs =', runs)
d(); runs = 0; runInAction(() => { i.done = 5 }); console.log('keepAlive, data changed while closed: background runs =', runs)
d = autorun(() => kept.get()); console.log('keepAlive reopen after a change: runs =', runs); d()
