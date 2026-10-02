/** Synthetic-only real Chromium proof. Timed runs require bench:flatblock; --counts-only does not.
 * Owns one Vite PID and its browser; never starts a Podium server or daemon. */
import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import type {} from './client-access.browser'
const countsOnly = process.argv.includes('--counts-only')
const origin = 'http://127.0.0.1:45161', output = '.artifacts/client-access'
await mkdir(output, { recursive: true })
const server = spawn(process.execPath, ['apps/web/node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.sidebar-pool-perf.config.ts', '--port', '45161', '--strictPort'], { stdio: ['ignore', 'ignore', 'inherit'] })
const exited = new Promise<void>((resolve, reject) => { server.once('exit', () => resolve()); server.once('error', reject) })
console.log(`Preference fixture Vite PID ${server.pid}`)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const deadline = Date.now() + 60000
  while (true) {
    try { if ((await fetch(`${origin}/test/client-access.browser.html`, { signal: AbortSignal.timeout(2000) })).ok) break } catch {}
    if (Date.now() > deadline) throw new Error('Preference fixture did not start')
    await sleep(200)
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const results: Record<string, unknown> = {}
  for (const mode of ['before', 'after'] as const) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${origin}/test/client-access.browser.html?before=${mode === 'before' ? 1 : 0}&mobxPreferences=${mode === 'after' ? 1 : 0}`)
    await page.waitForFunction(() => window.__clientAccess?.ready(), null, { timeout: 60000 })
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const cdp = await page.context().newCDPSession(page)
    if (!countsOnly) await cdp.send('Performance.enable')
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((entry) => [entry.name, entry.value]))
    for (const phase of ['activity', 'preferences'] as const) {
      await page.evaluate(() => window.__clientAccess.reset())
      const initial = countsOnly ? {} : await metrics()
      if (phase === 'activity') await page.evaluate(() => window.__clientAccess.activity(200))
      else await page.evaluate(() => window.__clientAccess.preferences())
      const final = countsOnly ? {} : await metrics(), stats = await page.evaluate(() => window.__clientAccess.stats())
      const counts = { selectors: stats.selectors, wakes: stats.wakes, legacyDerivations: stats.legacyDerivations }
      results[`${mode}.${phase}`] = {
        ...counts, legacyReads: stats.legacyReads, pool: stats.pool, commits: stats.commits,
        ...(!countsOnly ? { taskMs: ((final.TaskDuration ?? 0) - (initial.TaskDuration ?? 0)) * 1000,
          scriptMs: ((final.ScriptDuration ?? 0) - (initial.ScriptDuration ?? 0)) * 1000, commitMs: stats.commitMs } : {}),
      }
      if (mode === 'after' && (counts.selectors !== 0 || stats.legacyReads !== 0 || stats.legacyDerivations !== 0)) throw new Error('Legacy preference/transport reader executed')
      if (mode === 'before' && phase === 'activity' && counts.selectors === 0) throw new Error('Legacy positive control did not execute')
      if (stats.failures.length) throw new Error('Provider failure in synthetic proof')
    }
    // Drive the real button once and observe the rendered preference change.
    await page.getByRole('button', { name: 'Toggle sticky prompts' }).click()
    await page.waitForFunction(() => document.querySelector('dd')?.textContent === 'Off')
    const check = await page.evaluate(() => window.__clientAccess.check())
    if (mode === 'after' && (!check || check.differences || check.pending || check.positions < 4)) throw new Error(`Preference comparison failed: ${JSON.stringify(check)}`)
    results[`${mode}.check`] = check
    await page.screenshot({ path: `${output}/${mode}.png` })
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`)
    await page.evaluate(() => window.__clientAccess.close())
    await page.close()
  }
  await writeFile(`${output}/${countsOnly ? 'counts' : 'results'}.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results))
} finally { await browser?.close(); server.kill(); await exited }
