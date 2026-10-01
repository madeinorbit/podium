/** Foreground browser acceptance, run on flatblock under bench:flatblock for
 * timed output. Owns and closes its Vite PID and browser; never a Podium server. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import type {} from './header-pool.browser'

const rows = Number(process.argv.find((arg) => arg.startsWith('--rows='))?.slice(7) ?? 5600)
const idleMs = Number(process.argv.find((arg) => arg.startsWith('--idle-ms='))?.slice(10) ?? 300000)
const activityMs = Number(process.argv.find((arg) => arg.startsWith('--activity-ms='))?.slice(14) ?? 60000)
const compareMs = Number(process.argv.find((arg) => arg.startsWith('--compare-ms='))?.slice(13) ?? 60000)
const output = resolve('.artifacts/header-pool')
await mkdir(output, { recursive: true })
const origin = 'http://127.0.0.1:45079'
const server = spawn(process.execPath, ['apps/web/node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.sidebar-pool-perf.config.ts', '--port', '45079'], { stdio: ['ignore', 'ignore', 'inherit'] })
const exited = new Promise<void>((resolve, reject) => { server.once('exit', () => resolve()); server.once('error', reject) })
console.log(`Header fixture Vite PID ${server.pid}`)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const until = Date.now() + 60000
  while (true) {
    try { if ((await fetch(`${origin}/test/header-pool.browser.html`, { signal: AbortSignal.timeout(2000) })).ok) break } catch {}
    if (Date.now() >= until) throw new Error('Header fixture did not start')
    await sleep(200)
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const results: Record<string, unknown> = {}
  for (const mode of ['legacy', 'pool'] as const) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${origin}/test/header-pool.browser.html?rows=${rows}&mobxHeader=${mode === 'pool' ? 1 : 0}`)
    await page.waitForFunction(() => window.__headerFixture?.ready(), null, { timeout: 60000 })
    await page.waitForTimeout(2000)
    const parity = mode === 'pool' ? await page.evaluate(() => window.__headerFixture.check()) : null
    if (parity && (parity.differences || parity.pending)) throw new Error(`Header parity failed: ${JSON.stringify(parity)}`)
    const session = await page.context().newCDPSession(page)
    await session.send('Performance.enable')
    const metrics = async () => Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map((entry) => [entry.name, entry.value]))
    const phase = async (name: string, durationMs: number, activity: boolean) => {
      await page.evaluate(() => window.__headerFixture.reset())
      const before = await metrics(), started = Date.now()
      let sample = 0, step = 0
      while (Date.now() - started < durationMs) {
        const elapsed = Date.now() - started
        if (elapsed >= sample * 5000) await page.evaluate((value) => window.__headerFixture.metrics(value), ++sample)
        if (activity) await page.evaluate((value) => window.__headerFixture.activity(value), ++step)
        await page.waitForTimeout(activity ? 100 : 250)
      }
      const after = await metrics(), stats = await page.evaluate(() => window.__headerFixture.stats())
      results[`${mode}.${name}`] = { observedMs: Date.now() - started, samples: sample, activityUpdates: step,
        taskMs: ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000,
        scriptMs: ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000, ...stats }
      if (mode === 'pool') {
        const legacy = Object.entries(stats.header).filter(([key]) => key.startsWith('legacy.'))
        if (legacy.length) throw new Error(`Legacy header derivation ran: ${legacy.map(([key]) => key).join(', ')}`)
        const legacySlices = stats.store.runtimes.flatMap((runtime) => Object.entries(runtime.slices)
          .filter(([key, count]) => count > 0 && (key.startsWith('header.') || key.startsWith('hostSessions.'))))
        if (legacySlices.length) throw new Error(`Legacy store derivation ran: ${legacySlices.map(([key]) => key).join(', ')}`)
        if (!activity) {
          const unrelated = Object.entries(stats.header).filter(([key, value]) => value.calls > 0 && key !== 'pool.metricRow')
          if (unrelated.length) throw new Error(`Idle header recomputation: ${unrelated.map(([key]) => key).join(', ')}`)
          if (stats.header['pool.metricRow']?.calls !== sample) throw new Error(`Metric renders did not match changed rows: ${JSON.stringify({ phase: name, samples: sample, header: stats.header, commits: stats.commits })}`)
        }
      }
    }
    // Equal-length before/after idle and activity windows, then the long proof.
    await phase('idle', compareMs, false)
    await phase('activity', activityMs, true)
    if (mode === 'pool') {
      // Put every touched session back into idle before the metric-only proof.
      await page.evaluate(() => window.__headerFixture.idle())
      await page.waitForTimeout(1000)
      await phase('idle-five-minute', idleMs, false)
    }
    await page.screenshot({ path: `${output}/${mode}.png` })
    if (errors.length || (await page.evaluate(() => window.__headerFixture.failures())).length) throw new Error(`Header fixture errors: ${errors.join('; ')}`)
    results[`${mode}.parity`] = parity
    await page.evaluate(() => window.__headerFixture.close())
    await page.close()
  }
  await writeFile(`${output}/results.json`, JSON.stringify({ rows, ...results }, null, 2))
  console.log(JSON.stringify({ rows, ...results }))
} finally { await browser?.close(); server.kill(); await exited }
