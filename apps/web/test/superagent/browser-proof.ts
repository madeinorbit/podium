/** Bounded interleaved, same-SHA Chromium comparison. Only synthetic metadata
 * enters the browser. Timed captures require the caller's bench:flatblock lease. */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import type {} from './acceptance.browser'

const countsOnly = process.argv.includes('--counts-only'), origin = 'http://127.0.0.1:45164', output = '.artifacts/superagent'
await mkdir(output, { recursive: true })
const server = spawn(process.execPath, ['apps/web/node_modules/vite/bin/vite.js', '--config', 'apps/web/test/superagent/acceptance.vite.mjs', '--port', '45164', '--strictPort'], { stdio: ['ignore', 'ignore', 'inherit'] })
const exited = new Promise<void>((resolve, reject) => { server.once('exit', () => resolve()); server.once('error', reject) })
console.log(`Superagent fixture Vite PID ${server.pid}`)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const deadline = Date.now() + 60000
  const path = '/test/superagent/acceptance.browser.html'
  while (true) {
    try { if ((await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(2000) })).ok) break } catch {}
    if (Date.now() > deadline || server.exitCode !== null) throw new Error('Superagent fixture did not start')
    await sleep(200)
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const results = [], renders: Record<string, unknown> = {}
  for (const [index, mode] of ['legacy', 'pool', 'pool', 'legacy'].entries()) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } }), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}${path}?mobxSuperagent=${mode === 'pool' ? 1 : 0}`)
    await page.waitForFunction(() => window.__superagentProof?.ready(), null, { timeout: 60000 })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    if (!await page.evaluate(() => window.__superagentProof.firstPool())) throw new Error('Initial attach did not pass through no pool')
    renders[mode] = await page.evaluate(() => window.__superagentProof.snapshot())
    const cdp = await page.context().newCDPSession(page)
    if (!countsOnly) await cdp.send('Performance.enable')
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(row => [row.name, row.value]))
    for (const phase of ['activity', 'threads'] as const) {
      await page.evaluate(() => window.__superagentProof.reset())
      const before = countsOnly ? {} : await metrics()
      await page.evaluate(async phase => phase === 'activity' ? window.__superagentProof.activity(20) : window.__superagentProof.threads(10), phase)
      const after = countsOnly ? {} : await metrics(), stats = await page.evaluate(() => window.__superagentProof.stats())
      if (mode === 'pool' && (stats.selectors || Object.values(stats.ownLegacy).some(value => value > 0))) throw new Error('Enabled Superagent executed legacy work')
      if (mode === 'legacy' && stats.selectors === 0) throw new Error('Legacy positive control did not execute')
      if (stats.failures || errors.length) throw new Error('Superagent provider or browser failed')
      results.push({ index, mode, phase, selectors: stats.selectors, ownLegacy: stats.ownLegacy, commits: stats.commits,
        ...(!countsOnly ? { taskMs: ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000 } : {}) })
    }
    if (mode === 'pool') {
      await page.waitForFunction(() => { const result = window.__superagentProof.check(); return !!result && result.pending === 0 }, null, { timeout: 30000 })
      const comparison = await page.evaluate(() => window.__superagentProof.check())
      if (!comparison || comparison.differences || comparison.pending) throw new Error(`Superagent parity failed: ${JSON.stringify(comparison)}`)
      results.push({ index, mode, comparison })
    }
    await page.getByTitle('Clear context — start the global chat fresh').click()
    await page.getByTitle('Open this conversation in a terminal session').click()
    await page.waitForFunction(() => window.__superagentProof.stats().focused === 'synthetic-session-3')
    const actions = await page.evaluate(() => window.__superagentProof.stats())
    if (actions.actions.cleared !== 1 || actions.actions.opened !== 1 || actions.failures || errors.length) throw new Error('Shared mutation/navigation owner failed')
    if (mode === 'pool' && Object.values(actions.ownLegacy).some(value => value > 0)) throw new Error('Legacy Superagent work executed during actions')
    if (index < 2) await page.screenshot({ path: `${output}/${mode}.png`, fullPage: true })
    await page.evaluate(() => window.__superagentProof.close()); await page.close()
  }
  if (JSON.stringify(renders.legacy) !== JSON.stringify(renders.pool)) throw new Error('Superagent browser renders differ')
  const report = { chromium: browser.version(), corpus: { issues: 5600, sessions: 5014 }, countsOnly,
    childBoundary: 'ChatView is held fixed; its remaining data readers belong to POD-5173', results }
  await writeFile(`${output}/${countsOnly ? 'counts' : 'browser'}.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await browser?.close(); server.kill(); await exited }
