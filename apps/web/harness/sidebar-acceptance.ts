/** Foreground, bounded, synthetic Chromium acceptance on flatblock only.
 * Build: --phase=build. Counts/guards: --phase=counts (untimed).
 * Timing, memory and attribution require the caller's bench:flatblock lease.
 * All records are appended before assertions; a failed bar remains evidence. */
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname, loadavg, uptime } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { chromium, type Browser, type Page, type CDPSession } from '@playwright/test'
import plan from './sidebar-acceptance-plan.json'
import type {} from '../test/sidebar-acceptance.browser'

const arg = (name: string, fallback: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback
const phase = arg('phase', 'timing')
const base = resolve(process.cwd(), '.artifacts/sidebar-acceptance')
const out = resolve(base, phase)
const build = resolve(base, 'build')
const url = 'http://127.0.0.1:41659/test/sidebar-acceptance.browser.html'
const raw = resolve(out, 'records.jsonl')
await mkdir(out, { recursive: true })
const runtimeSha = execFileSync('git', ['rev-parse', 'HEAD'], { timeout: 10_000 }).toString().trim()
const runner = () => ({ host: hostname(), loadavg: loadavg(), uptimeSeconds: uptime(),
  uptimeText: execFileSync('uptime', [], { timeout: 10_000 }).toString().trim() })
if (hostname() !== plan.host) throw new Error(`Acceptance runs on ${plan.host}, got ${hostname()}`)
if (['timing', 'memory', 'attribution'].includes(phase) && !process.argv.includes('--lease-confirmed'))
  throw new Error('Timed run needs the bench:flatblock lease and --lease-confirmed')

if (phase === 'build') {
  const processBuild = Bun.spawn(['timeout', '240s', process.execPath,
    resolve('apps/web/node_modules/vite/bin/vite.js'), 'build', '--config',
    resolve('apps/web/harness/sidebar-acceptance.vite.ts')], { stdout: 'ignore', stderr: 'inherit' })
  console.log(`Acceptance build PID ${processBuild.pid}`)
  if (await processBuild.exited !== 0) throw new Error('Acceptance build failed')
  console.log('Ordinary production fixture built; same assets serve both arms')
  process.exit(0)
}

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname)
    const path = resolve(build, `.${pathname}`)
    if (!path.startsWith(`${build}/`)) { res.writeHead(403); res.end(); return }
    const bytes = await readFile(path)
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
      '.woff2': 'font/woff2', '.json': 'application/json', '.map': 'application/json' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream')
    res.end(bytes)
  } catch { res.writeHead(404); res.end() }
})
await new Promise<void>(done => server.listen(41659, '127.0.0.1', done))
const browser = await chromium.launch({ headless: true,
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  env: { ...process.env, LD_LIBRARY_PATH: resolve('.toolchain/lib') },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-precise-memory-info'] })
await writeFile(resolve(out, 'provenance.json'), JSON.stringify({ phase, plan, runtimeSha,
  candidate: plan.candidate, browser: browser.version(), runner: runner(), viewport: { width: 1800, height: 1000 },
  synthetic: true, ordinaryRenderer: true, instrumentation: 'passive shipped measurement hooks plus runtime batch wrapper; checker off in timing' }, null, 2))

let recordNumber = 0
const save = async (value: Record<string, unknown>) => {
  const host = runner()
  const record = { record: ++recordNumber, capturedAt: new Date().toISOString(), runtimeSha,
    ...value, runner: host, valid: host.loadavg[0]! <= plan.maxLoad }
  await appendFile(raw, `${JSON.stringify(record)}\n`)
  return record
}
type Open = { page: Page; cdp: CDPSession; close(): Promise<void> }
async function open(mode: 'pool' | 'legacy', scale: string, surface = 'sidebar', measure = true): Promise<Open> {
  const context = await browser.newContext({ viewport: { width: 1800, height: 1000 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  page.setDefaultNavigationTimeout(120_000)
  const failures: string[] = []
  page.on('pageerror', error => { failures.push(error.message); console.error('PAGE', error.message) })
  await page.addInitScript(() => {
    const began = performance.now()
    Date.now = () => Date.parse('2026-09-20T12:00:00Z') + Math.floor(performance.now() - began)
    const capture = { target: '', input: null as number | null, selectedDom: null as number | null,
      twoRaf: null as number | null, events: [] as Record<string, unknown>[], running: false }
    document.addEventListener('click', event => {
      const row = (event.target as Element | null)?.closest('[data-issue-row]')
      if (!row || !capture.running) return
      if (!(event as MouseEvent).isTrusted) throw new Error('Acceptance click is not trusted')
      capture.input = event.timeStamp
      performance.mark('acceptance:input', { startTime: event.timeStamp })
      requestAnimationFrame(() => requestAnimationFrame(() => {
        capture.twoRaf = performance.now(); performance.mark('acceptance:two-raf')
      }))
    }, true)
    new MutationObserver(() => {
      if (!capture.running || capture.input === null || capture.selectedDom !== null) return
      if (document.querySelector(`[data-issue-row="${capture.target}"][data-selected="true"]`)) {
        capture.selectedDom = performance.now(); performance.mark('acceptance:selected-dom')
      }
    }).observe(document, { childList: true, subtree: true, attributes: true })
    const original = IDBObjectStore.prototype.getAll
    IDBObjectStore.prototype.getAll = function (...args: Parameters<typeof original>) {
      const started = performance.now()
      const request = original.apply(this, args)
      if (capture.running) {
        const record: Record<string, unknown> = { kind: 'getAll', store: this.name, start: started,
          enqueueMs: performance.now() - started }
        capture.events.push(record)
        request.addEventListener('success', () => { record.complete = performance.now(); record.rows = request.result.length })
      }
      return request
    }
    Object.assign(window, { __capture: capture })
  })
  const query = `?mobxSidebar=${mode === 'pool' ? 1 : 0}&scale=${scale === '4x' ? 4 : 1}&surface=${surface}&measure=${measure ? 1 : 0}&perfPanel=${measure ? 1 : 0}&panelMode=chat${scale === 'h10a1' ? '&cell=h10a1' : ''}`
  await page.goto(url + query, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__acceptance?.ready() && document.querySelector('[data-issue-row]') !== null)
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  const actual = await page.evaluate(() => window.__acceptance.mode())
  const expected = process.argv.includes('--plant-mode') ? (mode === 'pool' ? 'legacy' : 'pool') : mode
  if (actual !== expected) throw new Error(`Mode guard RED: expected ${expected}, got ${actual}`)
  const errors = await page.evaluate(() => window.__acceptance.errors())
  if (failures.length || errors.length) throw new Error(`Fixture errors: ${[...failures, ...errors].join('; ')}`)
  const cdp = await context.newCDPSession(page)
  return { page, cdp, close: () => context.close() }
}
async function gc(opened: Open) {
  await opened.cdp.send('HeapProfiler.collectGarbage')
  await opened.page.waitForTimeout(150)
  await opened.cdp.send('HeapProfiler.collectGarbage')
  return opened.cdp.send('Runtime.getHeapUsage')
}
async function traceStart(cdp: CDPSession) {
  const events: any[] = []
  const receive = ({ value }: { value: any[] }) => events.push(...value)
  cdp.on('Tracing.dataCollected', receive)
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' })
  return async () => {
    const complete = new Promise<void>(done => cdp.once('Tracing.tracingComplete', () => done()))
    await cdp.send('Tracing.end'); await complete; cdp.off('Tracing.dataCollected', receive)
    return events
  }
}
function traceSummary(events: any[]) {
  const input = events.filter(e => e.name === 'acceptance:input')
  const selected = events.filter(e => e.name === 'acceptance:selected-dom')
  const proxy = events.filter(e => e.name === 'acceptance:two-raf')
  if (input.length !== 1 || selected.length !== 1 || proxy.length !== 1)
    throw new Error(`Incomplete paint trace: input ${input.length}, DOM ${selected.length}, RAF ${proxy.length}`)
  const paint = events.filter(e => e.name === 'Paint' && e.ph === 'X' && e.ts >= selected[0].ts && e.pid === input[0].pid).sort((a, b) => a.ts - b.ts)[0]
  if (!paint) throw new Error('No Chromium Paint after selected DOM marker')
  const end = paint.ts + (paint.dur ?? 0)
  const names = ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint']
  const layout = Object.fromEntries(names.map(name => [name, events.filter(e => e.name === name && e.ph === 'X' && e.ts >= input[0].ts && e.ts < proxy[0].ts).reduce((n, e) => n + (e.dur ?? 0), 0) / 1000]))
  return { inputToPaintMs: (end - input[0].ts) / 1000, selectedDomMs: (selected[0].ts - input[0].ts) / 1000,
    twoRafMs: (proxy[0].ts - input[0].ts) / 1000, layout, markers: { input: input[0].ts, selectedDom: selected[0].ts, paint: paint.ts, paintEnd: end, twoRaf: proxy[0].ts } }
}
const orders = (iteration: number) => iteration % 2 === 0 ? ['legacy', 'pool'] as const : ['pool', 'legacy'] as const

try {
  if (phase === 'smoke') {
    const fixture = await open('pool', '1x')
    console.log('Mode guard green', await fixture.page.evaluate(() => window.__acceptance.state()))
    await fixture.close()
  } else if (phase === 'counts') {
    for (const scale of plan.scales) {
      for (const mode of ['pool', 'legacy'] as const) {
        const opened = await open(mode, scale)
        const { page } = opened
        await page.waitForTimeout(1500)
        await page.evaluate(() => window.__acceptance.begin())
        for (let seconds = 0; seconds < plan.idleSeconds; seconds += 5) await page.waitForTimeout(Math.min(5, plan.idleSeconds - seconds) * 1000)
        await save({ kind: 'idle', scale, mode, seconds: plan.idleSeconds, result: await page.evaluate(() => window.__acceptance.stop()) })
        for (const kind of ['unrelated', 'title', 'phase', 'draft']) {
          await page.evaluate(() => window.__acceptance.begin())
          await page.evaluate(({ kind }) => window.__acceptance.event(kind, 0), { kind })
          await page.waitForTimeout(100)
          await save({ kind, scale, mode, result: await page.evaluate(() => window.__acceptance.stop()) })
        }
        if (mode === 'pool') {
          for (let iteration = 0; iteration < 12; iteration++) {
            if (iteration) await page.evaluate(i => window.__acceptance.event(['unrelated', 'title', 'phase', 'draft'][i % 4]!, i), iteration)
            await page.waitForTimeout(100)
            await save({ kind: 'parity', scale, mode, iteration, result: await page.evaluate(() => window.__acceptance.compare()) })
          }
          await page.screenshot({ path: resolve(out, `synthetic-${scale}.png`) })
        }
        for (const [principal, rebuild] of [['acceptance-bob', false], ['acceptance-bob', true]] as const) {
          const began = performance.now()
          await page.evaluate(({ principal, rebuild }) => window.__acceptance.show(principal, rebuild), { principal, rebuild })
          await page.waitForFunction(() => window.__acceptance.ready())
          const readyMs = performance.now() - began
          await page.waitForTimeout(1200)
          const heap = await gc(opened)
          await save({ kind: 'principal', scale, mode, principal, rebuild, readyMs, heap,
            survivors: await page.evaluate(() => window.__acceptance.survivors()), stats: await page.evaluate(() => window.__acceptance.stats()) })
        }
        await opened.close()
        console.log(`Counts retained ${scale} ${mode}`)
      }
    }
  } else if (phase === 'timing' || phase === 'attribution') {
    for (const scale of plan.scales) for (const surface of (phase === 'attribution' ? ['full'] : ['sidebar', 'full'])) {
      const pages = { legacy: await open('legacy', scale, surface), pool: await open('pool', scale, surface) }
      const rowIds = await pages.legacy.page.locator('[data-issue-row]').evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute('data-issue-row')!))])
      const shapes = await pages.legacy.page.evaluate(ids => window.__acceptance.shape(ids), rowIds)
      const ranked = shapes.filter(shape => shape.rows > 0).sort((a, b) => b.rows - a.rows)
      const targets = [ranked[0]!.id, ranked[1]!.id, ...ranked.slice(-4).map(shape => shape.id)]
      await writeFile(resolve(out, `targets-${scale}-${surface}.json`), JSON.stringify(shapes.filter(shape => targets.includes(shape.id)), null, 2))
      const retained = phase === 'attribution' ? 6 : plan.samples
      for (let i = 0; i < retained + plan.warmups; i++) for (const mode of orders(i)) {
        const opened = pages[mode]
        const { page, cdp } = opened
        await page.bringToFront()
        const target = targets[i % targets.length]!
        const row = page.locator(`[data-issue-row="${target}"]`).first()
        await row.scrollIntoViewIfNeeded(); await row.hover(); await page.waitForTimeout(40)
        await page.evaluate(target => {
          window.__acceptance.begin()
          const c = (window as any).__capture
          Object.assign(c, { running: true, target, input: null, selectedDom: null, twoRaf: null, events: [] })
          performance.clearMarks()
        }, target)
        const stopTrace = await traceStart(cdp)
        if (phase === 'attribution') {
          await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 1000 }); await cdp.send('Profiler.start')
        }
        await row.click()
        await page.waitForFunction(() => (window as any).__capture.twoRaf !== null && (window as any).__capture.selectedDom !== null)
        await page.waitForTimeout(80)
        await page.evaluate(() => window.__acceptance.settled())
        const result = await page.evaluate(() => {
          const capture = (window as any).__capture; capture.running = false
          return { measurement: window.__acceptance.stop(), capture: { ...capture }, state: window.__acceptance.state() }
        })
        const profile = phase === 'attribution' ? (await cdp.send('Profiler.stop')).profile : null
        const trace = await stopTrace()
        const paint = traceSummary(trace)
        if (result.state.selected !== target) throw new Error(`Trusted click selected ${result.state.selected}, expected ${target}`)
        if (i >= plan.warmups) {
          const index = i - plan.warmups
          const traceFile = `click-${scale}-${surface}-${mode}-${index}.trace.json`
          await writeFile(resolve(out, traceFile), JSON.stringify({ traceEvents: trace }))
          if (profile) await writeFile(resolve(out, traceFile.replace('.trace.json', '.cpuprofile')), JSON.stringify(profile))
          await save({ kind: 'click', scale, surface, mode, iteration: index, target, paint, result, traceFile })
          if (index % 10 === 0) console.log(`${scale} ${surface} ${mode} click ${index}: ${paint.inputToPaintMs.toFixed(1)} ms; twoRAF ${paint.twoRafMs.toFixed(1)} ms`)
        }
      }
      if (phase === 'timing' && surface === 'sidebar') {
        for (let i = 0; i < plan.samples + plan.warmups; i++) for (const mode of orders(i)) for (const kind of ['unrelated', 'title', 'phase', 'draft']) {
          const page = pages[mode].page
          await page.bringToFront()
          await page.evaluate(() => window.__acceptance.begin())
          await page.evaluate(({ kind, i }) => window.__acceptance.event(kind, i + 100), { kind, i })
          await page.waitForTimeout(80)
          await page.evaluate(() => window.__acceptance.settled())
          const result = await page.evaluate(() => window.__acceptance.stop())
          if (i >= plan.warmups) await save({ kind, scale, surface, mode, iteration: i - plan.warmups, result })
        }
        console.log(`Hot events retained ${scale}`)
      }
      await pages.legacy.close(); await pages.pool.close()
    }
  } else if (phase === 'memory') {
    for (const scale of plan.memoryCells) for (let i = 0; i < plan.startupAndMemorySamples; i++) for (const mode of orders(i)) {
      const before = runner()
      const began = performance.now()
      const opened = await open(mode, scale, 'sidebar', false)
      const startupMs = performance.now() - began
      const heapStartup = await opened.cdp.send('Runtime.getHeapUsage')
      await opened.page.waitForTimeout(500)
      const heapRetained = await gc(opened)
      const state = await opened.page.evaluate(() => ({ state: window.__acceptance.state(), corpus: window.__acceptance.corpus, rows: window.__acceptance.rowCount() }))
      await save({ kind: 'memory', scale, mode, iteration: i, startupMs, heapStartup, heapRetained, before, ...state })
      await opened.close()
      console.log(`Startup/retained ${scale} ${mode} ${i}: ${startupMs.toFixed(0)} ms; ${(heapRetained.usedSize / 1048576).toFixed(1)} MiB V8`)
    }
  } else throw new Error(`Unknown phase ${phase}`)
  console.log(`Acceptance ${phase} capture finished: ${recordNumber} raw records`)
} finally {
  await browser.close()
  await new Promise<void>(done => server.close(() => done()))
}
