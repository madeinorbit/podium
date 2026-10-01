import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import type {} from '../test/issue-chips.browser'

const origin = 'http://127.0.0.1:41678'
const out = '.artifacts/issue-chips'
await mkdir(out, { recursive: true })
const server = Bun.spawn(['timeout', '600s', process.execPath, 'run', '--cwd', 'apps/web', 'dev', '--', '--config', 'vite.chips-perf.config.ts', '--host', '127.0.0.1', '--port', '41678'], { stdout: 'ignore', stderr: 'inherit' })
console.log(`Issue-chip browser server PID ${server.pid}`)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const until = Date.now() + 60000
  while (true) {
    try { if ((await fetch(`${origin}/test/issue-chips.browser.html`, { signal: AbortSignal.timeout(2000) })).ok) break } catch {}
    if (Date.now() > until) throw new Error('Chip browser server did not start')
    await Bun.sleep(200)
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const results: Array<Record<string, unknown>> = []
  const snapshots: unknown[] = []
  for (const mode of ['legacy', 'pool'] as const) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/test/issue-chips.browser.html?issues=4887&mobxSidebar=0&mobxChips=${mode === 'pool' ? 1 : 0}`, { waitUntil: 'networkidle', timeout: 60000 })
    await page.waitForFunction(() => window.__issueChips?.ready(), null, { timeout: 60000 })
    const times: number[] = []
    for (let sample = 0; sample < 5; sample++) {
      await page.evaluate(() => window.__issueChips.open(false))
      const ms = await page.evaluate(async () => {
        const start = performance.now()
        window.__issueChips.open()
        const deadline = start + 30000
        while (document.querySelectorAll('a[data-issue-availability="present"]').length < 361) {
          if (performance.now() > deadline) throw new Error('Conversation chips did not become ready')
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        }
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        return performance.now() - start
      })
      await page.waitForFunction(() => document.querySelectorAll('a[data-issue-availability="present"]').length >= 361)
      times.push(ms)
    }
    const before = await page.evaluate(() => window.__issueChips.stats())
    await page.evaluate(() => window.__issueChips.traffic())
    await page.waitForTimeout(200)
    const traffic = await page.evaluate(() => window.__issueChips.stats())
    if (mode === 'pool' && (traffic.legacyScans !== 0 || traffic.redraws !== before.redraws || traffic.reads !== before.reads)) throw new Error('Session traffic woke pool chips or scanned legacy issues')
    const paint = () => page.evaluate(() => [...document.querySelectorAll('a.ref-link--issue, [data-issue-reference]')].map(el => ({ ref: el.getAttribute('data-ref') ?? el.getAttribute('data-issue-reference'), stage: el.getAttribute('data-issue-stage'), availability: el.getAttribute('data-issue-availability'), label: el.getAttribute('aria-label'), text: el.textContent })))
    const initial = await paint()
    await page.screenshot({ path: `${out}/${mode}.png`, fullPage: false })
    await page.evaluate(() => window.__issueChips.patch(0, { title: 'Changed chip title', stage: 'review' }))
    await page.waitForFunction(() => document.querySelector('a[data-ref="SYN-1000"]')?.getAttribute('data-issue-stage') === 'review')
    const changed = await paint()
    const after = await page.evaluate(() => window.__issueChips.stats())
    const changedChips = changed.filter((row, i) => JSON.stringify(row) !== JSON.stringify(initial[i])).length
    if (changedChips < 2 || changedChips > 12) throw new Error(`Wrong chip fanout: ${changedChips}`)
    let check: unknown = null
    if (mode === 'pool') {
      check = await page.evaluate(() => window.__issueChips.check())
      if ((check as { differences: number; pending: number }).differences !== 0 || (check as { pending: number }).pending !== 0) throw new Error(`Chip side-by-side differs: ${JSON.stringify(check)}`)
    } else if (before.legacyScans === 0 || before.legacyRows < 4887) throw new Error('Legacy scan positive control inactive')
    if (errors.length || (await page.evaluate(() => window.__issueChips.failures())).length) throw new Error(`Browser errors: ${errors.join('; ')}`)
    times.sort((a, b) => a - b)
    results.push({ mode, issues: 4887, sessions: 674, messages: 120, chips: initial.length, openMs: times, medianOpenMs: times[2], before, traffic, after, changedChips, check })
    snapshots.push({ initial, changed })
    await page.close()
  }
  if (JSON.stringify(snapshots[0]) !== JSON.stringify(snapshots[1])) throw new Error('Legacy/pool chip values differ')
  await writeFile(`${out}/result.json`, JSON.stringify({ results, identicalChipValues: true }, null, 2))
  console.log(JSON.stringify(results))
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  await server.exited
}
