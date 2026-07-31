import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { harnessEnv } from '../harness-env'
import { newSession, openApp, podium } from './_harness'

const PORT = Number(process.env.PORT ?? 8799)
const BEFORE = 'DAEMON_RESTART_BEFORE_417'
const AFTER = 'DAEMON_RESTART_AFTER_417'

test('daemon restart reattaches the durable terminal and resumes input', async ({ page }) => {
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
  await podium.send(page, BEFORE)
  await expect.poll(async () => (await podium.screen(page)).includes(BEFORE)).toBe(true)

  const before = await podium.screen(page)
  const { stateDir } = harnessEnv(PORT)
  const pid = Number(readFileSync(join(stateDir, 'harness.pid'), 'utf8'))
  const serialPath = join(stateDir, 'daemon-restart-serial')
  const serialBefore = readFileSync(serialPath, 'utf8')
  process.kill(pid, 'SIGUSR2')

  await expect
    .poll(() => readFileSync(serialPath, 'utf8'), { timeout: 30_000 })
    .not.toBe(serialBefore)
  await expect
    .poll(async () => (await podium.screen(page)).includes(BEFORE), { timeout: 20_000 })
    .toBe(true)
  expect(await podium.screen(page)).toBe(before)

  await podium.send(page, AFTER)
  await expect
    .poll(async () => (await podium.screen(page)).includes(AFTER), { timeout: 20_000 })
    .toBe(true)
})
