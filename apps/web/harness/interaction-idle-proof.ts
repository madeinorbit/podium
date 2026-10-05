/** Fresh live-panel evidence over the canonical full UI's synthetic corpus.
 * Run foreground on flatblock while holding meter:flatblock. This records
 * remaining work; it never replaces a baseline or treats residual work as green. */
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { extname, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { build } from 'vite'
import type {} from '../test/sidebar-acceptance.browser'
import config from './sidebar-acceptance.vite'

const args = process.argv.slice(2)
const sourceSha = args.find(arg => arg.startsWith('--source-sha='))?.slice(13)
if (hostname() !== 'flatblock' || !args.includes('--lease-confirmed'))
  throw new Error('Run on flatblock under the caller-held meter:flatblock lease')
if (!sourceSha || !/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Supply the copied source SHA')
if (args.some(arg => arg !== '--lease-confirmed' && !arg.startsWith('--source-sha=')))
  throw new Error('Unknown idle proof argument')

const out = resolve('.artifacts/interaction-idle-proof')
const buildDir = resolve(out, 'build')
await mkdir(out, { recursive: true })
await writeFile(resolve(out, 'report.json'), JSON.stringify({ sourceSha, status: 'running', captures: [] }) + '\n')
console.info(JSON.stringify({ pid: process.pid, sourceSha, capture: 'synthetic full UI', windowMs: 61_000 }))
await build({
  ...config,
  configFile: false,
  plugins: config.plugins?.filter(plugin => (plugin as { name?: string })?.name !== 'acceptance-state-boundaries'),
  build: { ...config.build, outDir: buildDir, sourcemap: false, minify: 'esbuild' },
})
const server = createServer(async (request, response) => {
  try {
    const path = resolve(buildDir, '.' + new URL(request.url ?? '/', 'http://localhost').pathname)
    if (!path.startsWith(buildDir + '/')) { response.writeHead(403); response.end(); return }
    const bytes = await readFile(path)
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream')
    response.end(bytes)
  } catch { response.writeHead(404); response.end() }
})
await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const captures: unknown[] = []
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
    env: { ...process.env, LD_LIBRARY_PATH: [resolve('.toolchain/lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  for (const scale of [1, 4]) for (const mode of ['quiet', 'heartbeat']) {
    const context = await browser.newContext({ viewport: { width: 1800, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
    try {
      const page = await context.newPage(), errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      // The fixture owns every data value. It can never contact the operator.
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
      await page.addInitScript(() => {
        const began = performance.now()
        Date.now = () => Date.parse('2026-09-20T12:00:00Z') + Math.floor(performance.now() - began)
      })
      await page.goto(`${origin}/test/sidebar-acceptance.browser.html?scale=${scale}&surface=full&panelMode=chat&measure=1`)
      await page.waitForFunction(() => window.__acceptance?.ready() && document.querySelector('[data-issue-row]'), undefined, { timeout: 60_000 })
      await page.evaluate(() => window.__acceptance.settled())
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(2000)
      const before = await page.evaluate(() => ({ state: window.__acceptance.state(), corpus: window.__acceptance.corpus, panel: window.__acceptance.perf() }))
      if (!before.state.pool || !before.panel?.pool.connected) throw new Error('Real pool panel counters are not connected')
      const cdp = await context.newCDPSession(page)
      await cdp.send('Profiler.enable'); await cdp.send('Profiler.start')
      await page.evaluate(() => window.__acceptance.begin())
      const began = performance.now()
      let feedUpdates = 0
      for (let second = 0; second < 61; second++) {
        await page.waitForTimeout(1000)
        if (mode === 'heartbeat' && (second + 1) % 6 === 0) {
          await page.evaluate(iteration => window.__acceptance.event('unrelated', iteration), ++feedUpdates)
        }
        if ((second + 1) % 20 === 0) console.info(`Idle capture ${scale}x ${mode}: ${second + 1}s, no input`)
      }
      const elapsedMs = performance.now() - began
      const captured = await page.evaluate(() => window.__acceptance.stop())
      const profile = await cdp.send('Profiler.stop')
      await cdp.detach()
      const fixtureErrors = await page.evaluate(() => window.__acceptance.errors())
      if (errors.length || fixtureErrors.length) throw new Error(`Fixture errors: ${JSON.stringify({ errors, fixtureErrors })}`)
      if (!captured.panel?.complete || captured.panel.windowMs < 60_000 || captured.panel.input.count !== 0)
        throw new Error('Idle window is incomplete or includes input')
      const samples = new Map<number, number>()
      for (const id of profile.profile.samples ?? []) samples.set(id, (samples.get(id) ?? 0) + 1)
      const cpu = profile.profile.nodes.map(node => ({ function: node.callFrame.functionName || '(anonymous)', samples: samples.get(node.id) ?? 0 }))
        .filter(node => node.samples > 0).sort((a, b) => b.samples - a.samples).slice(0, 30)
      await writeFile(resolve(out, `cpu-${scale}x-${mode}.json`), JSON.stringify(profile.profile))
      const record = { scale, mode, feedUpdates, elapsedMs, before, panel: captured.panel, stats: captured.stats, cpu, intervalCount: captured.intervals.length }
      captures.push(record)
      await writeFile(resolve(out, 'report.json'), JSON.stringify({ sourceSha, synthetic: true, status: captures.length === 4 ? 'complete' : 'partial', limitation: 'Canonical full UI fixture; not an operator instance timing claim. Heartbeat mode delivers ten controlled named-session updates; quiet mode delivers none.', captures }, null, 2) + '\n')
      console.info('IDLE_PANEL_COUNTERS', JSON.stringify({ scale, mode, feedUpdates, elapsedMs, idle: captured.panel.idle, input: captured.panel.input, pool: captured.panel.pool }))
    } finally { await context.close() }
  }
} finally {
  await browser?.close()
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
}
