// Screenshot the session credential controls harness (epic Task 18). Start it first with
// `bun --bun x vite --config vite.session-credentials-harness.config.ts` from apps/web.
// Usage: bun harness/session-credentials-shots.ts <outDir>
import { readdirSync } from 'node:fs'
import { chromium, type Page } from '@playwright/test'

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

const openChip = async (page: Page) => {
  await page
    .getByRole('button', { name: /^Credential/ })
    .first()
    .click()
  await page.getByRole('menuitem').first().waitFor()
}
const shots: { name: string; query: string; act?: (page: Page) => Promise<void> }[] = [
  { name: '01-composer-default', query: 'scene=composer' },
  { name: '02-composer-picker-open', query: 'scene=composer', act: openChip },
  { name: '03-header-chip', query: 'scene=header' },
  { name: '04-header-switch-menu', query: 'scene=header', act: openChip },
  {
    name: '05-switch-during-turn-asks',
    query: 'scene=busy',
    act: async (page) => {
      await openChip(page)
      await page.getByRole('menuitem', { name: /Personal Pro/ }).click()
      await page.getByText('A turn is running').waitFor()
    },
  },
  {
    name: '06-switch-outcomes',
    query: 'scene=outcomes',
    act: async (page) => {
      await page.getByText(/continues in a new session/).waitFor()
    },
  },
  { name: '07-mismatch-notice', query: 'scene=mismatch' },
  { name: '08-needs-attention-notice', query: 'scene=attention' },
  { name: '09-refused-start-before', query: 'scene=before' },
  { name: '10-refused-start-after', query: 'scene=refused' },
  {
    name: '11-refused-start-pick-another',
    query: 'scene=refused',
    act: async (page) => {
      await page.getByRole('button', { name: 'Pick another credential' }).click()
      await page.getByRole('menuitem').first().waitFor()
    },
  },
  { name: '12-refused-start-full-pane', query: 'scene=refused-pane' },
  { name: '13-refused-start-not-on-machine', query: 'scene=refused-elsewhere' },
  { name: '14-header-switch-menu-light', query: 'scene=header&theme=light', act: openChip },
  { name: '15-login-bar', query: 'scene=login-bar' },
  { name: '16-login-bar-light', query: 'scene=login-bar&theme=light' },
]

for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width: 860, height: 520 } })
  page.on('pageerror', (error) => errors.push(`${shot.name}: ${error.message}`))
  await page.goto(`http://localhost:55655/harness/session-credentials.html?${shot.query}`)
  try {
    await page.locator('#root > *').first().waitFor({ timeout: 10_000 })
    await shot.act?.(page)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${out}/${shot.name}.png` })
  } catch (error) {
    errors.push(`${shot.name}: ${error instanceof Error ? error.message.split('\n')[0] : error}`)
  }
  await page.close()
}
await browser.close()
if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log(`wrote ${shots.length} shots to ${out}`)
