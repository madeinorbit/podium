/**
 * POD-4747 — MEMORY BY LAYER, per arm and two-axis cell, from heap snapshots
 * by constructor. One held page per (arm, cell), loaded with `?layers=1`
 * (`harness/web/entrylib.ts` `stagePoint`), stops at each boot stage; the
 * driver forces a GC, reads the V8 heap (CDP `Runtime.getHeapUsage`, the
 * number every timing record carries) and takes a heap snapshot there:
 *
 *   script   the bundle evaluated, nothing built (the page's floor)
 *   fixture  the corpus built (`buildCorpusCell`: the HARNESS's rows)
 *   cache    the durable cache seeded: the kernel's own copy of every row
 *            (a `?layers=1` page seeds it with a copy of each fixture row,
 *            `ownRows`, as a kernel decoding its disk holds; timing pages
 *            hand it the fixture's objects, so only this driver sees it)
 *   engine   the kernel replica and the client runtime booted and installed
 *            (THE SYNC ENGINE'S OWN COPY: its indexes, its row maps, the
 *            runtime's store)
 *   arm      the arm built and settled over that engine (THE PROTOTYPE'S
 *            STRUCTURES: its tables, indexes and derived state, its feed
 *            subscription and its drawn list)
 *
 * A layer is what its stage added: the heap delta, and the snapshot's
 * objects created since the previous stage's snapshot (heap object ids only
 * grow), summed by constructor (`heap-snapshot.ts`). Objects a stage shares
 * with an earlier one (the arm holding the kernel's row by reference) belong
 * to the earlier one; only what the stage allocated and still holds is its.
 *
 * The pages must be the UNMINIFIED build, so a class is named as in source:
 *   PROTO_LAYERS=1 bun scripts/test-heavy.ts -- bunx vite build --config tests/worklist/harness/web/vite.config.ts
 * Heap is not timing: this runs on any machine, never under the bench lease.
 *
 *   bun scripts/test-heavy.ts -- bun --conditions=@podium/source tests/worklist/harness/browser/layers.ts \
 *     --arms noop,hand,mobx --cells h1a1,h10a1,h1a4 --out tests/worklist/harness/browser/results/layers.json
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { hostname, loadavg } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { type CDPSession, chromium, type Page } from '@playwright/test'
import { cellLabel, parseCell } from '../src/fixture/index'
import { type ConstructorTotal, HeapSnapshotReader } from './heap-snapshot'
import { CAPTURE_ARMS } from './records'

export const STAGES = ['script', 'fixture', 'cache', 'engine', 'arm'] as const
export type Stage = (typeof STAGES)[number]

/** A boot stage at history x10 builds 27k issues and boots the kernel over them. */
const STAGE_TIMEOUT_MS = 180_000

/** How many constructors each layer lists. */
const TOP = 12

export interface LayerStage {
  stage: Stage
  /** Forced-GC V8 heap at the stage (bytes). */
  usedSize: number
  /** usedSize minus the previous stage's: what the stage added. */
  addedBytes: number
  /** The snapshot's objects new since the previous stage's snapshot. */
  newObjects: number
  newSelfSize: number
  byConstructor: ConstructorTotal[]
}

export interface LayerRun {
  arm: string
  cell: string
  counts: { issues: number; sessions: number; rows: number }
  stages: LayerStage[]
}

export interface LayerOutput {
  runtimeSha: string
  host: string
  browser: string
  capturedAt: string
  load: number[]
  runs: LayerRun[]
}

const mb = (bytes: number): string => (bytes / 1e6).toFixed(1)

/**
 * The layer tables for a results document: per cell, what each stage added
 * for each arm (heap delta; the snapshot's new objects beside it), then each
 * arm's own layer and the sync engine's by constructor.
 */
