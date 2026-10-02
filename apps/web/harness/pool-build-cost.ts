/** POD-5239. Build, time, or attribute; never overlap capture with validation.
 * Reported timings require flatblock + the caller's bench:flatblock lease.
 * Attribution uses fresh contexts and CDP GC, separately from timed runs. */
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname, loadavg } from 'node:os'
import { resolve, extname } from 'node:path'
import { createGzip } from 'node:zlib'
import { chromium, type Page, type CDPSession } from '@playwright/test'
import type {} from '../test/pool-build-cost.browser'

const arg = (name: string, fallback: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const mode = arg('phase', 'time')
const base = resolve('.artifacts/pool-build-cost')
const build = resolve(base, 'build')
const out = resolve(base, arg('out', mode))
if (mode === 'build') {
  const child = Bun.spawn(['timeout', '240s', process.execPath, resolve('apps/web/node_modules/vite/bin/vite.js'), 'build', '--config', resolve('apps/web/harness/pool-build-cost.vite.ts')], { stdout: 'ignore', stderr: 'inherit' })
  console.log(`Build PID ${child.pid}`)
  if (await child.exited) throw new Error('Build failed')
  process.exit(0)
}
if (hostname() !== 'flatblock') throw new Error('Synthetic captures run on flatblock')
if (mode === 'time' && !process.argv.includes('--lease-confirmed')) throw new Error('Take bench:flatblock and pass --lease-confirmed')
await mkdir(out, { recursive: true })
const cells = [
  { name: 'h1', history: 5000, resident: 600, displayed: 24 },
  { name: 'h2', history: 10000, resident: 600, displayed: 24 },
  { name: 'h4', history: 20000, resident: 600, displayed: 24 },
  { name: 'r2', history: 5000, resident: 1200, displayed: 24 },
  { name: 'r4', history: 5000, resident: 2400, displayed: 24 },
  { name: 'v4', history: 5000, resident: 600, displayed: 96 },
  { name: 'v16', history: 5000, resident: 600, displayed: 384 },
  { name: 'hot', history: 0, resident: 5600, displayed: 24 },
].filter(cell => arg('cells', '').split(',').includes(cell.name) || !arg('cells', ''))
const arms = arg('arms', 'legacy,pool').split(',')
const samples = Number(arg('samples', mode === 'time' ? '5' : '1'))
const sha = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim()
const server = createServer(async (req, res) => {
  try {
    const path = resolve(build, `.${new URL(req.url!, 'http://localhost').pathname}`)
    if (!path.startsWith(`${build}/`)) { res.writeHead(403); res.end(); return }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream')
    res.end(await readFile(path))
  } catch { res.writeHead(404); res.end() }
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Missing server port')
const chrome = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`
const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}),
  env: { ...process.env, LD_LIBRARY_PATH: resolve('.toolchain/lib') },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-precise-memory-info'] })
await writeFile(resolve(out, 'provenance.json'), JSON.stringify({ sha, browser: browser.version(), host: hostname(), args: process.argv.slice(2), synthetic: true, mode, cells, arms }, null, 2))
async function gc(page: Page, cdp: CDPSession) {
  await cdp.send('HeapProfiler.collectGarbage'); await page.waitForTimeout(150)
  await cdp.send('HeapProfiler.collectGarbage')
  return (await cdp.send('Runtime.getHeapUsage')).usedSize
}
async function snapshot(cdp: CDPSession, path: string) {
  const gzip = createGzip({ level: 6 }), file = createWriteStream(path)
  gzip.pipe(file)
  const receive = ({ chunk }: { chunk: string }) => { gzip.write(chunk) }
  cdp.on('HeapProfiler.addHeapSnapshotChunk', receive)
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  cdp.off('HeapProfiler.addHeapSnapshotChunk', receive)
  await new Promise<void>((done, fail) => { file.on('finish', done); file.on('error', fail); gzip.end() })
}
try {
  for (const cell of cells) for (let sample = 0; sample < samples; sample++) for (const arm of sample % 2 ? [...arms].reverse() : arms) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage(), errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    page.setDefaultTimeout(120_000)
    const query = new URLSearchParams({ arm, history: String(cell.history), resident: String(cell.resident), displayed: String(cell.displayed), detail: mode === 'attribute' ? '1' : '0' })
    await page.goto(`http://127.0.0.1:${address.port}/test/pool-build-cost.browser.html?${query}`)
    await page.waitForFunction(() => !!window.__buildCost)
    const cdp = await context.newCDPSession(page)
    let baseline = await gc(page, cdp)
    for (let generation = 0; generation < (mode === 'time' ? 3 : 1); generation++) {
      const phases = []
      const load = loadavg()
      let totalMs: number | null = null
      if (mode === 'time') {
        // One browser turn per complete build; no CDP/GC/profiler in it.
        const result = await page.evaluate(() => window.__buildCost.all())
        totalMs = result.ms; phases.push(...result.phases)
      } else {
        const names = await page.evaluate(() => window.__buildCost.phases)
        for (const name of [...names, ...(arm === 'settings' ? ['settings demand'] : [])]) {
          const heapBefore = baseline
          await cdp.send('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true })
          await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
          await cdp.send('Profiler.start')
          const result = await page.evaluate(name => window.__buildCost.phase(name), name)
          const cpu = (await cdp.send('Profiler.stop')).profile
          const allocation = (await cdp.send('HeapProfiler.stopSampling')).profile
          const heapAfter = await gc(page, cdp); baseline = heapAfter
          const stem = `${cell.name}-${arm}-${name.replaceAll(' ', '-')}`
          await writeFile(resolve(out, `${stem}.profiles.json`), JSON.stringify({ cpu, allocation }))
          phases.push({ ...result, heapBefore, heapAfter, retainedDelta: heapAfter - heapBefore,
            counts: await page.evaluate(() => window.__buildCost.counts()) })
        }
      }
      const heap = await gc(page, cdp)
      const counts = await page.evaluate(() => window.__buildCost.counts())
      if (errors.length || counts.failures.length) throw new Error(JSON.stringify({ errors, failures: counts.failures }))
      if (counts.rendered !== cell.displayed || counts.arm !== arm) throw new Error('Surface/mode guard failed')
      if (arm !== 'legacy' && (counts.tables?.issue !== cell.resident || counts.coldIssues !== cell.history || counts.tables.session !== cell.resident || counts.coldSessions !== cell.history)) throw new Error(`Residency guard failed ${JSON.stringify(counts)}`)
      const record = { cell: cell.name, arm, sample, generation, totalMs, phases, heap, counts, load, sha }
      await appendFile(resolve(out, 'records.jsonl'), `${JSON.stringify(record)}\n`)
      console.log(`${cell.name} ${arm} ${sample}/${generation}: ${totalMs?.toFixed(1) ?? 'profile'} ms; ${(heap / 1048576).toFixed(2)} MiB; resident ${counts.tables?.issue ?? '-'} cold ${counts.coldIssues}`)
      if (mode === 'attribute' && process.argv.includes('--snapshots')) {
        const stem = `${cell.name}-${arm}`
        const ids = await page.evaluate(() => window.__buildCost.ids())
        await page.evaluate(() => window.__buildCost.owners())
        await snapshot(cdp, resolve(out, `${stem}.heapsnapshot.gz`))
        await page.evaluate(() => window.__buildCost.dropOwners())
        await writeFile(resolve(out, `${stem}.meta.json`), JSON.stringify({ ids, cell, arm, heap, sha, counts }))
      }
      const disposalMs = await page.evaluate(() => { const began = performance.now(); window.__buildCost.dispose(); return performance.now() - began })
      const disposedHeap = await gc(page, cdp)
      const survivors = await page.evaluate(() => window.__buildCost.survivors())
      await appendFile(resolve(out, 'disposals.jsonl'), `${JSON.stringify({ cell: cell.name, arm, sample, generation, disposalMs, disposedHeap, survivors })}\n`)
      if (survivors) throw new Error(`Departed pool/runtime retained: ${survivors}`)
    }
    await context.close()
  }
} finally { await browser.close(); await new Promise<void>(done => server.close(() => done())) }
