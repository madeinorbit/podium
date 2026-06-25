/*
 * Drives perf/webgl-warmset/harness.html with Playwright Chromium (headless=new)
 * and prints raw numbers for (A) WebGL context cap, (B) per-terminal heap delta,
 * (C) hide/show return-to-typeable latency.
 *
 * Run from the MAIN checkout (where node_modules + Playwright browsers live):
 *   node perf/webgl-warmset/run-bench.mjs            # absolute harness path below
 *
 * No Podium server/daemon is started. Everything is in-page xterm + addons.
 */
import { chromium } from '@playwright/test'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const HARNESS_DIR = '/home/user/src/other/podium/.worktrees/webgl-measure/perf/webgl-warmset'

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
}

function serve(dir) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        let p = normalize(url.pathname)
        if (p === '/' || p === '') p = '/harness.html'
        const file = join(dir, p)
        if (!file.startsWith(dir)) {
          res.writeHead(403).end()
          return
        }
        const body = await readFile(file)
        res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
        res.end(body)
      } catch {
        res.writeHead(404).end()
      }
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function cdpHeap(client) {
  const { metrics } = await client.send('Performance.getMetrics')
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]))
  return m.JSHeapUsedSize || 0
}

async function main() {
  const server = await serve(HARNESS_DIR)
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/harness.html`

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--headless=new',
      // expose performance.memory with stable granularity
      '--enable-precise-memory-info',
      // do NOT add --disable-gpu: we WANT webgl (SwiftShader) to init if it can
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })
  const ctxName = browser.version()
  const page = await browser.newPage()
  const client = await page.context().newCDPSession(page)
  await client.send('Performance.enable')
  await client.send('HeapProfiler.enable').catch(() => {})

  async function gc() {
    // Force a real GC so per-terminal deltas reflect retained memory, not allocator
    // slack or a pending sweep. HeapProfiler.collectGarbage is the reliable CDP path.
    await client.send('HeapProfiler.collectGarbage').catch(() => {})
  }

  const logs = []
  page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

  await page.goto(base, { waitUntil: 'load' })
  await page.waitForFunction('window.__benchReady === true', { timeout: 15000 })

  const out = { chromium: ctxName, env: {}, A: {}, B: {}, C: {} }

  // ---- env / WebGL probe ----
  out.env.webgl = await page.evaluate(() => window.__bench.webglProbe())

  // ---- (A) context cap ----
  // Keep adding webgl-backed terminals until a context loss fires on any earlier
  // one, or new WebglAddon throws, or we hit a hard ceiling (safety).
  const HARD_MAX = 40
  const aSteps = []
  let capReason = 'hit-hard-max'
  for (let i = 0; i < HARD_MAX; i++) {
    const r = await page.evaluate(() => window.__bench.addWebglTerm())
    aSteps.push(r)
    if (r.webglThrew) {
      capReason = `new WebglAddon()/load threw at term #${r.total}: ${r.webglThrew}`
      break
    }
    if (r.anyContextLost) {
      capReason = `context loss fired (lost ids: ${r.lostIds.join(',')}) after adding term #${r.total}`
      break
    }
  }
  out.A = {
    reason: capReason,
    totalCreated: aSteps.length,
    liveWebglAtEnd: aSteps.length - (aSteps[aSteps.length - 1]?.lostIds?.length || 0),
    steps: aSteps,
  }
  await page.evaluate(() => window.__bench.reset())

  // ---- (B) per-terminal heap delta ----
  async function memSeries(mode, n) {
    const rows = []
    await gc()
    await page.waitForTimeout(150)
    let prevHeap = await page.evaluate(() => window.__bench.heap())
    let prevCdp = await cdpHeap(client)
    rows.push({ idx: 0, heap: prevHeap, cdp: prevCdp, dHeap: 0, dCdp: 0 })
    for (let i = 1; i <= n; i++) {
      await page.evaluate((m) => window.__bench.addMemTerm(m), mode)
      await page.waitForTimeout(200)
      await gc() // settle to retained-only before sampling
      await page.waitForTimeout(150)
      const h = await page.evaluate(() => window.__bench.heap())
      const c = await cdpHeap(client)
      rows.push({ idx: i, heap: h, cdp: c, dHeap: h - prevHeap, dCdp: c - prevCdp })
      prevHeap = h
      prevCdp = c
    }
    // Per-terminal cost = median of the steady-state positive deltas (skip idx 1,
    // which carries one-time renderer/atlas fixed costs). Median is robust to the
    // occasional GC-boundary negative sample.
    const deltas = rows.slice(2).map((r) => r.dHeap).filter((x) => x > 0).sort((a, b) => a - b)
    const cdeltas = rows.slice(2).map((r) => r.dCdp).filter((x) => x > 0).sort((a, b) => a - b)
    const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : 0)
    return {
      mode,
      rows,
      medDeltaHeap: Math.round(med(deltas)),
      medDeltaCdp: Math.round(med(cdeltas)),
      firstTermHeap: rows[1]?.dHeap ?? 0,
      firstTermCdp: rows[1]?.dCdp ?? 0,
    }
  }

  const MEM_N = 8
  for (const mode of ['webgl', 'dom', 'disposed']) {
    out.B[mode] = await memSeries(mode, MEM_N)
    await page.evaluate(() => window.__bench.reset())
    await page.waitForTimeout(300)
  }

  // ---- (C) latency ----
  for (const strat of ['retain', 'drop', 'dom']) {
    out.C[strat] = await page.evaluate((s) => window.__bench.latencyRun(s, 10), strat)
    await page.evaluate(() => window.__bench.reset())
    await page.waitForTimeout(200)
  }

  out.consoleTail = logs.slice(-20)

  console.log(JSON.stringify(out, null, 2))

  await browser.close()
  server.close()
}

main().catch((e) => {
  console.error('BENCH FAILED:', e)
  process.exit(1)
})
