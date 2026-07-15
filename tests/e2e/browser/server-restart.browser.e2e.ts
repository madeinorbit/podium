import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { harnessEnv } from '../harness-env'
import { newSession, openApp, podium } from './_harness'

const PORT = Number(process.env.PORT ?? 8799)
const MARKER = 'SERVER_RESTART_CONTINUITY_528'

type Sample = {
  connected: boolean
  cols: number
  rows: number
  hasMarker: boolean
}

test('server restart preserves the terminal screen and grid without a default-size flash', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openApp(page)
  await newSession(page, 'Claude')

  await page.waitForFunction(
    () =>
      /keyecho/.test(
        (window as unknown as { __podium?: { screenText(): string } }).__podium?.screenText() ?? '',
      ),
    undefined,
    { timeout: 15_000 },
  )
  await podium.send(page, MARKER)
  await expect.poll(async () => (await podium.screen(page)).includes(MARKER)).toBe(true)

  const before = await page.evaluate(() => {
    const api = (
      window as unknown as {
        __podium: {
          state(): { connected: boolean; cols: number; rows: number }
          screenText(): string
        }
      }
    ).__podium
    return { state: api.state(), screen: api.screenText() }
  })
  expect(before.state).not.toMatchObject({ cols: 80, rows: 24 })

  await page.evaluate((marker) => {
    type RestartWindow = Window & {
      __podium: {
        state(): { connected: boolean; cols: number; rows: number }
        screenText(): string
      }
      __restartSamples?: Sample[]
      __restartSampler?: number
    }
    const w = window as unknown as RestartWindow
    w.__restartSamples = []
    w.__restartSampler = window.setInterval(() => {
      const state = w.__podium.state()
      const screen = w.__podium.screenText()
      w.__restartSamples?.push({
        connected: state.connected,
        cols: state.cols,
        rows: state.rows,
        hasMarker: screen.includes(marker),
      })
    }, 10)
  }, MARKER)

  const { stateDir } = harnessEnv(PORT)
  const pid = Number(readFileSync(join(stateDir, 'harness.pid'), 'utf8'))
  const serialBefore = readFileSync(join(stateDir, 'restart-serial'), 'utf8')
  process.kill(pid, 'SIGUSR1')

  await page.waitForFunction(
    () =>
      !(window as unknown as { __podium?: { state(): { connected: boolean } } }).__podium?.state()
        .connected,
    undefined,
    { timeout: 10_000 },
  )
  const during = await page.evaluate(() => {
    const api = (
      window as unknown as {
        __podium: { state(): { cols: number; rows: number }; screenText(): string }
      }
    ).__podium
    return { state: api.state(), screen: api.screenText() }
  })
  expect(during.screen).toBe(before.screen)
  expect(during.state).toMatchObject({ cols: before.state.cols, rows: before.state.rows })

  await expect
    .poll(() => readFileSync(join(stateDir, 'restart-serial'), 'utf8'), { timeout: 15_000 })
    .not.toBe(serialBefore)
  await page.waitForFunction(
    (marker) => {
      const api = (
        window as unknown as {
          __podium?: { state(): { connected: boolean }; screenText(): string }
        }
      ).__podium
      return api?.state().connected === true && api.screenText().includes(marker)
    },
    MARKER,
    { timeout: 20_000 },
  )
  await page.waitForTimeout(1_500)

  const samples = await page.evaluate(() => {
    type RestartWindow = Window & { __restartSamples?: Sample[]; __restartSampler?: number }
    const w = window as unknown as RestartWindow
    if (w.__restartSampler !== undefined) window.clearInterval(w.__restartSampler)
    return w.__restartSamples ?? []
  })
  expect(samples.some((sample) => !sample.connected)).toBe(true)
  expect(samples.length).toBeGreaterThan(20)
  for (const sample of samples) {
    expect(sample.cols).toBe(before.state.cols)
    expect(sample.rows).toBe(before.state.rows)
    expect(sample.hasMarker).toBe(true)
  }
})
