import { expect, type Page, type TestInfo, test } from '@playwright/test'
import { type Relay, startRelay } from './harness'

let relay: Relay

test.beforeEach(async () => {
  relay = await startRelay()
})
test.afterEach(async () => {
  await relay.stop()
})

function appUrl(): string {
  return `/?server=ws://localhost:${relay.serverPort}&test=1`
}
async function state(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const p = (globalThis as unknown as { __podium?: { state(): Record<string, unknown> } })
      .__podium
    return p ? p.state() : {}
  })
}
async function screenText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const p = (globalThis as unknown as { __podium?: { screenText(): string } }).__podium
    return p ? p.screenText() : ''
  })
}
async function screenHash(page: Page): Promise<string> {
  return page.evaluate(() => {
    const p = (globalThis as unknown as { __podium?: { screenHash(): string } }).__podium
    return p ? p.screenHash() : ''
  })
}
async function waitText(page: Page, needle: string): Promise<void> {
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain(needle)
}

test('renders live fixture output through the full chain', async ({ page }) => {
  await page.goto(appUrl())
  await waitText(page, 'PODIUM-FIXTURE')
})

test('takeover converges two clients on identical epoch + screenHash', async ({ browser }) => {
  const a = await browser.newPage()
  const b = await browser.newPage()
  await a.goto(appUrl())
  await b.goto(appUrl())
  await waitText(a, 'PODIUM-FIXTURE')
  await waitText(b, 'PODIUM-FIXTURE')

  await b.evaluate(() =>
    (globalThis as unknown as { __podium: { takeControl(): void } }).__podium.takeControl(),
  )
  await expect.poll(async () => (await state(a)).epoch, { timeout: 10_000 }).toBe(1)
  await expect.poll(async () => (await state(b)).epoch, { timeout: 10_000 }).toBe(1)
  // force a fresh repaint into both, then compare buffer hashes
  await b.evaluate(() =>
    (globalThis as unknown as { __podium: { sendInput(s: string): void } }).__podium.sendInput(
      '\f',
    ),
  )
  await expect
    .poll(async () => `${await screenHash(a)}|${await screenHash(b)}`, { timeout: 10_000 })
    .toMatch(/^([0-9a-f]+)\|\1$/)
  await a.close()
  await b.close()
})

test('synthetic keyboard resizes the agent and reconverges', async ({ page }) => {
  await page.goto(appUrl())
  await waitText(page, 'cols=')
  const before = (await state(page)).rows as number
  await page.evaluate(() =>
    (
      globalThis as unknown as { __podium: { simulateKeyboard(n: number): void } }
    ).__podium.simulateKeyboard(300),
  )
  await expect.poll(async () => (await state(page)).rows, { timeout: 10_000 }).toBeLessThan(before)
  const after = (await state(page)).rows as number
  await waitText(page, `rows=${after}`)
})

test('toolbar Ctrl-C reaches the agent (fixture exits)', async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.name === 'chromium-desktop', 'key toolbar is mobile-only')
  await page.goto(appUrl())
  await waitText(page, 'PODIUM-FIXTURE')
  await page.click('#toolbar button[data-key="Ctrl-C"]')
  // fixture exits 0 → agentExit relayed. Assert the client still has a session (no crash).
  await expect.poll(async () => (await state(page)).connected, { timeout: 10_000 }).toBe(true)
})

test('physical keyboard input reaches the agent', async ({ page }) => {
  await page.goto(appUrl())
  await waitText(page, 'PODIUM-FIXTURE')
  await page.locator('#term').click() // focus the terminal
  await page.keyboard.type('x')
  // the fixture echoes the last input chunk as hex; 'x' === 0x78
  await waitText(page, 'last-input=78')
})

test('Take control button bumps epoch', async ({ page }) => {
  await page.goto(appUrl())
  await waitText(page, 'PODIUM-FIXTURE')
  await page.click('button[data-action="take-control"]')
  await expect
    .poll(async () => (await state(page)).epoch, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1)
})
