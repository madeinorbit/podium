import { expect, it, vi } from 'vitest'
import { createStartupTiming } from './startup-timing'

function reportLine(lines: string[], prefix: string): string {
  const line = lines.find((line) => line.startsWith(prefix))
  if (line === undefined) throw new Error(`Missing ${prefix} report`)
  return line
}

it.each([
  false,
  true,
])('keeps search timing in its own short log when the main report is truncated, expired: %s', (expired) => {
  let now = 100
  const lines: string[] = []
  const trace = createStartupTiming(
    () => now,
    (line) => lines.push(line),
  )
  for (let i = 0; i < 60; i++) trace.mark(`long-startup-stage-${i}-with-a-substantial-name`)
  now = 200
  trace.mark('launch.search-budget-start')
  now = expired ? 700 : 250
  if (expired) trace.mark('launch.search-expired')
  trace.mark('launch.search-ready')
  trace.mark('work.native-list-appear')
  trace.mark('launch.overlay-hidden')
  const main = lines.find((line) => line.startsWith('[podium-startup] '))
  expect(main?.length).toBeGreaterThan(1018)
  const search = reportLine(lines, '[podium-startup-search] ')
  expect(search.length).toBeLessThan(300)
  const report = JSON.parse(search.replace('[podium-startup-search] ', ''))
  expect(report.marks['launch.search-budget-start']).toBe(100)
  expect(report.marks['launch.search-ready']).toBe(expired ? 600 : 150)
  expect(report.marks['launch.search-expired']).toBe(expired ? 600 : undefined)
  trace.mark('launch.search-ready')
  expect(lines.filter((line) => line.startsWith('[podium-startup-search] '))).toHaveLength(1)
})

it.each([
  true,
  false,
])('logs each record once after native Work and overlay removal, appearance first: %s', (appearanceFirst) => {
  let now = 100
  const write = vi.fn()
  const trace = createStartupTiming(() => now, write)
  now = 120
  trace.mark('profile.restore.end')
  now = 150
  trace.mark('profile.restore.end')
  const [first, second] = appearanceFirst
    ? (['work.native-list-appear', 'launch.overlay-hidden'] as const)
    : (['launch.overlay-hidden', 'work.native-list-appear'] as const)
  trace.mark(first)
  expect(write).not.toHaveBeenCalled()
  now = 180
  trace.mark(second)
  expect(write).toHaveBeenCalledTimes(2)
  const report = JSON.parse(
    reportLine(
      write.mock.calls.map(([line]) => line),
      '[podium-startup] ',
    ).replace('[podium-startup] ', ''),
  )
  expect(report.runtimeEntryMs).toBe(100)
  expect(report.marks['profile.restore.end']).toBe(20)
  expect(report.marks[second]).toBe(80)
  trace.mark('reconnect')
  trace.mark('work.native-list-appear')
  expect(write).toHaveBeenCalledTimes(2)
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
  const report = reportLine(
    write.mock.calls.map(([line]) => line),
    '[podium-startup] ',
  )
  expect(report).toContain('restore.end')
  expect(report).toContain('failed.error')
  for (const [line] of write.mock.calls) expect(line).not.toContain('must not log')
})
