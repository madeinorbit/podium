import { expect, it, vi } from 'vitest'
import { attachPoolScreens, type PoolScreen, screenOptions } from './screens'

it('screen declarations union enabled summaries before ingest', () => {
  expect(
    screenOptions(
      [
        {
          initialize() {},
          enabled: () => true,
          options: () => ({ settings: true, summaries: { session: ['title'] } }),
        },
        {
          initialize() {},
          enabled: () => true,
          options: () => ({ summaries: { session: ['title', 'name'] } }),
        },
        {
          initialize() {},
          enabled: () => false,
          options: () => ({ header: true, summaries: { session: ['privateBody'] } }),
        },
      ],
      {} as never,
    ),
  ).toEqual({ settings: true, summaries: { session: ['title', 'name'] } })
})

it('screen registry releases late attachments after principal teardown exactly once', async () => {
  let finish!: (stop: () => void) => void
  const stop = vi.fn(),
    error = vi.fn()
  const screen: PoolScreen = {
    initialize() {},
    enabled: () => true,
    attach: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  }
  const detach = attachPoolScreens([screen], {} as never, {} as never, error)
  detach()
  detach()
  finish(stop)
  await Promise.resolve()
  expect(stop).toHaveBeenCalledTimes(1)
  expect(error).not.toHaveBeenCalled()
})

it('required source failures surface and optional diagnostics retain isolation', async () => {
  const error = vi.fn(),
    failure = new Error('Synthetic attachment failure')
  const entry = (optional: boolean): PoolScreen => ({
    optional,
    initialize() {},
    enabled: () => true,
    attach: async () => {
      throw failure
    },
  })
  const detach = attachPoolScreens([entry(true), entry(false)], {} as never, {} as never, error)
  await Promise.resolve()
  await Promise.resolve()
  expect(error).toHaveBeenCalledExactlyOnceWith(failure)
  detach()
})
