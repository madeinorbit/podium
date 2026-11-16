// Screenshot the session's launch terms in the model chip harness (POD-6858
// Task 11): the mode chip beside the model chip, as requested and as reported,
// and the composer's posture notices. Start the harness first with
// `bun --bun x vite --config vite.model-chip.config.ts` from apps/web.
// Usage: bun harness/posture-shots.ts <outDir>
import { readdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const out = process.argv[2] ?? '.'
const cache = `${process.env.HOME}/.cache/ms-playwright`
const shell = readdirSync(cache).find((dir) => dir.startsWith('chromium_headless_shell'))
if (!shell) throw new Error(`no chromium headless shell under ${cache}`)
const browser = await chromium.launch({
  executablePath: `${cache}/${shell}/chrome-headless-shell-linux64/chrome-headless-shell`,
})
const errors: string[] = []
for (const theme of ['dark', 'light'] as const) {
  const page = await browser.newPage({
    viewport: { width: 720, height: 400 },
    deviceScaleFactor: 2,
  })
  page.on('pageerror', (e) => errors.push(String(e.stack ?? e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.addInitScript((mode) => localStorage.setItem('podium.theme.mode', mode), theme)
  await page.goto('http://localhost:55595/model-chip-harness.html')
  await page.waitForSelector('[data-testid="posture-notices"]', { timeout: 30_000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${out}/posture-${theme}.png` })
  await page.hover('[data-row="mode-requested"] [data-testid="session-mode"]')
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${out}/posture-${theme}-requested-tooltip.png` })
  const facts = await page.evaluate(() => ({
    modes: [...document.querySelectorAll('[data-testid="session-mode"]')].map((chip) => [
      chip.textContent,
      chip.getAttribute('data-provenance'),
    ]),
    notices: [...document.querySelectorAll('[data-notice="posture"]')].map((n) => n.textContent),
  }))
  console.log(theme, JSON.stringify(facts))
  await page.close()
}
console.log('errors', JSON.stringify(errors.slice(0, 8)))
await browser.close()
