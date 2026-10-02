/** Actual production readers in real Chromium, one arm at a time. The before
 * arm restores only the six old acquisitions in this isolated checkout.
 * Timed runs require bench:flatblock; no backend or daemon is started. */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import { compareSidebarSnapshots, type SidebarSnapshot } from '@podium/client-graph/diagnostics/sidebar-check'
import type {} from './utility-readers.browser'

const sources = [
  'apps/web/src/features/usage/UsageView.tsx', 'apps/web/src/features/messages/MessageLedgerView.tsx',
  'apps/web/src/app/MissionCostChip.tsx', 'apps/web/src/app/FlightDeckHandoff.tsx',
  'apps/web/src/app/FlightDeckWaterfall.tsx', 'apps/web/src/app/use-handoff-transcript.ts',
]
async function legacyAcquisitions() {
  const originals = new Map<string, string>()
  try {
    for (const path of sources) {
      const original = await readFile(path, 'utf8')
      originals.set(path, original)
      const expression = path.endsWith('use-handoff-transcript.ts')
        ? 'useStoreHandle<Trpc>().getSnapshot()' : 'useStoreHandle<Trpc>().getSnapshot().trpc'
      if (original.split(expression).length !== 2) throw new Error('Expected exactly one stable acquisition per source')
      const legacy = path.endsWith('use-handoff-transcript.ts')
        ? 'useLegacySelector((store) => ({ trpc: store.trpc, replica: store.replica }), (a, b) => a.trpc === b.trpc && a.replica === b.replica)'
        : 'useLegacySelector((store) => store.trpc)'
      await writeFile(path, `import { useStoreSelector as useLegacySelector } from '@podium/client-core/react'\n${original.replace(expression, legacy)}`)
    }
  } catch (error) {
    for (const [path, original] of originals) await writeFile(path, original)
    throw error
  }
  return async () => { for (const [path, original] of originals) await writeFile(path, original) }
}

export async function runUtilityReadersProof(options: { countsOnly?: boolean; redControl?: boolean } = {}) {
  const output = '.artifacts/utility-readers', origin = 'http://127.0.0.1:45169', clock = Date.now()
  await mkdir(output, { recursive: true })
  const snapshots: SidebarSnapshot[] = [], results: Record<string, unknown> = {}
  for (const arm of ['before', 'after'] as const) {
    const restore = arm === 'before' ? await legacyAcquisitions() : async () => {}
    let server: ReturnType<typeof spawn> | undefined
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      server = spawn(process.execPath, ['apps/web/node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.sidebar-pool-perf.config.ts', '--port', '45169', '--strictPort'], { stdio: ['ignore', 'ignore', 'ignore'] })
      console.log(`Utility fixture ${arm} Vite PID ${server.pid}`)
      const deadline = Date.now() + 60000
      while (true) {
        try { if ((await fetch(`${origin}/test/utility-readers.browser.html`, { signal: AbortSignal.timeout(2000) })).ok) break } catch {}
        if (Date.now() > deadline || server.exitCode !== null) throw new Error('Utility fixture did not start')
        await sleep(200)
      }
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
      let pageErrors = 0
      page.on('pageerror', () => { pageErrors++ })
      await page.addInitScript(({ clock }) => {
        const fixed = new Proxy(Date, {
          construct: (target, args) => Reflect.construct(target, args.length ? args : [clock]),
          get: (target, key) => key === 'now' ? () => clock : Reflect.get(target, key),
        })
        Object.assign(window, { Date: fixed })
      }, { clock })
      await page.goto(`${origin}/test/utility-readers.browser.html`)
      await page.waitForFunction(() => window.__utilityReaders?.ready(), null, { timeout: 60000 })
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const initialCalls = await page.evaluate(() => window.__utilityReaders.stats().calls)
      await page.evaluate(() => window.__utilityReaders.reset())
      const cdp = await page.context().newCDPSession(page)
      if (!options.countsOnly) await cdp.send('Performance.enable')
      const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(entry => [entry.name, entry.value]))
      const initial = options.countsOnly ? {} : await metrics()
      await page.evaluate(() => window.__utilityReaders.activity(200))
      const final = options.countsOnly ? {} : await metrics()
      const stats = await page.evaluate(() => window.__utilityReaders.stats())
      const { commitMs, failures, ...counts } = stats
      results[arm] = { ...counts, pageErrors,
        ...(!options.countsOnly ? { taskMs: ((final.TaskDuration ?? 0) - (initial.TaskDuration ?? 0)) * 1000,
          scriptMs: ((final.ScriptDuration ?? 0) - (initial.ScriptDuration ?? 0)) * 1000, commitMs } : {}),
      }
      if (stats.runtimeCount !== 1 || stats.publishes !== 200 || failures.length || pageErrors) throw new Error('Utility runtime proof failed')
      if (JSON.stringify(initialCalls) !== JSON.stringify(stats.calls)) throw new Error('Unrelated activity refetched utility RPCs')
      if (arm === 'after' && (stats.selectors || stats.wakes || stats.legacyDerivations)) throw new Error('Legacy utility reader executed')
      if (arm === 'before' && stats.selectors < 1200) throw new Error('Six-selector baseline did not execute')
      snapshots.push(await page.evaluate(() => window.__utilityReaders.snapshot()))
      await page.screenshot({ path: `${output}/${arm}.png` })
      await page.evaluate(() => window.__utilityReaders.close())
    } finally {
      await browser?.close()
      if (server && server.exitCode === null) {
        const exited = new Promise<void>(resolve => server!.once('exit', () => resolve()))
        server.kill()
        await exited
      }
      await restore()
    }
  }
  if (options.redControl) snapshots[1] = { ...snapshots[1]!, sections: snapshots[1]!.sections.map((section, index) => index ? section : { ...section, fields: { planted: true } }) }
  const check = compareSidebarSnapshots(snapshots[0]!, snapshots[1]!)
  results.check = check
  if (check.differences || check.pending || check.sections !== 5) throw new Error(`Utility comparison failed: ${JSON.stringify(check)}`)
  await writeFile(`${output}/${options.countsOnly ? 'counts' : 'results'}.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results))
  return results
}
if (import.meta.main) await runUtilityReadersProof({ countsOnly: process.argv.includes('--counts-only'), redControl: process.argv.includes('--red-control') })