export function renderLayers(output: LayerOutput): string[] {
  const lines: string[] = [
    `runtimeSha ${output.runtimeSha}; ${output.host}; Chromium ${output.browser}; load ${output.load.map((l) => l.toFixed(2)).join(', ')}`,
  ]
  const cells = [...new Set(output.runs.map((r) => r.cell))]
  const arms = [...new Set(output.runs.map((r) => r.arm))]
  const layerName: Record<Stage, string> = {
    script: 'page floor (bundle)',
    fixture: 'fixture (harness rows)',
    cache: 'sync engine: its rows (durable cache)',
    engine: 'sync engine: replica indexes + runtime',
    arm: 'prototype (the arm)',
  }
  for (const cell of cells) {
    const runs = arms.flatMap((arm) => output.runs.filter((r) => r.arm === arm && r.cell === cell))
    const first = runs[0]
    if (first === undefined) continue
    lines.push(
      '',
      `**${cell}** — ${first.counts.issues.toLocaleString('en-US')} issues, ${first.counts.sessions.toLocaleString('en-US')} sessions, ${first.counts.rows.toLocaleString('en-US')} visible rows`,
      '',
      `| Layer | ${runs.map((r) => `${r.arm} MB added (new objects MB)`).join(' | ')} |`,
      `|---|${runs.map(() => '---').join('|')}|`,
    )
    for (const stage of STAGES)
      lines.push(
        `| ${layerName[stage]} | ${runs
          .map((r) => {
            const s = r.stages.find((x) => x.stage === stage)
            return s === undefined ? '—' : `${mb(s.addedBytes)} (${mb(s.newSelfSize)})`
          })
          .join(' | ')} |`,
      )
    for (const run of runs)
      for (const stage of ['engine', 'arm'] as const) {
        const s = run.stages.find((x) => x.stage === stage)
        if (s === undefined || (stage === 'engine' && run !== first)) continue
        lines.push(
          '',
          `${cell} ${stage === 'engine' ? 'sync engine' : `${run.arm} arm`}, by constructor (new objects, self size): ` +
            s.byConstructor
              .slice(0, 8)
              .map((c) => `${c.name} ${c.count.toLocaleString('en-US')} / ${mb(c.selfSize)} MB`)
              .join('; '),
        )
      }
  }
  return lines
}

function arg(argv: string[], flag: string, fallback: string): string {
  const index = argv.indexOf(flag)
  return index >= 0 && index + 1 < argv.length ? (argv[index + 1] as string) : fallback
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
}

