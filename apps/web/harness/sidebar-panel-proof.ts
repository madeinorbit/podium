/** Bounded real-browser acceptance, SYNTHETIC DATA ONLY. Run from repository
 * root on flatblock: bun run test:sidebar-panel -- --idle-seconds=300.
 * The pool app proof belongs to POD-5006 once the real runtime bridge exists. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const root = process.cwd()
const idleSeconds = Number(
  process.argv.find((arg) => arg.startsWith('--idle-seconds='))?.split('=')[1] ?? 300,
)
if (!Number.isFinite(idleSeconds) || idleSeconds < 3 || idleSeconds > 600)
  throw new Error('idle-seconds must be 3..600')
const out = resolve(root, '.artifacts/sidebar-panel')
await mkdir(out, { recursive: true })
const port = 41658
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
    'vite.sidebar.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ],
  {
    cwd: root,
    stdout: 'ignore',
    stderr: 'inherit',
  },
)
console.log(`Synthetic sidebar server PID ${server.pid}`)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const deadline = Date.now() + 60_000
  while (true) {
    try {
      if ((await fetch(origin, { signal: AbortSignal.timeout(2000) })).ok) break
    } catch {}
    if (Date.now() > deadline) throw new Error('Synthetic Vite server did not start within 60s')
    await Bun.sleep(200)
  }
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--enable-precise-memory-info'],
  })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/sidebar-harness.html?perfPanel=1&mobxSidebar=0&rows=6`, {
    waitUntil: 'networkidle',
    timeout: 60_000,
  })
  await page.getByTestId('sidebar-perf-panel').waitFor()
  await page.waitForTimeout(2500)
  // Start once startup/mount work has settled. Sampling calls ONLY the same
  // scalar reader as the panel. It never derives or snapshots the sidebar.
  const readReport = () =>
    page.evaluate(() => {
      const perf = globalThis.__podiumSidebarPerf
      if (!perf) throw new Error('Performance counter reader not installed')
      return perf.read()
    })
  const before = await readReport()
  const samples: unknown[] = []
  const began = Date.now()
  while (Date.now() - began < idleSeconds * 1000) {
    await page.waitForTimeout(Math.min(5000, idleSeconds * 1000 - (Date.now() - began)))
    const sample = await readReport()
    samples.push(sample)
    if (
      !sample.complete ||
      sample.idle.rows !== 0 ||
      sample.idle.derivations !== 0 ||
      sample.idle.mainThreadMs !== 0
    ) {
      await page.screenshot({ path: resolve(out, 'planted-row.png') })
      await writeFile(
        resolve(out, 'planted-row.json'),
        JSON.stringify({ before, sample, elapsedMs: Date.now() - began }, null, 2),
      )
      throw new Error(`Idle catcher RED: ${JSON.stringify(sample.idle)}`)
    }
    console.log(`Idle ${Math.round((Date.now() - began) / 1000)}s: 0 rows, 0 derivations, 0 ms`)
  }
  await page.screenshot({ path: resolve(out, 'legacy-idle.png') })
  // Drive one real sidebar click and keyboard gesture, then observe the panel.
  const row = page.locator('[data-issue-row]').first()
  await row.click()
  await page.waitForTimeout(100)
  await row.press('Enter')
  await page.waitForTimeout(1200)
  const afterInput = await readReport()
  if (
    afterInput.input.count < 2 ||
    afterInput.input.lastMs === null ||
    afterInput.input.p95 === null
  )
    throw new Error('Sidebar click/key did not reach the input-to-paint collector')
  await page.screenshot({ path: resolve(out, 'legacy-input.png') })
  await page.getByRole('button', { name: 'Close performance panel' }).click()
  const disabled = await page.evaluate(() => ({
    enabled: globalThis.__podiumStoreStats?.snapshot().enabled,
    attached: !!globalThis.__podiumSidebarPerf,
  }))
  if (disabled.enabled || disabled.attached)
    throw new Error('Closing panel left diagnostics enabled')
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`)
  await writeFile(
    resolve(out, 'legacy-proof.json'),
    JSON.stringify(
      {
        synthetic: true,
        path: 'legacy',
        requestedSeconds: idleSeconds,
        elapsedMs: Date.now() - began,
        before,
        samples,
        afterInput,
        disabled,
      },
      null,
      2,
    ),
  )
  console.log(
    `Panel proof GREEN: ${idleSeconds}s idle, real click/key, statistics disabled after close. Pool application proof pending POD-5006.`,
  )
} finally {
  await browser?.close()
  server.kill()
  await server.exited
}
