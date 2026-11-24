import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
})

async function load() {
  return await import('./first-route')
}

it('releases deferred work when the first route lays out, and at once afterwards', async () => {
  const route = await load()
  let released = false
  const pending = route.afterFirstRoute().then(() => {
    released = true
  })
  await Promise.resolve()
  expect(released).toBe(false)
  expect(route.firstRouteReached()).toBe(false)
  route.markFirstRoute()
  await pending
  expect(released).toBe(true)
  expect(route.firstRouteReached()).toBe(true)
  await expect(route.afterFirstRoute()).resolves.toBeUndefined()
})

it('releases deferred work after the cap when no route ever reports', async () => {
  vi.useFakeTimers()
  const route = await load()
  let released = false
  void route.afterFirstRoute(1500).then(() => {
    released = true
  })
  await vi.advanceTimersByTimeAsync(1499)
  expect(released).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(released).toBe(true)
  expect(route.firstRouteReached()).toBe(false)
})

it('notifies React subscribers once, and not after it has passed', async () => {
  const route = await load()
  const listener = vi.fn()
  const stop = route.subscribeFirstRoute(listener)
  route.markFirstRoute()
  route.markFirstRoute()
  expect(listener).toHaveBeenCalledOnce()
  stop()
  const late = vi.fn()
  route.subscribeFirstRoute(late)()
  expect(late).not.toHaveBeenCalled()
})
