/** Foreground Chromium proof; no Podium server or daemon. Timing requires the
 * caller's bench:flatblock lease. --counts-only emits counts and assertions. */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import type {} from './command-launch.browser'

const countsOnly = process.argv.includes('--counts-only'),
  output = '.artifacts/command-launch',
  origin = 'http://127.0.0.1:45165'
await mkdir(output, { recursive: true })
const server = spawn(
  process.execPath,
  [
    'apps/web/node_modules/vite/bin/vite.js',
    '--config',
    'apps/web/vite.sidebar-pool-perf.config.ts',
    '--port',
    '45165',
    '--strictPort',
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
)
const exited = new Promise<void>((resolve, reject) => {
  server.once('exit', () => resolve())
  server.once('error', reject)
})
console.log(`Command fixture Vite PID ${server.pid}`)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const deadline = Date.now() + 60000
  while (true) {
    try {
      if (
        (
          await fetch(`${origin}/test/command-launch.browser.html`, {
            signal: AbortSignal.timeout(2000),
          })
        ).ok
      )
        break
    } catch {}
    if (Date.now() > deadline || server.exitCode !== null)
      throw new Error('Command fixture did not start')
    await sleep(200)
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const results: Record<string, unknown> = {},
    clock = Date.now()
  for (const mode of ['pool'] as const) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(
      ({ clock }) => {
        const fixed = new Proxy(Date, {
          construct: (target, args) => Reflect.construct(target, args.length ? args : [clock]),
          get: (target, key) => (key === 'now' ? () => clock : Reflect.get(target, key)),
        })
        Object.assign(window, { Date: fixed })
      },
      { clock },
    )
    await page.goto(`${origin}/test/command-launch.browser.html`)
    await page.waitForFunction(() => window.__commandLaunch?.ready(), null, { timeout: 60000 })
    const cdp = await page.context().newCDPSession(page)
    if (!countsOnly) await cdp.send('Performance.enable')
    const metrics = async () =>
      Object.fromEntries(
        (await cdp.send('Performance.getMetrics')).metrics.map((entry) => [
          entry.name,
          entry.value,
        ]),
      )
    await page.evaluate(() => window.__commandLaunch.reset())
    const openBefore = countsOnly ? {} : await metrics()
    await page.getByRole('button', { name: 'Open commands', exact: true }).click()
    await page.getByRole('combobox').waitFor()
    const openAfter = countsOnly ? {} : await metrics()
    results[`${mode}.open`] = !countsOnly
      ? { taskMs: ((openAfter.TaskDuration ?? 0) - (openBefore.TaskDuration ?? 0)) * 1000 }
      : { opened: true }
    await page.evaluate(() => window.__commandLaunch.reset())
    const before = countsOnly ? {} : await metrics()
    await page.evaluate(() => window.__commandLaunch.activity(40))
    const after = countsOnly ? {} : await metrics(),
      stats = await page.evaluate(() => window.__commandLaunch.stats())
    const { commitMs, ...counts } = stats
    results[`${mode}.activity`] = {
      ...counts,
      ...(!countsOnly
        ? {
            taskMs: ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000,
            scriptMs: ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000,
            commitMs,
          }
        : {}),
    }
    if (stats.selectors || stats.legacyDerivations)
      throw new Error(`Command path read legacy: ${JSON.stringify(counts)}`)
    await page.screenshot({ path: `${output}/${mode}-palette.png` })
    // One real keyboard command: search and activate a known task, then inspect
    // the existing owner's resulting route/selection.
    await page.getByRole('combobox').fill('Only responsive target')
    await page.waitForTimeout(180)
    await page.getByRole('combobox').press('Enter')
    await page.waitForFunction(
      () => window.__commandLaunch.selection().issueId === 'synthetic-5599',
    )
    if ((await page.evaluate(() => window.__commandLaunch.selection())).view !== 'issues')
      throw new Error('Palette command did not navigate')
    await page.getByRole('button', { name: 'New panel', exact: true }).click()
    await page.getByRole('menuitem', { name: 'New Shell', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelector('[data-launched]')?.textContent === 'synthetic-launched',
    )
    await page.getByRole('button', { name: 'New task composer', exact: true }).click()
    await page.getByLabel('Title', { exact: true }).fill('Synthetic pool task')
    await page.evaluate(() => window.__commandLaunch.reset())
    await page.evaluate(() => window.__commandLaunch.activity(10))
    const composerStats = await page.evaluate(() => window.__commandLaunch.stats())
    const { commitMs: composerCommitMs, ...composerCounts } = composerStats
    results[`${mode}.composer`] = {
      ...composerCounts,
      ...(!countsOnly ? { commitMs: composerCommitMs } : {}),
    }
    if (composerStats.selectors || composerStats.legacyDerivations)
      throw new Error(`Composer path read legacy: ${JSON.stringify(composerCounts)}`)
    await page.screenshot({ path: `${output}/${mode}-composer.png` })
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.waitForFunction(() =>
      window.__commandLaunch.calls().some((call) => call.kind === 'issue'),
    )
    results[`${mode}.calls`] = await page.evaluate(() => window.__commandLaunch.calls())
    if (mode === 'pool') {
      const check = await page.evaluate(() => window.__commandLaunch.check())
      results.check = check
      if (!check || check.differences || check.pending || !check.positions)
        throw new Error(`Command comparison failed: ${JSON.stringify(check)}`)
    }
    if (errors.length || stats.failures.length)
      throw new Error(`Synthetic browser errors: ${JSON.stringify(errors)}`)
    await page.evaluate(() => window.__commandLaunch.close())
    await page.close()
  }
  await writeFile(
    `${output}/${countsOnly ? 'counts' : 'timings'}.json`,
    JSON.stringify(results, null, 2),
  )
  console.log(JSON.stringify(results))
} finally {
  await browser?.close()
  server.kill()
  await exited
}
