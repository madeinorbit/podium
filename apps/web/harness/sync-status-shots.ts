// Screenshot the sync item harness (POD-6852). Start it first with
// `bunx vite --config vite.sync-status-harness.config.ts` from apps/web.
// Usage: bun harness/sync-status-shots.ts <outDir>
import { readdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const out = process.argv[2] ?? '.'
const cache = `${process.env.HOME}/.cache/ms-playwright`
const shell = readdirSync(cache)
  .filter((name) => name.startsWith('chromium_headless_shell-'))
  .sort()
  .at(-1)
const browser = await chromium.launch({
  executablePath: `${cache}/${shell}/chrome-headless-shell-linux64/chrome-headless-shell`,
})
const errors: string[] = []

const shots: { state: string; open?: boolean }[] = [
  { state: 'idle' },
  { state: 'catching' },
  { state: 'catching', open: true },
  { state: 'sending' },
  { state: 'review' },
  { state: 'review', open: true },
  { state: 'offline' },
  { state: 'offline', open: true },
  { state: 'paused' },
  { state: 'paused', open: true },
  { state: 'slow' },
  { state: 'wake' },
  { state: 'wake', open: true },
]

for (const theme of ['dark', 'light']) {
  for (const shot of shots) {
    const page = await browser.newPage({
      viewport: { width: 960, height: 600 },
      deviceScaleFactor: 2,
    })
    page.on('pageerror', (error) => errors.push(`${shot.state}: ${error.message}`))
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`${shot.state}: ${msg.text()}`)
    })
    await page.goto(
      `http://localhost:55614/harness/sync-status.html?state=${shot.state}&theme=${theme}`,
    )
    // Past every enter delay (1.5 s at most).
    await page.waitForTimeout(1900)
    if (shot.open) {
      await page.getByTestId('sync-item').click()
      await page.getByTestId('sync-panel').waitFor()
      await page.waitForTimeout(250)
    }
    const name = `${shot.state}${shot.open ? '-panel' : ''}-${theme}`
    await page.screenshot({ path: `${out}/${name}.png` })
    await page.close()
  }
}
await browser.close()
if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log(`wrote ${shots.length * 2} shots to ${out}`)
