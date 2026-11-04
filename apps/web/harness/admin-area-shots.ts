// Screenshot the Settings → Administration harness (POD-6299). Start it first with
// `bunx vite --config vite.admin-area-harness.config.ts` from apps/web.
// Usage: bun harness/admin-area-shots.ts <outDir>
import { mkdirSync, readdirSync } from 'node:fs'
import { chromium, type Page } from '@playwright/test'

const out = process.argv[2] ?? '.'
mkdirSync(out, { recursive: true })
const cache = `${process.env.HOME}/.cache/ms-playwright`
const shell = readdirSync(cache)
  .filter((n) => n.startsWith('chromium_headless_shell-'))
  .sort()
  .at(-1)
const browser = await chromium.launch({
  executablePath: `${cache}/${shell}/chrome-headless-shell-linux64/chrome-headless-shell`,
})
const errors: string[] = []
type Act = (page: Page) => Promise<void>
const shots: { name: string; query: string; act?: Act }[] = [
  { name: 'alice-people', query: 'tab=members' },
  {
    name: 'alice-people-refusal',
    query: 'tab=members',
    act: async (p) => {
      await p.getByRole('button', { name: 'Make admin' }).click()
      await p.getByLabel('Your password').fill('pw')
      await p.getByRole('button', { name: 'Confirm role change' }).click()
      await p.getByRole('alert').waitFor()
    },
  },
  { name: 'alice-access', query: 'tab=access' },
  { name: 'alice-audit', query: 'tab=audit' },
  {
    name: 'alice-machines-share',
    query: 'tab=machines',
    act: async (p) => {
      await p.getByRole('button', { name: 'Give use…' }).click()
      await p.getByLabel('Member').selectOption('bob')
      await p.getByLabel('I understand that we will share this machine’s account').check()
    },
  },
  { name: 'alice-audit-light', query: 'tab=audit&theme=light' },
  { name: 'bob-rail', query: 'as=bob&tab=audit' },
]
for (const shot of shots) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 2,
  })
  page.on('pageerror', (e) => errors.push(`${shot.name}: ${String(e.stack ?? e)}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`${shot.name}: ${m.text()}`))
  await page.goto(`http://localhost:55615/harness/admin-area.html?${shot.query}`)
  await page.getByTestId('admin-harness').waitFor({ timeout: 90_000 })
  await page.waitForTimeout(700)
  try {
    await shot.act?.(page)
  } catch (e) {
    errors.push(`${shot.name}: act failed: ${String(e)}`)
  }
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}/admin-${shot.name}.png`, fullPage: true })
  const facts = await page.evaluate(() => ({
    rail: [...document.querySelectorAll('.settings-rail-group')].map((g) => g.textContent),
    tabs: [...document.querySelectorAll('.settings-rail-item')].map((g) => g.textContent),
    alert: document.querySelector('[role="alert"]')?.textContent ?? null,
    calls: (window as unknown as { adminCalls: string[] }).adminCalls,
  }))
  console.log(shot.name, JSON.stringify(facts))
  await page.close()
}
if (errors.length) console.log('ERRORS', errors.join('\n'))
await browser.close()
