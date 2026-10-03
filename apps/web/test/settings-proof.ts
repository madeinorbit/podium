/** Synthetic-only Chromium measurement. One owned Vite PID, no backend or
 * daemon. Timed mode requires bench:flatblock; counts-only is a correctness run. */
import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import type {} from './settings.browser'

const countsOnly = process.argv.includes('--counts-only')
const origin = 'http://127.0.0.1:45166', output = '.artifacts/settings'
await mkdir(output, { recursive: true })
const server = spawn(process.execPath, ['apps/web/node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.sidebar-pool-perf.config.ts', '--port', '45166', '--strictPort'], { stdio: ['ignore', 'ignore', 'inherit'] })
const exited = new Promise<void>((resolve, reject) => { server.once('exit', () => resolve()); server.once('error', reject) })
console.log(`Settings fixture Vite PID ${server.pid}`)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const deadline = Date.now() + 60000
  while (true) {
    try { if ((await fetch(`${origin}/test/settings.browser.html`, { signal: AbortSignal.timeout(2000) })).ok) break } catch {}
    if (Date.now() > deadline) throw new Error('Settings fixture did not start')
    await sleep(200)
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const results: Record<string, unknown> = {}
  for (const mode of ['pool'] as const) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(error.message); console.error(`Settings fixture error: ${error.message}`) })
    await page.goto(`${origin}/test/settings.browser.html`)
    await page.waitForFunction(() => window.__settings?.ready(), null, { timeout: 60000 })
    await page.getByRole('heading', { name: 'Accounts & Keys', exact: true }).waitFor()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const cdp = await page.context().newCDPSession(page)
    if (!countsOnly) await cdp.send('Performance.enable')
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((entry) => [entry.name, entry.value]))
    for (const phase of ['activity', 'preferences'] as const) {
      await page.evaluate(() => window.__settings.reset())
      const initial = countsOnly ? {} : await metrics()
      if (phase === 'activity') await page.evaluate(() => window.__settings.activity(200))
      else await page.evaluate(() => window.__settings.preferences())
      const final = countsOnly ? {} : await metrics(), stats = await page.evaluate(() => window.__settings.stats())
      results[`${mode}.${phase}`] = { ...stats,
        ...(!countsOnly ? { taskMs: ((final.TaskDuration ?? 0) - (initial.TaskDuration ?? 0)) * 1000,
          scriptMs: ((final.ScriptDuration ?? 0) - (initial.ScriptDuration ?? 0)) * 1000, heapBytes: final.JSHeapUsedSize } : {}) }
      if ((stats.selectors || stats.legacyDerivations)) throw new Error(`Legacy settings reader executed: ${JSON.stringify(stats)}`)
      if (stats.failures.length) throw new Error('Provider failed')
    }
    // The indirect Machines panel must be part of the zero-reader proof.
    await page.evaluate(() => window.__settings.reset())
    await page.getByRole('button', { name: 'Machines', exact: true }).click()
    await page.getByRole('heading', { name: 'Machines', exact: true }).waitFor()
    await page.locator('.settings-label').filter({ hasText: /^Host 1$/ }).waitFor()
    await page.evaluate(() => window.__settings.activity(5))
    const machineStats = await page.evaluate(() => window.__settings.stats())
    results[`${mode}.machines`] = machineStats
    if ((machineStats.selectors || machineStats.legacyDerivations)) throw new Error('Legacy Machines panel selector executed')
    await page.getByRole('button', { name: 'Notifications', exact: true }).click()
    const sound = page.locator('.settings-row').filter({ has: page.getByText('Notification sounds', { exact: true }) }).getByRole('switch')
    const previous = await sound.getAttribute('aria-checked')
    const clickStart = Date.now()
    await sound.click()
    await page.waitForFunction((value) => window.__settings.sound() === value, previous === 'true' ? 'false' : 'true')
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    if (await sound.getAttribute('aria-checked') === previous) throw new Error('Sound control did not repaint')
    if (!countsOnly) results[`${mode}.clickToPaintMs`] = Date.now() - clickStart
    const check = await page.evaluate(() => window.__settings.check())
    if ((!check || check.differences || check.pending)) throw new Error(`Settings differential failed: ${JSON.stringify(check)}`)
    results[`${mode}.check`] = check
    await page.screenshot({ path: `${output}/${mode}.png` })
    const rebuildStart = Date.now()
    await page.evaluate(() => window.__settings.switchPrincipal())
    await page.waitForFunction(() => window.__settings.ready() && window.__settings.stats().generation === 1)
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    if (!countsOnly) results[`${mode}.principalRebuildMs`] = Date.now() - rebuildStart
    const rebuilt = await page.evaluate(() => window.__settings.check())
    if ((!rebuilt || rebuilt.differences || rebuilt.pending)) throw new Error('Principal rebuild comparison failed')
    results[`${mode}.rebuiltCheck`] = rebuilt
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`)
    await page.evaluate(() => window.__settings.close())
    await page.close()
  }
  await writeFile(`${output}/${countsOnly ? 'counts' : 'results'}.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results))
} finally { await browser?.close(); server.kill(); await exited }
