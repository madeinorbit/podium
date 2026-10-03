import { observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { createBoardProjection } from './issue-board-projection'

it('derives once for initial read plus subscribe and releases the mounted observer', () => {
  const input = observable.box(1),
    read = vi.fn(() => ({ count: input.get() })),
    released = vi.fn(),
    wake = vi.fn()
  const view = createBoardProjection(read, released)
  expect(view.getSnapshot()).toEqual({ count: 1 })
  const off = view.subscribe(wake)
  expect(read).toHaveBeenCalledTimes(1)
  runInAction(() => input.set(2))
  expect(view.getSnapshot()).toEqual({ count: 2 })
  off()
  const calls = read.mock.calls.length
  runInAction(() => input.set(3))
  expect(read).toHaveBeenCalledTimes(calls)
  expect(released).toHaveBeenCalledTimes(1)
})
it('releases an abandoned initial render and can attach again', async () => {
  const input = observable.box(1),
    released = vi.fn()
  const view = createBoardProjection(() => input.get(), released)
  expect(view.getSnapshot()).toBe(1)
  await Promise.resolve()
  expect(released).toHaveBeenCalledTimes(1)
  runInAction(() => input.set(2))
  const off = view.subscribe(() => {})
  expect(view.getSnapshot()).toBe(2)
  off()
})
