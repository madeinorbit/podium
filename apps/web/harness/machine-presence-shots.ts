/** Stubbed shipping Machines screen: bun run capture:machine-presence -- <output-directory>. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'

const out = process.argv[2] ?? '/tmp/machine-presence-shots'
mkdirSync(out, { recursive: true })
const server = spawn(
  process.execPath,
  ['--bun', 'x', 'vite', '--config', 'vite.settings-frame-harness.config.ts'],
  {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
let logs = ''
server.stdout.on('data', (data) => {
  logs += data.toString()
})
server.stderr.on('data', (data) => {
  logs += data.toString()
})
const origin = 'http://127.0.0.1:55652/harness/settings-frame.html'
const cache = join(process.env.HOME ?? '', '.cache/ms-playwright')
const shell = existsSync(cache)
  ? readdirSync(cache)
      .filter((name) => name.startsWith('chromium_headless_shell-'))
      .sort()
      .at(-1)
  : undefined
try {
  let ready = false
  for (let attempt = 0; attempt < 300; attempt++) {
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
  const browser = await chromium.launch({
    env: browserEnv,
    ...(shell
      ? {
          executablePath: join(cache, shell, 'chrome-headless-shell-linux64/chrome-headless-shell'),
        }
      : {}),
    args: ['--no-sandbox'],
  })
  try {
    for (const state of ['online', 'reconnecting', 'offline']) {
      const page = await browser.newPage({ viewport: { width: 1200, height: 820 } })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`${origin}?populated&page=machines&presence=${state}&theme=light`)
      try {
        await expect(page.getByRole('heading', { name: 'Machines', exact: true })).toBeVisible({
          timeout: 90_000,
        })
        const label =
          state === 'online' ? 'Online' : state === 'offline' ? 'Offline' : 'Reconnecting'
        await expect(page.getByTitle(label, { exact: true })).toHaveCount(3)
        if (state !== 'online') await expect(page.getByText(/Last seen/)).toHaveCount(3)
        await page.evaluate(() => document.fonts.ready)
        await page.screenshot({
          path: join(out, `${state}.png`),
          fullPage: true,
          animations: 'disabled',
        })
        if (errors.length) throw new Error(errors.join('\n'))
      } catch (error) {
        throw new Error(`${state}: ${String(error)}\n${errors.join('\n')}\n${logs}`)
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser.close()
  }
  console.log(`Captured Online, Reconnecting and Offline in ${out}`)
} finally {
  server.kill('SIGTERM')
}
