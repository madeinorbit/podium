/** Real Chromium count/render comparison. No timing capture or operator data. */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import { compareSidebarSnapshots, type SidebarSnapshot } from '@podium/client-graph/diagnostics/sidebar-check'
import type {} from './workflows-readers.browser'

async function main() {
  const red = process.argv.find(arg => arg.startsWith('--red-control='))?.split('=')[1]
  const output = '.artifacts/workflows', origin = 'http://127.0.0.1:45168', clock = Date.now()
  await mkdir(output, { recursive: true })
  const server = spawn(process.execPath, ['apps/web/node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.sidebar-pool-perf.config.ts', '--port', '45168', '--strictPort'], { stdio: 'ignore' })
  console.log(`Synthetic workflow Vite PID ${server.pid}`)
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const deadline = Date.now() + 60000
    while (true) {
      try { if ((await fetch(`${origin}/test/workflows-readers.html`, { signal: AbortSignal.timeout(2000) })).ok) break } catch {}
      if (Date.now() > deadline || server.exitCode !== null) throw new Error('Workflow fixture failed to start')
      await sleep(200)
    }
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    const snapshots: SidebarSnapshot[] = [], results: Record<string, unknown> = {}
    for (const arm of ['before', 'after'] as const) {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
      let pageErrors = 0
      page.on('pageerror', error => { pageErrors++; console.error(`Synthetic fixture: ${error.message}`) })
      await page.addInitScript(({ clock }) => {
        Object.assign(window, { Date: new Proxy(Date, {
          construct: (target, args) => Reflect.construct(target, args.length ? args : [clock]),
          get: (target, key) => key === 'now' ? () => clock : Reflect.get(target, key),
        }) })
      }, { clock })
      const enabled = arm === 'after' && red !== 'legacy'
      await page.goto(`${origin}/test/workflows-readers.html?mobxSidebar=1&mobxWorkflows=${Number(enabled)}`)
      await page.waitForFunction(() => window.__workflowReaders?.ready(), null, { timeout: 60000 })
      // Drive the affected placement control once without dispatching work.
      await page.getByLabel('Machine', { exact: true }).selectOption('synthetic-available')
      await page.getByLabel('Name', { exact: true }).fill('Synthetic draft')
      await page.evaluate(() => window.__workflowReaders.reset())
      await page.evaluate(() => window.__workflowReaders.activity(200))
      const stats = await page.evaluate(() => window.__workflowReaders.stats())
      if (stats.runtimes !== 1 || stats.publishes !== 200 || stats.failures.length || pageErrors) throw new Error(`Runtime/browser ownership guard failed: ${JSON.stringify({ ...stats, pageErrors })}`)
      if (arm === 'after' && (stats.selectors || Object.values(stats.legacy).some(Boolean))) throw new Error('Enabled screen executed a legacy derivation')
      if (arm === 'before' && (stats.selectors < 200 || (stats.legacy['workflows.machines'] ?? 0) < 200 || !stats.legacy['workflows.subject'])) throw new Error('Legacy baseline did not exercise its readers')
      results[arm] = { ...stats, pageErrors }
      if (arm === 'after') {
        const check = await page.evaluate(() => window.__workflowReaders.check())
        if (!check || check.differences || check.pending) throw new Error(`Graph comparison failed: ${JSON.stringify(check)}`)
        results.graph = check
      }
      await page.screenshot({ path: `${output}/${arm}.png` })
      await page.evaluate(() => window.__workflowReaders.update())
      if (arm === 'after') {
        const check = await page.evaluate(() => window.__workflowReaders.check())
        if (!check || check.differences || check.pending) throw new Error(`Updated graph comparison failed: ${JSON.stringify(check)}`)
        results.updatedGraph = check
      }
      if (arm === 'after' && red === 'comparison') await page.locator('[data-profile-id] .text-sm').first().evaluate(node => { node.textContent = 'Planted rendered mismatch' })
      snapshots.push(await page.evaluate(() => window.__workflowReaders.snapshot()))
      await page.screenshot({ path: `${output}/${arm}-updated.png` })
      await page.evaluate(() => window.__workflowReaders.close())
      await page.close()
    }
    const comparison = compareSidebarSnapshots(snapshots[0]!, snapshots[1]!)
    if (comparison.differences || comparison.pending) throw new Error(`Browser output comparison failed: ${JSON.stringify(comparison)}`)
    const report = { ...results, comparison }
    await writeFile(`${output}/counts.json`, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify(report))
  } finally {
    await browser?.close()
    if (server.exitCode === null) {
      const exited = new Promise<void>(resolve => server.once('exit', () => resolve()))
      server.kill(); await exited
    }
  }
}
await main()