function serve(dir: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    let file = join(dir, url.pathname.slice(1))
    if (!existsSync(file) && file.endsWith('.html'))
      file = join(dir, 'entries', url.pathname.split('/').pop() as string)
    try {
      const body = readFileSync(file)
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

async function heapUsed(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage')
  const usage = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }
  return usage.usedSize
}

async function snapshot(cdp: CDPSession, newSince: number) {
  const reader = new HeapSnapshotReader({ newSince })
  const onChunk = ({ chunk }: { chunk: string }): void => reader.push(chunk)
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
  try {
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  } finally {
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
  }
  return reader.finish()
}

async function waitStage(page: Page, name: string): Promise<void> {
  await page.waitForFunction((want) => window.__stage?.name === want, name, {
    timeout: STAGE_TIMEOUT_MS,
  })
}

async function measureLayers(page: Page, cdp: CDPSession, arm: string, cell: string) {
  const stages: LayerStage[] = []
  let previousUsed = 0
  let previousMaxId = 0
  const take = async (stage: Stage): Promise<void> => {
    const used = await heapUsed(cdp)
    const summary = await snapshot(cdp, previousMaxId)
    stages.push({
      stage,
      usedSize: used,
      addedBytes: stage === 'script' ? used : used - previousUsed,
      newObjects: summary.newCount,
      newSelfSize: summary.newSelfSize,
      byConstructor: summary.byConstructor.slice(0, TOP),
    })
    previousUsed = used
    previousMaxId = summary.maxId
    console.log(
      `[layers] ${arm} ${cell} ${stage}: heap ${(used / 1e6).toFixed(1)} MB (+${((stage === 'script' ? used : stages.at(-1)!.addedBytes) / 1e6).toFixed(1)}), new objects ${summary.newCount} / ${(summary.newSelfSize / 1e6).toFixed(1)} MB; top ${summary.byConstructor
        .slice(0, 4)
        .map((c) => `${c.name} ${(c.selfSize / 1e6).toFixed(1)}`)
        .join(', ')}`,
    )
  }
  for (const stage of ['script', 'fixture', 'cache'] as const) {
    await waitStage(page, stage)
    await take(stage)
    await page.evaluate(() => window.__stage?.go())
  }
  await page.waitForFunction(
    () => window.__proto?.ready === true,
    {},
    {
      timeout: STAGE_TIMEOUT_MS,
    },
  )
  await take('engine')
  await page.evaluate(() => window.__proto.build())
  await take('arm')
  return stages
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  // `--render <layers.json>`: print the tables of an earlier run, no browser.
  const render = arg(argv, '--render', '')
  if (render !== '') {
    for (const line of renderLayers(JSON.parse(readFileSync(render, 'utf-8')) as LayerOutput))
      console.log(line)
    return 0
  }
  const arms = arg(argv, '--arms', 'noop,hand,mobx').split(',')
  for (const arm of arms)
    if (!(CAPTURE_ARMS as readonly string[]).includes(arm.split('+')[0] ?? ''))
      throw new Error(`unknown arm ${arm}`)
  const cells = arg(argv, '--cells', 'h1a1,h10a1,h1a4')
    .split(',')
    .map((c) => cellLabel(parseCell(c)))
  const out = arg(argv, '--out', 'tests/worklist/harness/browser/results/layers.json')
  const dist = arg(argv, '--serve', 'tests/worklist/harness/web/dist-layers')
  const port = Number(arg(argv, '--port', '8752'))
  if (!existsSync(join(dist, 'entries', 'noop.html')))
    throw new Error(`${dist}: no unminified pages (build with PROTO_LAYERS=1)`)
  const runtimeSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    encoding: 'utf-8',
  }).trim()
  const server = await serve(dist, port)
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const output: LayerOutput = {
    runtimeSha,
    host: hostname(),
    browser: browser.version(),
    capturedAt: new Date().toISOString(),
    load: [],
    runs: [],
  }
  try {
    for (const cell of cells)
      for (const arm of arms) {
        const [name, plant] = arm.split('+')
        // The growth matrix's cell viewport (`run.ts` CELL_VIEWPORT).
        const context = await browser.newContext({ viewport: { width: 1600, height: 7400 } })
        const page = await context.newPage()
        const errors: string[] = []
        page.on('pageerror', (error) => {
          errors.push(error.message)
          console.error(`[layers] ${arm} ${cell}: page error ${error.message}`)
        })
        const cdp = await context.newCDPSession(page)
        await cdp.send('HeapProfiler.enable')
        await page.goto(
          `http://127.0.0.1:${port}/${name}.html?cell=${cell}&hold=1&layers=1&sha=${runtimeSha}${plant ? `&plant=${encodeURIComponent(plant)}` : ''}`,
          { waitUntil: 'domcontentloaded' },
        )
        const stages = await measureLayers(page, cdp, arm, cell)
        const counts = await page.evaluate(() => window.__proto.corpus)
        output.load.push(loadavg()[0] ?? 0)
        if (errors.length > 0) throw new Error(`${arm} ${cell}: page error ${errors[0]}`)
        output.runs.push({
          arm,
          cell,
          counts: { issues: counts.issues, sessions: counts.sessions, rows: counts.rows },
          stages,
        })
        await context.close()
      }
  } finally {
    await browser.close()
    server.close()
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(output, null, 2))
  console.log(`[layers] wrote ${out}`)
  for (const line of renderLayers(output)) console.log(line)
  return 0
}

if (import.meta.main) process.exitCode = await main()
