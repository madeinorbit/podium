/** Retained V8 heap before/after legacy issue retention, using POD-5133's fixture.
 * Synthetic captures run on flatblock under bench:flatblock. Operator data is
 * exported and replayed only on ludovico; output contains counts and byte totals.
 * --export-operator writes a private .live input; delete it after the replay.
 * Build: bun apps/web/harness/pool-memory.ts --phase=build
 * Capture: bun apps/web/harness/legacy-issue-memory.ts --lease-confirmed
 * Operator: ... --export-operator, then ... --operator=<private input path>
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname, loadavg } from 'node:os'
import { extname, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { readLive } from '../../../packages/worklist-proto/harness/src/fixture/export-snapshot'
import { corpusFromLive } from '../../../packages/worklist-proto/harness/src/fixture/live-snapshot'
import type {} from '../test/pool-memory.browser'

const arg = (name: string, fallback = '') =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const operator = arg('operator')
const operatorExport = process.argv.includes('--export-operator')
if ((operator || operatorExport) && hostname() !== 'ludovico')
  throw new Error('Operator data stays on ludovico')
const privateInput = resolve('packages/worklist-proto/harness/.live/POD-4970-memory-input.json')
if (operatorExport) {
  const { raw, bootstrapEntityCounts } = await readLive(arg('origin', 'http://127.0.0.1:18787'))
  await mkdir(resolve('packages/worklist-proto/harness/.live'), { recursive: true })
  await writeFile(
    privateInput,
    JSON.stringify(corpusFromLive(raw, Date.parse('2026-09-20T12:00:00Z'))),
    { mode: 0o600 },
  )
  console.log(JSON.stringify({ exported: true, counts: bootstrapEntityCounts }))
  process.exit(0)
}
if (!operator && (hostname() !== 'flatblock' || !process.argv.includes('--lease-confirmed'))) {
  throw new Error('Synthetic measurement needs flatblock and bench:flatblock')
}
const samples = Number(arg('samples', '5'))
const cells = operator ? ['operator'] : arg('cells', '1x,4x').split(',')
const modes = arg('modes', 'legacy,pool').split(',')
const build = resolve('.artifacts/pool-memory/build')
const out = resolve(arg('out', '.artifacts/legacy-issue-memory/counts.json'))
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { timeout: 10_000 }).toString().trim()
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const file =
      path === '/operator-input.json' && operator ? resolve(operator) : resolve(build, `.${path}`)
    if (file !== resolve(operator) && !file.startsWith(`${build}/`)) {
      res.writeHead(403)
      res.end()
      return
    }
    res.setHeader(
      'Content-Type',
      (
        {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
        } as Record<string, string>
      )[extname(file)] ?? 'application/octet-stream',
    )
    res.end(await readFile(file))
  } catch {
    res.writeHead(404)
    res.end()
  }
})
await new Promise<void>((done) => server.listen(41701, '127.0.0.1', done))
const candidates = [
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`,
]
const executablePath = candidates.find((path) => existsSync(path))
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
  env: { ...process.env, LD_LIBRARY_PATH: resolve('.toolchain/lib') },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-precise-memory-info'],
})
type MemorySample = {
  cell: string
  mode: string
  drop: boolean
  sample: number
  heapBytes: number
  oldRecords: number
  projections: number
  sessions: number
  visibleRows: number
  loadavg: number[]
  sha: string
}
const records: MemorySample[] = []
const parity = new Map<string, Awaited<ReturnType<Window['__memory']['fingerprint']>>>()
let comparisons = 0
try {
  for (const cell of cells)
    for (const mode of modes)
      for (let sample = 0; sample < samples; sample++) {
        for (const drop of sample % 2 === 0 ? [false, true] : [true, false]) {
          const context = await browser.newContext({
            viewport: { width: 1800, height: 1000 },
            reducedMotion: 'reduce',
          })
          try {
            const page = await context.newPage()
            let errors = 0
            page.on('pageerror', () => errors++)
            page.setDefaultTimeout(120_000)
            await page.addInitScript(() => {
              Date.now = () => Date.parse('2026-09-20T12:00:00Z')
            })
            await page.goto(
              `http://127.0.0.1:41701/test/pool-memory.browser.html?mobxSidebar=${mode === 'pool' ? 1 : 0}&dropLegacyIssues=${drop ? 1 : 0}&scale=${cell === '4x' ? 4 : 1}${operator ? '&operator=1' : ''}`,
            )
            await page.waitForFunction(
              () => window.__memory?.ready() && document.querySelector('[data-issue-row]') !== null,
            )
            await page.evaluate(() => document.fonts.ready)
            await page.evaluate(
              () =>
                new Promise<void>((done) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => done())),
                ),
            )
            if ((await page.evaluate(() => window.__memory.mode())) !== mode)
              throw new Error('Wrong sidebar mode')
            const state = await page.evaluate(() => window.__memory.state())
            if (state.oldRecords !== (drop ? 0 : state.projections))
              throw new Error('Retention guard RED')
            // A ready runtime can still be sizing the virtualized sidebar.
            // Require its model and screen hashes to settle before comparing.
            let fingerprint = await page.evaluate(() => window.__memory.fingerprint())
            let stable = 0
            for (let attempt = 0; stable < 3 && attempt < 30; attempt++) {
              await page.waitForTimeout(250)
              const next = await page.evaluate(() => window.__memory.fingerprint())
              stable = JSON.stringify(next) === JSON.stringify(fingerprint) ? stable + 1 : 0
              fingerprint = next
            }
            if (stable < 3) throw new Error('Screen did not settle')
            const key = `${cell}:${mode}:${sample}`
            if (parity.has(key)) {
              const previous = parity.get(key)!
              const differing = Object.keys(fingerprint).filter(
                (key) =>
                  previous[key as keyof typeof previous] !==
                  fingerprint[key as keyof typeof fingerprint],
              )
              if (differing.length > 0)
                throw new Error(`Screen/model parity RED (${differing.join(', ')})`)
              comparisons++
              parity.delete(key)
            } else parity.set(key, fingerprint)
            // Release the construction corpus and feed rows BEFORE GC, on every
            // sample. Keeping them would measure inputs the app has already dropped.
            await page.evaluate(() => window.__memory.releaseFixtureInputs())
            await page.waitForTimeout(500)
            const cdp = await context.newCDPSession(page)
            await cdp.send('HeapProfiler.collectGarbage')
            await page.waitForTimeout(150)
            await cdp.send('HeapProfiler.collectGarbage')
            const heap = await cdp.send('Runtime.getHeapUsage')
            errors += (await page.evaluate(() => window.__memory.errors())).length
            if (errors > 0) throw new Error(`Fixture failed (${errors} errors)`)
            const record = {
              cell,
              mode,
              drop,
              sample,
              heapBytes: heap.usedSize,
              oldRecords: state.oldRecords,
              projections: state.projections ?? 0,
              sessions: state.sessions ?? 0,
              visibleRows: await page.locator('[data-issue-row]').count(),
              loadavg: loadavg(),
              sha,
            }
            records.push(record)
            console.log(JSON.stringify(record))
          } finally {
            await context.close()
          }
        }
      }
} finally {
  await browser.close()
  await new Promise<void>((done) => server.close(() => done()))
}
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
const summaries = cells.flatMap((cell) =>
  modes.map((mode) => {
    const before = median(
      records.filter((r) => r.cell === cell && r.mode === mode && !r.drop).map((r) => r.heapBytes),
    )
    const after = median(
      records.filter((r) => r.cell === cell && r.mode === mode && r.drop).map((r) => r.heapBytes),
    )
    return {
      cell,
      mode,
      beforeBytes: before,
      afterBytes: after,
      savedBytes: before - after,
      savedPercent: ((before - after) / before) * 100,
    }
  }),
)
await mkdir(resolve(out, '..'), { recursive: true })
await writeFile(
  out,
  JSON.stringify(
    {
      host: hostname(),
      browser: browser.version(),
      sha,
      operator: Boolean(operator),
      samples,
      parityComparisons: comparisons,
      differingScreens: 0,
      records,
      summaries,
    },
    null,
    2,
  ),
)
console.log(JSON.stringify({ summaries, parityComparisons: comparisons, differingScreens: 0 }))
