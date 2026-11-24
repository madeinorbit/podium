/** Capture the shipping help controls from the stubbed model-chip Vite harness.
 * Start apps/web/vite.model-chip.config.ts, then:
 * bun apps/web/harness/control-help-shots.ts /tmp/control-help
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

interface HelpCase {
  id: string
  label: string
  target?: string
  click?: boolean
  catalog?: string
}

const out = process.argv[2] ?? '/tmp/control-help'
const base = process.env.CONTROL_HELP_URL ?? 'http://localhost:55595/model-chip-harness.html'
mkdirSync(out, { recursive: true })
const cache = join(homedir(), '.cache/ms-playwright')
const shell = readdirSync(cache).findLast((dir) => dir.startsWith('chromium_headless_shell'))
if (!shell) throw new Error('Install the Playwright Chromium headless shell first.')
const browser = await chromium.launch({
  executablePath: join(cache, shell, 'chrome-headless-shell-linux64/chrome-headless-shell'),
})
const page = await browser.newPage({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 2 })
const errors: string[] = []
page.on('pageerror', (error) => errors.push(String(error)))
await page.addInitScript(() => localStorage.setItem('podium.theme.mode', 'dark'))
const captured: Array<HelpCase & { text: string; screenshot: string }> = []
try {
  await page.goto(`${base}?help=model-confirmed`)
  await page.locator('#control-help-cases').waitFor({ state: 'attached' })
  const cases = JSON.parse(
    (await page.locator('#control-help-cases').textContent()) ?? '[]',
  ) as HelpCase[]
  for (const example of cases) {
    const query = new URLSearchParams({ help: example.id })
    if (example.catalog) query.set('catalog', example.catalog)
    await page.goto(`${base}?${query}`)
    await page.locator(`[data-help-case="${example.id}"]`).waitFor()
    let text: string
    if (example.target) {
      const trigger = page.locator(example.target)
      if (example.click) {
        await trigger.click()
        await page.getByRole('menu').waitFor()
        text = (await page.getByRole('menu').innerText()).trim()
      } else {
        if (await trigger.isDisabled()) await trigger.locator('..').hover()
        else await trigger.focus()
        const tooltip = page.getByRole('tooltip')
        await tooltip.waitFor()
        text = (await tooltip.innerText()).trim()
        const description = await trigger.getAttribute('aria-description')
        const name = await trigger.getAttribute('aria-label')
        if (description !== text && !name?.endsWith(text)) {
          throw new Error(`${example.id}: tooltip and accessible help disagree`)
        }
      }
    } else {
      text = (await page.locator('[data-testid="posture-notices"]').innerText()).trim()
    }
    await page.waitForTimeout(150)
    const screenshot = `${example.id}.png`
    await page.screenshot({ path: join(out, screenshot) })
    captured.push({ ...example, text, screenshot })
    console.log(`${example.id}: ${text}`)
  }
  if (errors.length) throw new Error(errors.join('\n'))
  writeFileSync(join(out, 'captured.json'), `${JSON.stringify(captured, null, 2)}\n`)
  console.log(`Captured ${captured.length} controls without browser errors.`)
} finally {
  await browser.close()
}
