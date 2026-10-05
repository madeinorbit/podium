import { autorun, computed, configure, observable, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { configureDevelopmentChecks } from './development'
import { allowImperativeRead, assertReactiveRead, keyedComputed } from './keyed-computed'

afterEach(() => {
  configure({ enforceActions: 'never', computedRequiresReaction: false,
    reactionRequiresObservable: false, observableRequiresReaction: false })
  vi.restoreAllMocks()
})

it('enables action, computed and reaction diagnostics while permitting ordinary event reads', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  configureDevelopmentChecks(true)
  const value = observable.box(1)
  expect(value.get()).toBe(1)
  expect(warn).not.toHaveBeenCalled()
  value.set(2)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('strict-mode'))
  warn.mockClear()
  const derived = computed(() => value.get())
  derived.get()
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('outside a reactive context'))
  warn.mockClear()
  const stop = autorun(() => {})
  stop()
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("doesn't read any observable"))
  warn.mockClear()
  runInAction(() => value.set(3))
  expect(allowImperativeRead(() => derived.get())).toBe(3)
  expect(warn).not.toHaveBeenCalled()
})

it('leaves production configuration untouched, including an operator supplied configuration', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  configure({ enforceActions: 'never', computedRequiresReaction: false,
    reactionRequiresObservable: false, observableRequiresReaction: false })
  configureDevelopmentChecks(false)
  const value = observable.box(1)
  value.set(2)
  computed(() => value.get()).get()
  autorun(() => {})()
  expect(warn).not.toHaveBeenCalled()
  configure({ computedRequiresReaction: true })
  configureDevelopmentChecks(false)
  computed(() => value.get()).get()
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('outside a reactive context'))
})

it('diagnoses untracked keyed model reads without warning for actions or losing reactive dependencies', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  configureDevelopmentChecks(true)
  const value = observable.box(1), seen: number[] = []
  const read = keyedComputed('model.facts', () => value.get(), { requiresReaction: true })
  read('id')
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('outside a reactive context'))
  warn.mockClear()
  expect(allowImperativeRead(() => read('id'))).toBe(1)
  const stop = autorun(() => seen.push(allowImperativeRead(() => read('id'))))
  runInAction(() => value.set(2))
  expect(seen).toEqual([1, 2])
  expect(warn).not.toHaveBeenCalled()
  stop()
})

it('requires a tracked context for live hooks and rejects an action as a render substitute', () => {
  expect(() => assertReactiveRead('useShellDock')).toThrow('useShellDock must run inside an observer')
  expect(() => runInAction(() => assertReactiveRead('useShellDock'))).toThrow('inside an observer')
  const value = observable.box(1), seen: number[] = []
  const stop = autorun(() => { assertReactiveRead('useShellDock'); seen.push(value.get()) })
  runInAction(() => value.set(2))
  expect(seen).toEqual([1, 2])
  stop()
})
