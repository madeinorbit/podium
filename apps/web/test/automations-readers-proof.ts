/** Real Chromium over pool-only production readers. Timings require bench:flatblock; counts-only has no timing output. */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import type { SidebarSnapshot } from '../../../tests/worklist/diagnostics/sidebar-check'
import type {} from './automations-readers.browser'

async function main() {
  const countsOnly = process.argv.includes('--counts-only')
  const output = '.artifacts/automations',
    origin = 'http://127.0.0.1:45167',
    clock = Date.now()
  await mkdir(output, { recursive: true })
  const server = spawn(
    process.execPath,
    [
      'apps/web/node_modules/vite/bin/vite.js',
      '--config',
      'apps/web/vite.sidebar-pool-perf.config.ts',
      '--port',
      '45167',
      '--strictPort',
    ],
    { stdio: 'ignore' },
  )
  console.log(`Synthetic automation Vite PID ${server.pid}`)
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const deadline = Date.now() + 60000
    while (true) {
      try {
        if (
          (
            await fetch(`${origin}/test/automations-readers.browser.html`, {
              signal: AbortSignal.timeout(2000),
            })
          ).ok
        )
          break
      } catch {}
      if (Date.now() > deadline || server.exitCode !== null)
        throw new Error('Automation fixture failed to start')
      await sleep(200)
    }
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    const snapshots: SidebarSnapshot[] = [],
      results: Record<string, unknown> = {}
    for (const arm of ['pool'] as const) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
      let pageErrors = 0
      page.on('pageerror', (error) => {
        pageErrors++
        console.error(`Synthetic fixture: ${error.message}`)
      })
      await page.addInitScript(
        ({ clock }) => {
          Object.assign(window, {
            Date: new Proxy(Date, {
              construct: (target, args) => Reflect.construct(target, args.length ? args : [clock]),
              get: (target, key) => (key === 'now' ? () => clock : Reflect.get(target, key)),
            }),
          })
        },
        { clock },
      )
      await page.goto(`${origin}/test/automations-readers.browser.html`)
      await page.waitForFunction(() => window.__automationReaders?.ready(), null, {
        timeout: 60000,
      })
      // Drive the affected run-link reader and actual launch dialog once.
      await page.getByRole('button', { name: 'Expand Synthetic automation 0 runs' }).click()
      await page.waitForFunction(() => document.body.textContent?.includes('Open session'))
      await page.evaluate(() => window.__openAutomationDialog())
      await page.getByRole('dialog').getByLabel('Name').waitFor()
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      await page.evaluate(() => window.__automationReaders.reset())
      const cdp = await page.context().newCDPSession(page)
      if (!countsOnly) await cdp.send('Performance.enable')
      const metrics = async () =>
        Object.fromEntries(
          (await cdp.send('Performance.getMetrics')).metrics.map((entry) => [
            entry.name,
            entry.value,
          ]),
        )
      const initial = countsOnly ? {} : await metrics()
      await page.evaluate(() => window.__automationReaders.activity(200))
      const final = countsOnly ? {} : await metrics()
      const stats = await page.evaluate(() => window.__automationReaders.stats())
      if (stats.runtimes !== 1 || stats.publishes !== 200 || stats.failures.length || pageErrors)
        throw new Error('Runtime/browser ownership guard failed')
      if (stats.selectors) throw new Error('Enabled screen executed a legacy derivation')
      const { commitMs, ...counts } = stats
      results[arm] = {
        ...counts,
        pageErrors,
        ...(!countsOnly
          ? {
              taskMs: ((final.TaskDuration ?? 0) - (initial.TaskDuration ?? 0)) * 1000,
              scriptMs: ((final.ScriptDuration ?? 0) - (initial.ScriptDuration ?? 0)) * 1000,
              commitMs,
            }
          : {}),
      }
      if (arm === 'pool') {
        const check = await page.evaluate(() => window.__automationReaders.check())
        if (!check || check.differences || check.pending)
          throw new Error(`Graph comparison failed: ${JSON.stringify(check)}`)
        results.graph = check
      }
      await page.evaluate(() => window.__automationReaders.update())
      snapshots.push(await page.evaluate(() => window.__automationReaders.snapshot()))
      await page.screenshot({ path: `${output}/${arm}.png` })
      await page.evaluate(() => window.__closeAutomationDialog())
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      await page.screenshot({ path: `${output}/${arm}-screens.png` })
      await page.evaluate(() => window.__automationReaders.close())
      await page.close()
    }
    const report = { ...results, output: snapshots[0] }
    await writeFile(
      `${output}/${countsOnly ? 'counts' : 'timing'}.json`,
      `${JSON.stringify(report, null, 2)}\n`,
    )
    console.log(JSON.stringify(report))
  } finally {
    await browser?.close()
    if (server.exitCode === null) {
      const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()))
      server.kill()
      await exited
    }
  }
}
await main()
