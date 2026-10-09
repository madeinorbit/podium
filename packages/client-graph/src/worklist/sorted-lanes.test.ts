import { autorun, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { createQueryResult } from '../query-result'
import { SortedLanes } from './sorted-lanes'

it('keeps historical lanes and output identity when order keys stay between neighbours', () => {
  const lanes = new SortedLanes<string, number>((a, b) => a - b, 'test lanes')
  runInAction(() => { lanes.file('a', 'one', 1); lanes.file('b', 'one', 3); lanes.file('c', 'one', 5) })
  const saved = lanes.lane('one')
  expect(runInAction(() => lanes.file('b', 'one', 4))).toBe(0)
  expect(lanes.lane('one')).toBe(saved)
  expect(runInAction(() => lanes.file('b', 'one', 6))).toBe(1)
  expect(lanes.lane('one')).toEqual(['a', 'c', 'b'])
  expect(saved).toEqual(['a', 'b', 'c'])
  expect(runInAction(() => lanes.file('c', 'two', 5))).toBe(2)
  expect(lanes.lane('one')).toEqual(['a', 'b']); expect(lanes.lane('two')).toEqual(['c'])
  runInAction(() => lanes.file('a', undefined, undefined))
  expect(lanes.lane('one')).toEqual(['b'])
})

it('notifies reset subscribers once even when they register again during notification', () => {
  const lanes = new SortedLanes<string, number>((a, b) => a - b, 'reset lanes')
  let calls = 0, stop: () => void
  const changed = () => {
    if (++calls > 1) throw new Error('Reset visited a re-registered subscriber twice')
    stop(); stop = lanes.subscribe('one', changed)
  }
  stop = lanes.subscribe('one', changed)
  try { runInAction(() => lanes.clear()); expect(calls).toBe(1) } finally { stop() }
})

it('resets a demanded query to empty and publishes the next keyed member', () => {
  const lanes = new SortedLanes<string, number>((a, b) => a - b, 'queried lanes')
  runInAction(() => lanes.file('a', 'one', 1))
  const query = createQueryResult({ name: 'lane subset', ids: () => lanes.lane('one'),
    has: id => lanes.hasIn('one', id), read: id => id, subscribe: changed => lanes.subscribe('one', changed) })
  let ids: unknown
  const stop = autorun(() => { ids = query.get() })
  try {
    expect(ids).toEqual(['a'])
    runInAction(() => lanes.clear()); expect(ids).toEqual([])
    runInAction(() => lanes.file('b', 'one', 2)); expect(ids).toEqual(['b'])
  } finally { stop(); query.dispose() }
})
