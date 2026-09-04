/**
 * POD-1469: the launch box's two modes, and the fold between them.
 *
 * Shot from the stubbed cold-start harness (`vite.coldstart.config.ts`, port
 * 55598) so the box is the shipping component against the shipping stylesheet
 * with nothing behind it — the fold is a CSS height transition, and it can only
 * be sampled honestly on a main thread nothing else is using.
 *
 *   bun apps/web/e2e/pod1469-composer-shots.ts <outDir>
 */
import { chromium } from 'playwright'

const OUT = process.argv[2] ?? '/tmp/pod1469'
const ORIGIN = 'http://localhost:55598/coldstart-harness.html?first=0'

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 1180, height: 720 },
  deviceScaleFactor: 2,
})
const page = await ctx.newPage()
page.setDefaultTimeout(60_000)

const boxHeight = (): Promise<number> =>
  page.evaluate(() => {
    const input = document.querySelector('.cold-start-input') as HTMLElement
    return Math.round(input.getBoundingClientRect().height)
  })

for (const mode of ['dark', 'light'] as const) {
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
  await page.evaluate((m) => {
    document.documentElement.dataset.theme = 'podium'
    document.documentElement.classList.toggle('dark', m === 'dark')
  }, mode)
  await page.waitForSelector('[data-testid="cold-start-field"]')
  await page.waitForTimeout(800)

  const closed = await boxHeight()
  const launchClosed = await page.locator('[data-testid="cold-start-launch"]').isEnabled()
  await page.screenshot({ path: `${OUT}/composer-${mode}-closed.png` })

  // Halfway through the fold: proof it is a transition and not a jump cut.
  await page.locator('.cold-start-input').click()
  await page.waitForTimeout(50)
  const midway = await boxHeight()
  await page.screenshot({ path: `${OUT}/composer-${mode}-midfold.png` })

  await page.waitForTimeout(400)
  const open = await boxHeight()
  const launchOpenEmpty = await page.locator('[data-testid="cold-start-launch"]').isEnabled()
  await page.screenshot({ path: `${OUT}/composer-${mode}-open-empty.png` })

  await page.locator('.cold-start-input').fill(
    'Rework the flight deck header so a mission with twelve sessions still reads at a glance.',
  )
  await page.waitForTimeout(200)
  const launchOpenTyped = await page.locator('[data-testid="cold-start-launch"]').isEnabled()
  await page.screenshot({ path: `${OUT}/composer-${mode}-open-typed.png` })

  // The X clears and re-folds.
  await page.locator('[data-testid="cold-start-collapse"]').click()
  await page.waitForTimeout(500)
  const reclosed = await boxHeight()
  const cleared = await page.locator('.cold-start-input').inputValue()

  console.log(
    JSON.stringify({
      mode,
      closed,
      midway,
      open,
      reclosed,
      cleared: cleared === '',
      // The whole behavioural claim, in four booleans.
      launchClosed,
      launchOpenEmpty,
      launchOpenTyped,
      midwayIsBetween: midway > closed && midway < open,
    }),
  )
}
await browser.close()
