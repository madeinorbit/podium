// Screenshot the Settings → Accounts & Keys harness (POD-6390). Start it first with
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
const shots: { name: string; query: string; act?: Act }[] = [
  { name: 'admin-dark', query: '' },
  {
    name: 'admin-edit-people-dark',
    query: '',
    act: async (page) => {
      await page.getByRole('button', { name: 'Change who can use Anthropic API key' }).click()
    },
  },
  {
    name: 'admin-members-key-light',
    query: 'theme=light',
    act: async (page) => {
      await page
        .getByRole('button', { name: "Change who can use Ana Sousa's OpenAI API key" })
        .click()
      await page.getByLabel('Everyone on this server').check()
    },
  },
  {
    name: 'member-edit-dark',
    query: 'scene=member',
    act: async (page) => {
      await page.getByRole('button', { name: 'Change who can use OpenAI API key' }).click()
    },
  },
]

for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width: 980, height: 1400 } })
  page.on('pageerror', (e) => errors.push(`${shot.name}: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${shot.name}: ${m.text()}`)
  })
  await page.goto(`http://localhost:55614/harness/accounts-settings.html?${shot.query}`)
  await page.getByText('Shared with', { exact: true }).first().waitFor()
  await page.waitForTimeout(250)
  if (shot.act) await shot.act(page)
  await page.waitForTimeout(200)
  await page.getByTestId('accounts-harness').screenshot({ path: `${out}/${shot.name}.png` })
  await page.close()
}
await browser.close()
if (errors.length) console.log(errors.join('\n'))
console.log(`shots: ${shots.length} written to ${out}`)
