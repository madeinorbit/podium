import { autorun, compareStructural, observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { cachedGroup, cachedKey, keyedViews } from './cached'

it('model groups default to identity while fresh summaries opt into structural equality', () => {
  const row = { id: 'a', input: observable.box(0) }
  const derive = (target: typeof row) => { target.input.get(); return { answer: 1 } }
  const identity = cachedGroup('identity', derive), structural = cachedGroup('structural', derive, compareStructural)
  const render = vi.fn(() => identity(row)), stable = vi.fn(() => structural(row))
  const stop = autorun(render), stopStable = autorun(stable)
  try {
    runInAction(() => row.input.set(1))
    expect(render).toHaveBeenCalledTimes(2)
    expect(stable).toHaveBeenCalledTimes(1)
  } finally { stop(); stopStable() }
})

it('service keys default to identity', () => {
  const input = observable.box(0)
  const read = cachedKey('owner', 'group', (_key: string) => { input.get(); return { answer: 1 } })
  const render = vi.fn(() => read('a')), stop = autorun(render)
  try {
    runInAction(() => input.set(1))
    expect(render).toHaveBeenCalledTimes(2)
  } finally { stop() }
})

it('keyed view bodies are released on unmount and never retained by a gesture', () => {
  const view = keyedViews<number>('owner', 'view')
  expect(view('a', () => 0)).toBe(0)
  const first = autorun(() => expect(view('a', () => 1)).toBe(1))
  first()
  expect(view('a', () => 2)).toBe(2)
  const next = autorun(() => expect(view('a', () => 3)).toBe(3))
  next()
})
