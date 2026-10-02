/** Real Chromium over synthetic operator-sized rows. Counts-only runs need no
 * timing lease. Timed runs require bench:flatblock. Owns only this Vite/browser. */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import type {} from './notices.browser'

const countsOnly = process.argv.includes('--counts-only'), output = '.artifacts/notices', origin = 'http://127.0.0.1:45163'
await mkdir(output, { recursive: true })
const server = spawn(process.execPath, ['apps/web/node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.sidebar-pool-perf.config.ts', '--port', '45163', '--strictPort'], { stdio: ['ignore', 'ignore', 'inherit'] })
const exited = new Promise<void>((resolve, reject) => { server.once('exit', () => resolve()); server.once('error', reject) })
console.log(`Notice fixture Vite PID ${server.pid}`)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const deadline = Date.now() + 60000
  while (true) {
    try { if ((await fetch(`${origin}/test/notices.browser.html`, { signal: AbortSignal.timeout(2000) })).ok) break } catch {}
    if (Date.now() > deadline || server.exitCode !== null) throw new Error('Notice fixture did not start')
    await sleep(200)
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const results: Record<string, unknown> = {}
  for (const mode of ['before', 'after'] as const) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/test/notices.browser.html?mobxNotices=${mode === 'after' ? 1 : 0}`)
    await page.waitForFunction(() => window.__notices?.ready(), null, { timeout: 60000 })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const cdp = await page.context().newCDPSession(page)
    if (!countsOnly) await cdp.send('Performance.enable')
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(entry => [entry.name, entry.value]))
    for (const phase of ['activity', 'updates'] as const) {
      await page.evaluate(() => window.__notices.reset())
      const initial = countsOnly ? {} : await metrics()
      if (phase === 'activity') await page.evaluate(() => window.__notices.activity(200))
      else await page.evaluate(() => window.__notices.updates(30))
      const final = countsOnly ? {} : await metrics(), stats = await page.evaluate(() => window.__notices.stats())
      const legacy = Object.values(stats.legacy).reduce((sum, count) => sum + (count ?? 0), 0)
      results[`${mode}.${phase}`] = { selectors: stats.selectors, legacySlices: stats.legacySlices, legacy: stats.legacy, commits: stats.commits,
        ...(!countsOnly ? { taskMs: ((final.TaskDuration ?? 0) - (initial.TaskDuration ?? 0)) * 1000, commitMs: stats.commitMs } : {}) }
      if (mode === 'after' && (stats.selectors || stats.legacySlices || legacy)) throw new Error('Legacy notice selector or derivation executed')
      if (mode === 'before' && stats.selectors === 0) throw new Error('Legacy positive control did not execute')
      if (stats.failures) throw new Error('Synthetic provider failed')
    }
    const before = await page.evaluate(() => window.__notices.check())
    if (mode === 'after' && (!before || before.differences || before.pending || before.positions !== 20)) throw new Error(`Notice comparison failed: ${JSON.stringify(before)}`)
    results[`${mode}.check`] = before
    // Measure actions independently of the opt-in legacy-reference comparison.
    await page.evaluate(() => window.__notices.reset())
    await page.getByTestId('message-notice-chip').click()
    await page.getByRole('button', { name: 'Dismiss', exact: true }).first().click()
    await page.waitForFunction(() => window.__notices.stats().actions.dismissed === 1)
    await page.getByRole('button', { name: 'Open chat', exact: true }).first().click()
    await page.waitForFunction(() => window.__notices.stats().opened === 'cold-notice-session')
    await page.getByRole('button', { name: 'I signed in — retry', exact: true }).click()
    await page.waitForFunction(() => window.__notices.stats().actions.answered === 1)
    await page.getByTestId('outbox-recovery-chip').click()
    await page.getByRole('button', { name: 'Discard', exact: true }).first().click()
    await page.waitForFunction(() => window.__notices.stats().parked === 4)
    await page.screenshot({ path: `${output}/${mode}.png` })
    await page.keyboard.press('Escape')
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const actionStats = await page.evaluate(() => window.__notices.stats())
    const actionLegacy = Object.values(actionStats.legacy).reduce((sum, count) => sum + (count ?? 0), 0)
    if (mode === 'after' && (actionStats.selectors || actionStats.legacySlices || actionLegacy)) throw new Error(`Legacy notice work executed while acting: ${JSON.stringify({ selectors: actionStats.selectors, legacySliceNames: actionStats.legacySliceNames, legacy: actionStats.legacy })}`)
    const after = await page.evaluate(() => window.__notices.check())
    if (mode === 'after' && (!after || after.differences || after.pending || after.positions !== 17)) throw new Error(`Post-action comparison failed: ${JSON.stringify(after)}`)
    results[`${mode}.actions`] = { ...actionStats.actions, parked: actionStats.parked, selectors: actionStats.selectors, legacy: actionStats.legacy, legacySliceNames: actionStats.legacySliceNames, check: after }
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`)
    await page.evaluate(() => window.__notices.close()); await page.close()
  }
  await writeFile(`${output}/${countsOnly ? 'counts' : 'results'}.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results))
} finally { await browser?.close(); server.kill(); await exited }
