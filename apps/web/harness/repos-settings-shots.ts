// Screenshot the Settings → Projects harness (POD-6267). Start it first with
// `bunx vite --config vite.repos-settings-harness.config.ts` from apps/web.
// Usage: bun harness/repos-settings-shots.ts <outDir>
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

type Act = (page: Page) => Promise<void>
const shots: { name: string; query: string; act?: Act }[] = [
  { name: 'full-dark', query: '' },
  { name: 'full-light', query: 'theme=light' },
  {
    name: 'worktrees-dark',
    query: '',
    act: async (page) => {
      await page.getByTestId('checkout-worktrees').nth(1).click()
    },
  },
  {
    name: 'worktrees-all-light',
    query: 'theme=light',
    act: async (page) => {
      await page.getByTestId('checkout-worktrees').nth(1).click()
      await page.getByRole('button', { name: /^Show all/ }).click()
    },
  },
  {
    name: 'prefix-edit-dark',
    query: '',
    act: async (page) => {
      await page.getByTestId('repo-prefix').nth(2).click()
      await page.keyboard.press('Control+A')
      await page.keyboard.type('pdm')
    },
  },
  {
    name: 'prefix-refused-dark',
    query: '',
    act: async (page) => {
      await page.getByTestId('repo-prefix').nth(2).click()
      await page.keyboard.press('Control+A')
      await page.keyboard.type('web')
      await page.getByTestId('repo-prefix-save').click()
      await page.getByRole('alert').waitFor()
    },
  },
  {
    name: 'prefix-saved-dark',
    query: '',
    act: async (page) => {
      await page.getByTestId('repo-prefix').nth(2).click()
      await page.keyboard.press('Control+A')
      await page.keyboard.type('pdm')
      await page.keyboard.press('Enter')
      await page.getByTestId('repo-prefix-input').waitFor({ state: 'detached' })
    },
  },
  {
    name: 'branch-menu-dark',
    query: '',
    act: async (page) => {
      await page.getByTestId('repo-base-branch').nth(2).click()
    },
  },
  { name: 'single-dark', query: 'scene=single' },
  { name: 'empty-dark', query: 'scene=empty' },
  { name: 'empty-light', query: 'scene=empty&theme=light' },
  { name: 'loading-dark', query: 'scene=loading' },
  { name: 'narrow-dark', query: 'width=430' },
]

for (const shot of shots) {
  const width = Number(new URLSearchParams(shot.query).get('width') ?? 940)
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 })
  page.on('pageerror', (e) => errors.push(`${shot.name}: ${String(e.stack ?? e)}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`${shot.name}: ${m.text()}`))
  await page.goto(`http://localhost:55613/harness/repos-settings.html?${shot.query}`)
  await page.getByTestId('repos-harness').waitFor({ timeout: 60_000 })
  await page.waitForTimeout(400)
  try {
    await shot.act?.(page)
  } catch (e) {
    errors.push(`${shot.name}: act failed: ${String(e)}`)
  }
  await page.waitForTimeout(450)
  await page.screenshot({ path: `${out}/repos-${shot.name}.png`, fullPage: true })
  const facts = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('[data-testid="settings-repo-row"]')].map(
      (row) => row.querySelector('.settings-label')?.textContent,
    ),
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
  }))
  console.log(shot.name, JSON.stringify(facts))
  await page.close()
}
console.log('errors', JSON.stringify(errors.slice(0, 12)))
await browser.close()
