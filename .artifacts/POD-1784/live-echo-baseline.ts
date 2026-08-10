import { firefox } from '@playwright/test'

const token = process.env.PODIUM_BROWSER_TOKEN
if (!token) throw new Error('PODIUM_BROWSER_TOKEN is required')

const browser = await firefox.launch({ headless: true })
const context = await browser.newContext({ ignoreHTTPSErrors: true })
await context.addCookies([{ name: 'podium_session', value: token, url: 'http://localhost:18787' }])
const page = await context.newPage()
await page.addInitScript(() => localStorage.setItem('podium.panelMode', 'native'))
await page.goto('http://localhost:18787/?e2e=1', { waitUntil: 'domcontentloaded', timeout: 30_000 })
await page.getByRole('button', { name: 'New panel' }).waitFor({ timeout: 120_000 })

const beforeIds = await page.evaluate(() => {
  const api = (window as unknown as { __podium?: { sessions(): Array<{ sessionId: string }> } })
    .__podium
  return api?.sessions().map((session) => session.sessionId) ?? []
})

await page.getByRole('button', { name: 'New panel' }).click()
await page.getByRole('menuitem', { name: 'New Shell' }).click()
await page.waitForFunction(
  () =>
    typeof (window as unknown as { __podium?: { echoLatency?: unknown } }).__podium
      ?.echoLatency === 'function',
  undefined,
  { timeout: 120_000 },
)
await page.locator('.xterm-helper-textarea').last().focus()

type Stats = { count: number; p50: number | null; p90: number | null; max: number | null; lastMs: number | null }
const stats = (): Promise<Stats> =>
  page.evaluate(() =>
    (window as unknown as { __podium: { echoLatency(): Stats } }).__podium.echoLatency(),
  )

const samples: Array<{ key: string; observedMs: number; tracker: Stats }> = []
for (let i = 0; i < 20; i += 1) {
  for (const key of ['x', 'Backspace']) {
    const before = await stats()
    const startedAt = Date.now()
    await page.keyboard.press(key)
    await page.waitForFunction(
      (count) =>
        (window as unknown as { __podium: { echoLatency(): Stats } }).__podium.echoLatency()
          .count > count,
      before.count,
      { timeout: 3_000 },
    )
    samples.push({ key, observedMs: Date.now() - startedAt, tracker: await stats() })
    await page.waitForTimeout(100)
  }
}

const sessions = await page.evaluate(() =>
  (window as unknown as {
    __podium: { sessions(): Array<{ sessionId: string; agentKind: string; status: string; cwd: string }> }
  }).__podium.sessions(),
)
const created = sessions.find((session) => !beforeIds.includes(session.sessionId))
const finalStats = await stats()

// Leave no live process or typed draft behind.
await page.evaluate(() =>
  (window as unknown as { __podium: { sendInput(value: string): void } }).__podium.sendInput('exit\r'),
)
await page.waitForTimeout(500)

console.log(JSON.stringify({ created, finalStats, samples }, null, 2))
await browser.close()
