import { expect, it, vi } from 'vitest'
import { createStartupTiming } from './startup-timing'

it.each([
  true,
  false,
])('logs once only after native Work and overlay removal, appearance first: %s', (appearanceFirst) => {
  let now = 100
  const write = vi.fn()
  const trace = createStartupTiming(() => now, write)
  now = 120
  trace.mark('profile.restore.end')
  now = 150
  trace.mark('profile.restore.end')
  const signals = ['work.native-list-appear', 'launch.overlay-hidden']
  if (!appearanceFirst) signals.reverse()
  trace.mark(signals[0]!)
  expect(write).not.toHaveBeenCalled()
  now = 180
  trace.mark(signals[1]!)
  expect(write).toHaveBeenCalledOnce()
  const report = JSON.parse(write.mock.calls[0]![0].replace('[podium-startup] ', ''))
  expect(report.runtimeEntryMs).toBe(100)
  expect(report.marks['profile.restore.end']).toBe(20)
  expect(report.marks[signals[1]!]).toBe(80)
  trace.mark('reconnect')
  trace.mark('work.native-list-appear')
  expect(write).toHaveBeenCalledOnce()
})

it('preserves async results and failures without logging payloads', async () => {
  const write = vi.fn()
  const trace = createStartupTiming(() => 0, write)
  const result = { secret: 'must not log' }
  expect(await trace.measure('restore', async () => result)).toBe(result)
  const error = new Error('must not log either')
  await expect(
    trace.measure('failed', async () => {
      throw error
    }),
  ).rejects.toBe(error)
  trace.mark('work.native-list-appear')
  trace.mark('launch.overlay-hidden')
  expect(write.mock.calls[0]![0]).toContain('restore.end')
  expect(write.mock.calls[0]![0]).toContain('failed.error')
  expect(write.mock.calls[0]![0]).not.toContain('must not log')
})
