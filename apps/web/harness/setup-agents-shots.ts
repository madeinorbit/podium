/** Run through the capture wrapper: bun run capture:setup-agents -- <output-directory>. */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const out = process.argv[2] ?? '/tmp/setup-agents-shots'
mkdirSync(out, { recursive: true })
const server = spawn(
  process.execPath,
  ['--bun', 'x', 'vite', '--config', 'vite.setup-agents-harness.config.ts'],
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
const origin = 'http://127.0.0.1:55662/harness/setup-agents.html'
try {
  let ready = false
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      if ((await fetch(origin)).ok) {
        ready = true
        break
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!ready) throw new Error(`Harness did not start: ${logs}`)
  const browserEnv = { ...process.env }
  const userLib = join(
    process.env.HOME ?? '',
    '.cache/podium-chromium-deps/root/usr/lib/x86_64-linux-gnu',
  )
  if (existsSync(userLib)) browserEnv.LD_LIBRARY_PATH = userLib
  else delete browserEnv.LD_LIBRARY_PATH
  const browser = await chromium.launch({
    env: browserEnv,
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox'],
  })
  const shots: [state: string, theme: string, width: number][] = [
    ['list', 'light', 1100],
    ['list', 'dark', 1100],
    ['list', 'light', 390],
    ['installing', 'light', 1100],
    ['failed', 'light', 1100],
    ['detail', 'light', 1100],
    ['detail', 'dark', 390],
    ['signin', 'light', 1100],
    ['signin', 'dark', 390],
    ['embedded', 'light', 1280],
    ['embedded', 'dark', 390],
  ]
  try {
    for (const [state, theme, width] of shots) {
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`${origin}?state=${state}&theme=${theme}`)
      try {
        await page.locator('[data-setup-agents]').waitFor()
        if (state === 'signin') await page.getByText('How should Codex sign in?').waitFor()
      } catch (error) {
        throw new Error(`${state}: ${String(error)}\n${errors.join('\n')}\n${logs}`)
      }
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(150)
      await page.screenshot({
        path: join(out, `${state}-${theme}-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      })
      if (errors.length) throw new Error(errors.join('\n'))
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      )
      if (overflow) throw new Error(`${state} at ${width}px scrolls sideways`)
      await page.close()
    }
  } finally {
    await browser.close()
  }
  console.log(`Captured Set up agents states in ${out}`)
} finally {
  server.kill('SIGTERM')
}
