// Screenshot the Settings → Accounts harness (POD-6300). Start it first with
// `bunx vite --config vite.accounts-settings-harness.config.ts` from apps/web.
// Usage: bun harness/accounts-settings-shots.ts <outDir>
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
const openSend: Act = async (page) => {
  await page.getByRole('button', { name: 'Send to a shared machine' }).click()
  await page.getByRole('alertdialog').waitFor()
}
const shots: { name: string; query: string; act?: Act }[] = [
  { name: 'unsent-dark', query: '' },
  { name: 'warning-dark', query: '', act: openSend },
  { name: 'warning-light', query: 'theme=light', act: openSend },
  {
    name: 'sent-dark',
    query: '',
    act: async (page) => {
      await openSend(page)
      await page.getByRole('button', { name: 'Send to alice-desk' }).click()
      await page.getByText(/Also runs on alice-desk/).waitFor()
    },
  },
  { name: 'warning-narrow-dark', query: 'width=430', act: openSend },
]

for (const shot of shots) {
  const width = Number(new URLSearchParams(shot.query).get('width') ?? 940)
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 })
  page.on('pageerror', (e) => errors.push(`${shot.name}: ${String(e.stack ?? e)}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`${shot.name}: ${m.text()}`))
  await page.goto(`http://localhost:55614/harness/accounts-settings.html?${shot.query}`)
  await page.getByTestId('accounts-harness').waitFor({ timeout: 60_000 })
  await page.waitForTimeout(400)
  try {
    await shot.act?.(page)
  } catch (e) {
    errors.push(`${shot.name}: act failed: ${String(e)}`)
  }
  await page.waitForTimeout(450)
  await page.screenshot({ path: `${out}/accounts-${shot.name}.png`, fullPage: true })
  const facts = await page.evaluate(() => ({
    warning: document.querySelector('[role="alertdialog"]')?.textContent ?? null,
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
  }))
  console.log(shot.name, JSON.stringify(facts))
  await page.close()
}
console.log('errors', JSON.stringify(errors.slice(0, 12)))
await browser.close()
