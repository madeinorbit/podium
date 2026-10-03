/** Count-only browser acceptance on flatblock. Owns the Vite PID and browser. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import type {} from './chat-context.browser'

const rows = 5600, updates = 12, origin = 'http://127.0.0.1:45173', output = resolve('.artifacts/chat-context')
await mkdir(output, { recursive: true })
const server = spawn(process.execPath, ['apps/web/node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.sidebar-pool-perf.config.ts', '--port', '45173'], { stdio: ['ignore', 'ignore', 'inherit'] })
const exited = new Promise<void>((resolve, reject) => { server.once('exit', () => resolve()); server.once('error', reject) })
console.log(`Chat context fixture Vite PID ${server.pid}`)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const until = Date.now() + 60000
  while (true) {
    try { if ((await fetch(`${origin}/test/chat-context.browser.html`, { signal: AbortSignal.timeout(2000) })).ok) break } catch {}
    if (Date.now() >= until) throw new Error('Chat context fixture did not start')
    await sleep(200)
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const results: Record<string, unknown> = {}
  const snapshots: unknown[] = []
  for (const mode of ['legacy', 'pool'] as const) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/test/chat-context.browser.html?rows=${rows}&mobxChatContext=${mode === 'pool' ? 1 : 0}&mobxSessionPane=0`)
    await page.waitForFunction(() => window.__chatContextFixture?.ready(), null, { timeout: 60000 })
    if (mode === 'pool') await page.waitForFunction(() => {
      const result = window.__chatContextFixture.check()
      return result?.differences === 0 && result.pending === 0
    }, null, { timeout: 60000 })
    const snapshot = () => page.evaluate(() => ({ context: document.querySelector('[data-testid=context]')?.textContent,
      draft: document.querySelector('textarea')?.value,
      buttons: [...document.querySelectorAll('button')].map(row => ({ title: row.title, text: row.textContent, disabled: row.disabled })) }))
    const before = await snapshot()
    await page.evaluate(() => window.__chatContextFixture.reset())
    for (let step = 1; step <= updates; step++) {
      await page.evaluate(value => window.__chatContextFixture.update(value), step)
      await page.waitForFunction(value => document.querySelector('textarea')?.value === `Saved synthetic draft ${value}`, step)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }
    const stats = await page.evaluate(() => window.__chatContextFixture.stats())
    const legacy = Object.entries(stats.slices).filter(([key, value]) => value > 0 && /^(chatContext\.|sessionPane\.|sessionProjection\.)/.test(key))
    if (mode === 'pool' && legacy.length) throw new Error(`Legacy derivations: ${legacy.map(([key]) => key).join(',')}`)
    if (mode === 'legacy' && !legacy.length) throw new Error('Legacy counter red control did not run')
    const after = await snapshot()
    snapshots.push({ before, after })
    const parity = await page.evaluate(() => window.__chatContextFixture.check())
    if (mode === 'pool' && (!parity || parity.differences || parity.pending)) throw new Error(`Chat parity failed: ${JSON.stringify(parity)}`)
    if (mode === 'pool' && !await page.evaluate(() => window.__chatContextFixture.sawUnattached())) throw new Error('Late attachment was not observed')
    await page.addStyleTag({ content: '[data-testid=context]{display:none}' })
    await page.screenshot({ path: `${output}/${mode}.png` })
    if (errors.length || (await page.evaluate(() => window.__chatContextFixture.failures())).length) throw new Error(`Browser fixture errors: ${errors.join(';')}`)
    results[mode] = { ...stats, legacyDerivations: legacy.reduce((sum, [,count]) => sum + count, 0), parity,
      nullPoolAttachmentObserved: await page.evaluate(() => window.__chatContextFixture.sawUnattached()) }
    await page.evaluate(() => window.__chatContextFixture.close())
    await page.close()
  }
  if (JSON.stringify(snapshots[0]) !== JSON.stringify(snapshots[1])) throw new Error('Rendered conversation inputs or composer/offer UI differed')
  const report = { rows, updates, renderedDifferences: 0, ...results }
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await browser?.close(); server.kill(); await exited }
