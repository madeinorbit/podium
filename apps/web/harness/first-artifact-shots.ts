// Screenshot the first-artifact moment (POD-2202) in light and dark. Start the
// harness first: `bunx vite --config vite.tips.config.ts --port 55712` from apps/web.
// Usage: bun harness/first-artifact-shots.ts <outDir>
import { chromium } from '@playwright/test'

const out = process.argv[2] ?? '.'
const base = process.env.HARNESS_URL ?? 'http://localhost:55712/harness/first-artifact.html'
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`,
})
const errors: string[] = []
for (const theme of ['light', 'dark']) {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 640 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  })
  page.on('pageerror', (e) => errors.push(String(e)))
  const next = page.getByRole('button', { name: /^(Next|Got it)$/ })
  // Panel open: card 1 on the thumbnail, then card 2 on the +.
  await page.goto(`${base}?scene=panel&theme=${theme}`)
  await page.getByText('Your agent made something.').waitFor({ timeout: 30_000 })
  await page.screenshot({ path: `${out}/first-artifact-card1-${theme}.png` })
  await next.click()
  await page.getByText('All in one tab.').waitFor()
  await page.screenshot({ path: `${out}/first-artifact-card2-${theme}.png` })
  // Panel closed: the dot waits on the Task cell; opening the panel shows the tip.
  await page.goto(`${base}?scene=closed&theme=${theme}`)
  await page.getByTestId('first-artifact-dot').waitFor()
  await page.waitForTimeout(1200)
  if (await page.getByText('Your agent made something.').isVisible())
    errors.push('tip showed with the panel closed')
  await page.screenshot({ path: `${out}/first-artifact-closed-${theme}.png` })
  await page.getByRole('button', { name: 'Task' }).click()
  await page.getByText('Your agent made something.').waitFor()
  // Offer: first-offer still pending holds the tip; once seen, card 1 points at the strip.
  await page.goto(`${base}?scene=offer&theme=${theme}`)
  await page.waitForTimeout(1200)
  if (await page.getByText('Your agent made something.').isVisible())
    errors.push('tip jumped ahead of first-offer')
  await page.evaluate(() =>
    (
      window as never as { tipHarness: { log: { record(id: string, o: string): void } } }
    ).tipHarness.log.record('first-offer', 'finished'),
  )
  await page.getByText('Your agent made something.').waitFor()
  await page.screenshot({ path: `${out}/first-artifact-offer-${theme}.png` })
  await page.close()
}
console.log('errors', JSON.stringify(errors))
await browser.close()
