// Screenshot the add-repository picker harness (POD-6869). Start it first with
// `bunx vite --config vite.repo-picker-harness.config.ts` from apps/web.
// Usage: bun harness/repo-picker-shots.ts <outDir>
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
const shots = [
  { name: 'local-dark', query: '' },
  { name: 'local-light', query: 'theme=light' },
  { name: 'github-dark', query: 'source=github' },
  { name: 'github-light', query: 'source=github&theme=light' },
]
for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width: 760, height: 720 } })
  page.on('pageerror', (error) => errors.push(`${shot.name}: ${error.message}`))
  await page.goto(`http://localhost:55661/harness/repo-picker.html?${shot.query}`)
  await page.getByText('Podium tells each agent the folder is trusted', { exact: false }).waitFor()
  await page.screenshot({ path: `${out}/repo-picker-${shot.name}.png` })
  await page.close()
}
await browser.close()
if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exit(1)
}
