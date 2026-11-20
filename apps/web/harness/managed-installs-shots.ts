/** Run through the capture wrapper: bun run capture:managed-installs -- <output-directory>. */

import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const out = process.argv[2] ?? '/tmp/managed-installs-shots'
mkdirSync(out, { recursive: true })
const server = spawn(
  process.execPath,
  ['--bun', 'x', 'vite', '--config', 'vite.managed-installs-harness.config.ts'],
  { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] },
)
let logs = ''
server.stdout.on('data', (data) => {
  logs += data.toString()
})
server.stderr.on('data', (data) => {
  logs += data.toString()
})
const cache = join(process.env.HOME ?? '', '.cache/ms-playwright')
const shell = readdirSync(cache)
  .filter((name) => name.startsWith('chromium_headless_shell-'))
  .sort()
  .at(-1)
const executablePath = shell
  ? join(cache, shell, 'chrome-headless-shell-linux64/chrome-headless-shell')
  : undefined
try {
  let ready = false
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      if ((await fetch('http://127.0.0.1:55658/harness/managed-installs.html')).ok) {
        ready = true
        break
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!ready) throw new Error(`Harness did not start: ${logs}`)
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox'],
  })
  try {
    for (const state of [
      'not-installed',
      'own',
      'own-too-old',
      'managed',
      'both',
      'shared',
      'installing',
    ]) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 540 } })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`http://127.0.0.1:55658/harness/managed-installs.html?state=${state}`)
      await page.locator(`[data-harness-state="${state}"]`).waitFor()
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({ path: join(out, `${state}.png`), fullPage: true })
      if (errors.length) throw new Error(errors.join('\n'))
      if (['both', 'shared'].includes(state)) {
        await page.setViewportSize({ width: 390, height: 820 })
        await page.screenshot({ path: join(out, `${state}-phone.png`), fullPage: true })
      }
      await page.close()
    }
  } finally {
    await browser.close()
  }
  console.log(`Captured all seven managed harness states in ${out}`)
} finally {
  server.kill('SIGTERM')
}
