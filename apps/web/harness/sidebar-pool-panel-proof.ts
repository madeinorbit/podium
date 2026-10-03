/** Bounded Chromium proof over SYNTHETIC data and the real app runtime.
 * Run on flatblock: bun run test:sidebar-pool-panel -- --idle-seconds=300.
 * --plant-before-idle proves the idle catcher red before the clean long run. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import type {} from '../../../packages/worklist-proto/harness/browser/runtime-pool-fixture'
import type {} from '../test/sidebar-pool-perf.browser'

const idleSeconds = Number(
  process.argv.find((arg) => arg.startsWith('--idle-seconds='))?.split('=')[1] ?? 300,
)
if (!Number.isFinite(idleSeconds) || idleSeconds < 3 || idleSeconds > 600)
  throw new Error('idle-seconds must be 3..600')
const planted = process.argv.includes('--plant-before-idle')
const out = resolve(process.cwd(), '.artifacts/sidebar-pool-panel')
await mkdir(out, { recursive: true })
const port = 41606
const origin = `http://127.0.0.1:${port}`
const server = Bun.spawn(
  [
    'timeout',
    '840s',
    process.execPath,
    'run',
    '--cwd',
    'apps/web',
    'dev',
    '--',
    '--config',
    'vite.sidebar-pool-perf.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ],
  { cwd: process.cwd(), stdout: 'ignore', stderr: 'inherit' },
)
console.log(`Synthetic pool server PID ${server.pid}`)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

try {
  const deadline = Date.now() + 60_000
  while (true) {
    try {
      if (
        (
          await fetch(`${origin}/test/sidebar-pool-perf.browser.html`, {
            signal: AbortSignal.timeout(2000),
          })
        ).ok
      )
        break
    } catch {}
    if (Date.now() > deadline) throw new Error('Synthetic pool server did not start within 60s')
    await Bun.sleep(200)
  }
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--enable-precise-memory-info'],
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } })
  const errors: string[] = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error(error.message)
  })
  await page.goto(`${origin}/test/sidebar-pool-perf.browser.html`, {
    waitUntil: 'networkidle',
    timeout: 60_000,
  })
  await page.waitForFunction(() => window.__poolPerfFixture?.ready(), null, { timeout: 30_000 })
  await page.waitForTimeout(2500)
  await page.waitForFunction(() => window.__poolPerfFixture?.ready(), null, { timeout: 30_000 })
  const read = () =>
    page.evaluate(() => {
      if (!globalThis.__podiumSidebarPerf) throw new Error('Panel counter reader missing')
      return {
        report: globalThis.__podiumSidebarPerf.read(),
        rowReads: window.__poolPerfFixture.rowReads(),
      }
    })
  const before = await read()
  if (!before.report.pool.connected || before.report.pool.rows !== 1)
    throw new Error('Real pool counters not connected')
  if (planted) await page.evaluate(() => window.__poolPerfFixture.startRedraw())
  const began = Date.now()
  const samples: Array<Awaited<ReturnType<typeof read>>> = []
  const isIdle = (report: typeof before.report) =>
    report.complete &&
    report.idle.rows === 0 &&
    report.idle.derivations === 0 &&
    report.idle.mainThreadMs === 0
  while (Date.now() - began < idleSeconds * 1000) {
    await page.waitForTimeout(Math.min(5000, idleSeconds * 1000 - (Date.now() - began)))
    const sample = await read()
    samples.push(sample)
    if (!isIdle(sample.report) || sample.rowReads !== before.rowReads) {
      await page.screenshot({ path: resolve(out, 'idle-catcher-red.png') })
      await writeFile(
        resolve(out, 'idle-catcher-red.json'),
        JSON.stringify({ before, sample, elapsedMs: Date.now() - began }, null, 2),
      )
      throw new Error(
        `Pool idle catcher RED: ${JSON.stringify(sample.report.idle)}, row reads ${sample.rowReads - before.rowReads}`,
      )
    }
    console.log(
      `Pool idle ${Math.round((Date.now() - began) / 1000)}s: 0 rows, 0 derivations, 0 ms, 0 row reads`,
    )
  }
  const idleElapsedMs = Date.now() - began
  const memory = await page.getByTestId('perf-memory').textContent()
  if (!memory || memory.includes('unavailable') || !memory.includes('Pool rows 1'))
    throw new Error('Chromium heap or resident pool count missing from panel')
  await page.screenshot({ path: resolve(out, 'pool-idle.png') })
  await page.evaluate(() => window.__poolPerfFixture.update())
  await page.getByTestId('pool-row').filter({ hasText: 'Updated synthetic pool row' }).waitFor()
  await page.waitForTimeout(1500)
  const updated = await read()
  if (
    !updated.report.lastUpdate ||
    updated.report.lastUpdate.pending ||
    updated.report.lastUpdate.work.rows !== 1 ||
    updated.report.lastUpdate.work.mainThreadMs <= 0
  ) {
    throw new Error(
      `Incoming pool update not measured: ${JSON.stringify(updated.report.lastUpdate)}`,
    )
  }
  if (!isIdle(updated.report)) throw new Error('Incoming update polluted idle counters')
  await page.screenshot({ path: resolve(out, 'pool-update.png') })

  const row = page.getByTestId('pool-row')
  await row.click()
  await row.press('Enter')
  await page.waitForTimeout(1500)
  const input = await read()
  if (input.report.input.count < 2 || input.report.input.p95 === null)
    throw new Error('Synthetic pool row click/key missed the paint seam')
  await page.evaluate(() => window.__poolPerfFixture.startRedraw())
  await page.waitForTimeout(5500)
  const redraw = await read()
  await page.evaluate(() => window.__poolPerfFixture.stopRedraw())
  if (isIdle(redraw.report) || redraw.report.idle.rows < 4)
    throw new Error('One-row-per-second plant was not caught')
  const visibleIdle = await page.getByTestId('perf-idle').textContent()
  if (!visibleIdle || /\b0 rows redrawn/.test(visibleIdle))
    throw new Error('Planted redraw not visible in the panel')
  await page.screenshot({ path: resolve(out, 'pool-planted-redraw.png') })
  await page.getByRole('button', { name: 'Close performance panel' }).click()
  const closed = await page.evaluate(() => ({
    attached: !!globalThis.__podiumSidebarPerf,
    legacyStats: globalThis.__podiumStoreStats?.snapshot().enabled,
  }))
  if (closed.attached || closed.legacyStats) throw new Error('Panel close left diagnostics enabled')
  const failures = await page.evaluate(() => window.__poolPerfFixture.failures())
  if (errors.length || failures.length)
    throw new Error(`Fixture errors: ${[...errors, ...failures].join('; ')}`)

  const proof = {
    synthetic: true,
    path: 'app-runtime-pool',
    requestedSeconds: idleSeconds,
    idleElapsedMs,
    memory,
    samples,
    before,
    updated,
    input,
    redraw,
    visibleIdle,
    closed,
    scope:
      'Real StoreProvider and pool; a synthetic measured observer row. Pool rendering and pool-only counters.',
  }
  await writeFile(resolve(out, 'pool-proof.json'), JSON.stringify(proof, null, 2))
  const picture = async (name: string) =>
    `data:image/png;base64,${(await readFile(resolve(out, name))).toString('base64')}`
  const html = `<!doctype html><meta charset="utf-8"><title>Pool panel proof</title><style>body{font:16px system-ui;max-width:1000px;margin:40px auto;background:#16181d;color:#eee}img{width:100%;border:1px solid #454854;border-radius:10px}p{line-height:1.6}pre{padding:20px;background:#22252d;white-space:pre-wrap}</style><h1>Pool numbers connected</h1><p>Synthetic Chromium on flatblock: ${Math.round(idleElapsedMs / 1000)} seconds idle, ${samples.length} samples. Every sample: zero rows, zero derivations, zero measured ms, zero row reads. One resident row on the app-owned runtime.</p><img src="${await picture('pool-idle.png')}"><p>One incoming update redrew ${updated.report.lastUpdate!.work.rows} row; ${updated.report.lastUpdate!.work.mainThreadMs.toFixed(2)} ms measured work.</p><img src="${await picture('pool-update.png')}"><p>The planted one-row-per-second timer was visible: ${visibleIdle}. Closing the panel detached its diagnostics.</p><img src="${await picture('pool-planted-redraw.png')}"><p>${proof.scope}</p>`
  await writeFile(resolve(out, 'pool-proof.html'), html)
  console.log(
    `Pool panel GREEN: ${idleSeconds}s idle, one-row update, visible redraw plant, input/check publishing seams, clean close.`,
  )
} finally {
  await browser?.close()
  server.kill()
  await server.exited
}
