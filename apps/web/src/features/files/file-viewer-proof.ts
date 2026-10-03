/** Foreground synthetic Chromium measurement. Timed runs require bench:flatblock.
 * Pool-only readers retain their fixed mode and action regression tests.
 * Owns one Vite PID and browser; never starts a Podium server or daemon. */

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import type {} from './file-viewer.browser'

const arm = 'pool',
  countsOnly = process.argv.includes('--counts-only')
const origin = 'http://127.0.0.1:45170',
  output = '.artifacts/file-viewers'
await mkdir(output, { recursive: true })
const server = spawn(
  process.execPath,
  [
    'apps/web/node_modules/vite/bin/vite.js',
    '--config',
    'apps/web/vite.sidebar-pool-perf.config.ts',
    '--port',
    '45170',
    '--strictPort',
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
)
const exited = new Promise<void>((resolve, reject) => {
  server.once('exit', () => resolve())
  server.once('error', reject)
})
console.log(`File-viewer fixture Vite PID ${server.pid}`)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const path = '/src/features/files/file-viewer.browser.html',
    deadline = Date.now() + 60000
  while (true) {
    try {
      if ((await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(2000) })).ok) break
    } catch {}
    if (Date.now() > deadline) throw new Error('Viewer fixture did not start')
    await sleep(200)
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1024 },
      reducedMotion: 'reduce',
    }),
    errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return url.origin === origin || ['data:', 'blob:', 'about:'].includes(url.protocol)
      ? route.continue()
      : route.abort()
  })
  await page.goto(`${origin}${path}`)
  await page.waitForFunction(
    () =>
      window.__fileViewers?.ready() &&
      document.querySelectorAll('.cm-editor').length >= 2 &&
      document.querySelector('iframe'),
    null,
    { timeout: 60000 },
  )
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  const boot = await page.evaluate(() => window.__fileViewers.stats())
  if (boot.selectors || boot.legacyDerivations)
    throw new Error('Legacy file/Git reader executed during mount')
  const evidence = (stats: typeof boot) => {
    const { commitMs: _duration, ...counts } = stats
    return countsOnly ? counts : stats
  }
  const result: Record<string, unknown> = { browser: browser.version(), boot: evidence(boot) }
  const cdp = await page.context().newCDPSession(page)
  if (!countsOnly) await cdp.send('Performance.enable')
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map((entry) => [entry.name, entry.value]),
    )
  for (const phase of ['activity', 'preferences', 'utilities'] as const) {
    await page.evaluate(() => window.__fileViewers.reset())
    const initial = countsOnly ? {} : await metrics()
    await page.evaluate((phase) => window.__fileViewers[phase](), phase)
    const final = countsOnly ? {} : await metrics(),
      stats = await page.evaluate(() => window.__fileViewers.stats())
    result[phase] = {
      ...evidence(stats),
      ...(!countsOnly
        ? {
            taskMs: ((final.TaskDuration ?? 0) - (initial.TaskDuration ?? 0)) * 1000,
            scriptMs: ((final.ScriptDuration ?? 0) - (initial.ScriptDuration ?? 0)) * 1000,
          }
        : {}),
    }
    if (stats.selectors || stats.legacyDerivations)
      throw new Error('Legacy file/Git reader executed')
    if (stats.failures.length || stats.calls.write)
      throw new Error('Viewer owner failure or unsolicited file write')
  }
  await page.waitForFunction(() => document.querySelector('[data-testid="diff-sheet"]'))
  const check = await page.evaluate(() => window.__fileViewers.check())
  if (!check || check.differences || check.pending || check.positions !== 7)
    throw new Error(`File-mode comparison failed: ${JSON.stringify(check)}`)
  result.check = check
  await page.evaluate(() => window.__fileViewers.closeUtilities())
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  const snapshot = await page.evaluate(() => window.__fileViewers.snapshot())
  result.snapshot = snapshot
  await page.screenshot({ path: `${output}/${arm}.png` })
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`)
  await writeFile(
    `${output}/${arm}${countsOnly ? '-counts' : ''}.json`,
    JSON.stringify(result, null, 2),
  )
  // Raw output contains synthetic fixture content only.
  console.log(JSON.stringify(result))
  await page.evaluate(() => window.__fileViewers.close())
} finally {
  await browser?.close()
  server.kill()
  await exited
}
