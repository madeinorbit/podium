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
const tickD11: Act = async (page) => {
  await page
    .getByRole('checkbox', { name: /Automatically transfer and use these credentials/ })
    .click()
  await page.getByText(/Not copied to bob-desk/).waitFor()
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
  // POD-6301: the D11 box, unticked, then ticked with a kept login reported.
  { name: 'd11-unticked-light', query: 'theme=light' },
  { name: 'd11-ticked-dark', query: '', act: tickD11 },
  { name: 'd11-ticked-light', query: 'theme=light', act: tickD11 },
  { name: 'd11-ticked-narrow-dark', query: 'width=430', act: tickD11 },
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
    d11: document.querySelector('[role="checkbox"]')?.getAttribute('aria-checked') ?? null,
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
  }))
  console.log(shot.name, JSON.stringify(facts))
  await page.close()
}
console.log('errors', JSON.stringify(errors.slice(0, 12)))
await browser.close()
