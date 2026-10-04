import { expect, it, vi } from 'vitest'
import { attachPoolScreens, type PoolScreen, screenOptions } from './screens'

it('screen declarations union summaries before ingest', () => {
  expect(
    screenOptions(
      [
        {
          options: () => ({ settings: true, summaries: { session: ['title'] } }),
        },
        {
          options: () => ({ summaries: { session: ['title', 'name'] } }),
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

it('source failures surface while attached and are ignored after teardown', async () => {
  const error = vi.fn(),
    failure = new Error('Synthetic attachment failure')
  const entry: PoolScreen = {
    attach: async () => {
      throw failure
    },
  }
  const detach = attachPoolScreens([entry], {} as never, {} as never, error)
  attachPoolScreens([entry], {} as never, {} as never, error)()
  await Promise.resolve()
  await Promise.resolve()
  expect(error).toHaveBeenCalledExactlyOnceWith(failure)
  detach()
})
