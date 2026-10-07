// "Frozen while open": a derived field computed when the screen opens and NOT updated while it stays open.
// Built from the landed @lazy plus MobX's untracked(): no new helper.
import * as mobx from '/home/mgw/src/other/podium/node_modules/.bun/mobx@7.0.3/node_modules/mobx/dist/index.js'
import { lazy } from './lazy.ts'
const { observable, autorun, runInAction, untracked } = mobx as any
const activity = observable.map<string, number>([['a', 3], ['b', 2], ['c', 1]])
let runs = 0
class Launcher {
  @lazy get repoOrder(): string[] {            // frozen: reads its inputs untracked
    return untracked(() => { runs++; return [...activity.keys()].sort((x, y) => activity.get(y)! - activity.get(x)!) })
  }
}
const l = new Launcher()
const check = (n: string, ok: boolean, d: string) => console.log(`${ok ? 'PASS' : 'FAIL'} ${n} — ${d}`)
let shown: string[] = []
let d = autorun(() => { shown = l.repoOrder })
check('opening computes the order once', runs === 1 && shown.join() === 'a,b,c', `runs=${runs} order=${shown}`)
runInAction(() => activity.set('c', 9))
check('activity while open: no work, order does not jump', runs === 1 && shown.join() === 'a,b,c', `runs=${runs} order=${shown}`)
d()
d = autorun(() => { shown = l.repoOrder })
check('reopening computes the new order', runs === 2 && shown.join() === 'c,a,b', `runs=${runs} order=${shown}`)
d()
