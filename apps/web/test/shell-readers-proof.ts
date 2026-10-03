/** Foreground Chromium count proof on flatblock. No timing or private rows. */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import { compareSidebarSnapshots, type SidebarSnapshot } from '@podium/client-graph/diagnostics/sidebar-check'
import type {} from './shell-readers.browser'

const red = process.argv.find(arg => arg.startsWith('--red='))?.slice(6)
const output = '.artifacts/shell-readers', origin = 'http://127.0.0.1:45182', clock = Date.now()
await mkdir(output, { recursive: true })
const server = spawn(process.execPath, ['apps/web/node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.sidebar-pool-perf.config.ts', '--port', '45182', '--strictPort'], { stdio: ['ignore', 'ignore', 'ignore'] })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const deadline = Date.now() + 60000
  while (true) {
    try { if ((await fetch(`${origin}/test/shell-readers.browser.html`, { signal: AbortSignal.timeout(2000) })).ok) break } catch {}
    if (Date.now() > deadline || server.exitCode !== null) throw new Error('Shell fixture did not start')
    await sleep(200)
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const snapshots: SidebarSnapshot[][] = [], results: Record<string, unknown> = {}
  for (const arm of ['before', 'after'] as const) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' })
    let errors = 0
    page.on('pageerror', error => { errors++; console.error(`Synthetic shell fixture: ${error.message}`) })
    await page.addInitScript(({ clock }) => {
      Object.assign(window, { Date: new Proxy(Date, { construct: (target, args) => Reflect.construct(target, args.length ? args : [clock]), get: (target, key) => key === 'now' ? () => clock : Reflect.get(target, key) }) })
    }, { clock })
    await page.context().route('https://synthetic.example.invalid/**', route => route.fulfill({ body: 'Synthetic login destination' }))
    const switched = arm === 'after' && red !== 'legacy'
    await page.goto(`${origin}/test/shell-readers.browser.html?mobxSidebar=1&mobxCommands=1&mobxHeader=0&mobxSettings=0&mobxShell=${switched ? 1 : 0}&rows=5600`)
    await page.waitForFunction(() => window.__shellReaders?.ready(), null, { timeout: 60000 })
    await page.getByText('Synthetic task 0', { exact: true }).first().waitFor()
    await page.getByText('Host 3', { exact: true }).first().waitFor()
    const parity = arm === 'after' ? await page.evaluate(() => window.__shellReaders.check()) : null
    if (switched && (!parity || parity.differences || parity.pending)) throw new Error(`Shell data mismatch: ${JSON.stringify(parity)}`)
    await page.evaluate(() => window.__shellReaders.reset())
    await page.evaluate(() => window.__shellReaders.activity(200))
    const stats = await page.evaluate(() => window.__shellReaders.stats())
    if (stats.runtimeCount !== 1 || stats.publishes !== 200 || stats.failures || errors) throw new Error(`Shell runtime mismatch: ${JSON.stringify({ ...stats, errors })}`)
    if (arm === 'after' && (stats.selectors || stats.legacyDerivations || stats.dropped)) throw new Error(`Enabled shell executed legacy reads: ${JSON.stringify(stats)}`)
    if (arm === 'before' && !stats.selectors) throw new Error('Legacy baseline was not exercised')
    const frames: SidebarSnapshot[] = []
    for (const id of ['synthetic-1', 'synthetic-3', 'synthetic-5', null]) {
      await page.evaluate(id => window.__shellReaders.select(id), id)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      frames.push(await page.evaluate(() => window.__shellReaders.snapshot()))
    }
    await page.evaluate(() => window.__shellReaders.approvals())
    await page.getByRole('alertdialog').waitFor()
    frames.push(await page.evaluate(() => window.__shellReaders.snapshot()))
    await page.evaluate(() => window.__shellReaders.prompt())
    await page.getByRole('dialog').waitFor()
    frames.push(await page.evaluate(() => window.__shellReaders.snapshot()))
    await page.getByRole('button', { name: 'Not now', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    await page.evaluate(() => window.__shellReaders.browser())
    await page.getByRole('button', { name: 'Open login page' }).waitFor()
    frames.push(await page.evaluate(() => window.__shellReaders.snapshot()))
    const popup = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Open login page' }).click()
    const opened = await popup
    await opened.waitForURL('https://synthetic.example.invalid/login')
    await opened.close()
    await page.getByLabel('Paste the localhost callback URL').fill('http://localhost:12345/callback?code=synthetic')
    await page.getByRole('button', { name: 'Forward callback' }).click()
    const effects = await page.evaluate(() => window.__shellReaders.effects())
    if (effects.callbacks !== 1) throw new Error('Browser callback was not forwarded once')
    await page.evaluate(() => window.__shellReaders.select('synthetic-3'))
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const closed = await page.evaluate(() => window.__shellReaders.closeTab())
    const link = await page.evaluate(() => window.__shellReaders.activate())
    if (!closed || !link) throw new Error('Close-tab or Podium-link boundary did not activate')
    snapshots.push(frames)
    await page.screenshot({ path: `${output}/${arm}.png` })
    results[arm] = { ...stats, errors, parity, comparedFrames: frames.length, popupCount: 1, forwardedCallbacks: effects.callbacks, closedTabs: Number(closed), activatedLinks: Number(link) }
    await page.evaluate(() => window.__shellReaders.close())
    await page.close()
  }
  if (red === 'render') {
    const frame = snapshots[1]![0]!, section = frame.sections[0]!
    snapshots[1]![0] = { ...frame, sections: [{ ...section, fields: { ...section.fields, planted: true } }, ...frame.sections.slice(1)] }
  }
  const checks = snapshots[0]!.map((frame, index) => compareSidebarSnapshots(frame, snapshots[1]![index]!))
  if (checks.some(check => check.differences || check.pending || check.sections !== 7)) throw new Error(`Rendered shell differs: ${JSON.stringify(checks)}`)
  results.rendered = { frames: checks.length, sections: checks.reduce((sum, check) => sum + check.sections, 0), differences: 0 }
  await writeFile(`${output}/counts.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results))
} finally {
  await browser?.close()
  if (server.exitCode === null) { const exited = new Promise<void>(resolve => server.once('exit', () => resolve())); server.kill(); await exited }
}
