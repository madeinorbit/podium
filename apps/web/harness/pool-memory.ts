/** POD-5133 heap-ownership capture (measurement only, synthetic corpus).
 *
 *   --phase=build                      build the fixture once; both arms use it
 *   --phase=capture --lease-confirmed  per cell and arm: heap usage after GC in
 *                                      --samples fresh contexts (POD-4959's
 *                                      retained statistic), then one gzip heap
 *                                      snapshot with named owner handles
 *   --phase=analyze                    heap-owners.ts over every snapshot
 *
 * Captures run on flatblock under the caller's bench:flatblock lease; a
 * `--dev-local` run on another host is marked and never reported. */
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname, loadavg, uptime } from 'node:os'
import { extname, resolve } from 'node:path'
import { createGzip } from 'node:zlib'
import { type CDPSession, chromium, type Page } from '@playwright/test'
import type {} from '../test/pool-memory.browser'
import { analyze, type Cut, type Meta, readSnapshot } from './heap-owners'

const arg = (name: string, fallback: string) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=') ?? fallback
const phase = arg('phase', 'capture')
const cells = arg('cells', '1x,4x,h10a1').split(',')
const arms = arg('arms', 'legacy,pool').split(',') as ('legacy' | 'pool')[]
const samples = Number(arg('samples', '5'))
const devLocal = process.argv.includes('--dev-local')
const base = resolve(process.cwd(), '.artifacts/pool-memory')
const build = resolve(base, 'build')
const out = resolve(base, arg('out', 'capture'))
const port = 41671
const url = `http://127.0.0.1:${port}/test/pool-memory.browser.html`

if (phase === 'build') {
  const child = Bun.spawn(
    [
      'timeout',
      '240s',
      process.execPath,
      resolve('apps/web/node_modules/vite/bin/vite.js'),
      'build',
      '--config',
      resolve('apps/web/harness/pool-memory.vite.ts'),
    ],
    { stdout: 'ignore', stderr: 'inherit' },
  )
  console.log(`Fixture build PID ${child.pid}`)
  if ((await child.exited) !== 0) throw new Error('Fixture build failed')
  process.exit(0)
}

/** Removal counterfactuals (heap-owners.ts `Cut`); each is measured alone. */
const POOL_MACHINERY: Cut = {
  handles: ['pool', 'pool.*'],
  mobx: true,
  scripts: '^(runtime-pool|rollup)-',
}
// The legacy store's own per-row objects: issue view models, the published
// sorted-issue and issue-view entries, plus its handles, view-model cache and
// mission index. Rows the kernel replica holds stay.
const LEGACY_STORE: Cut = {
  handles: ['snapshot', 'snapshot.*', 'runtime.state', 'runtime.subStore', 'runtime.base*'],
  weakValuesOf: ['replica'],
  contextVars: ['lastMissionIndexIssues', 'lastMissionIndex'],
  props: [
    ['displayRef', 'sessionSummary', 'memberSessionIds'],
    ['displayRef', 'memberSessionIds', '!title'],
    ['prefix', 'parentId', 'stage', '!title'],
  ],
}
const TEMPORARY_JOIN: Cut = {
  props: [['sessionFacts', 'humanQuestionAskedBy', 'repoPath', 'readAt']],
}
// POD-4949: the old issue record (wire row with derived counts) leaves the replica.
const OLD_ISSUE_RECORD: Cut = {
  props: [['childDoneCount', 'unread', 'sessionSummary', '!displayRef']],
}
const union = (...cuts: Cut[]): Cut => ({
  handles: cuts.flatMap((c) => c.handles ?? []),
  mobx: cuts.some((c) => c.mobx),
  ...(cuts.some((c) => c.scripts)
    ? { scripts: cuts.flatMap((c) => (c.scripts ? [c.scripts] : [])).join('|') }
    : {}),
  ...(cuts.some((c) => c.sites)
    ? { sites: cuts.flatMap((c) => (c.sites ? [c.sites] : [])).join('|') }
    : {}),
  props: cuts.flatMap((c) => c.props ?? []),
  weakValuesOf: cuts.flatMap((c) => c.weakValuesOf ?? []),
  contextVars: cuts.flatMap((c) => c.contextVars ?? []),
})
export const GROUPS: Record<string, Cut> = {
  'pool: all machinery': POOL_MACHINERY,
  'pool: per-row model computeds (cached.ts)': {
    sites: '^ComputedValue (IssueModel|SessionModel|WorktreeModel|RepoModel)@',
  },
  'pool: boxed map entries (ObservableMap values)': {
    sites: '^ObservableValue ObservableMap\\.key($| )',
  },
  'pool: tracked has() entries (ObservableMap hasMap_)': {
    sites: '^ObservableValue ObservableMap\\.key\\?',
  },
  'pool: per-issue file reactions (visible.ts)': { sites: '^Reaction pool\\.file\\.' },
  'pool: relation engine and buckets': {
    handles: ['pool.relations'],
    sites: '^(ObservableSet|Atom|ObservableMap|ObservableValue) pool\\.[^ ]*bucket',
  },
  'pool: residency': { handles: ['pool.residency'] },
  'pool: sidebar indexes and groups': {
    handles: ['pool.sidebarRosters', 'pool.groups', 'pool.worklist', 'pool.sidebar'],
  },
  'pool: read-state lane': { handles: ['pool.readStates'] },
  'pool: MobX debug names': { sites: '^\\(MobX debug names\\)$' },
  'legacy store (published snapshot, engine state and base arrays, view-model cache)': LEGACY_STORE,
  'temporary old-record join (temporary-issue-input.ts)': TEMPORARY_JOIN,
  'kernel replica and its cache': {
    handles: ['replica', 'replica.*', 'cache', 'cache.*', 'runtime.replica'],
  },
  'old issue record (POD-4949 retires it)': OLD_ISSUE_RECORD,
  'end state A: legacy store removed': LEGACY_STORE,
  'end state B: legacy store, temporary join and old issue record removed (POD-4949)': union(
    LEGACY_STORE,
    TEMPORARY_JOIN,
    OLD_ISSUE_RECORD,
  ),
}

if (phase === 'analyze') {
  const groups = existsSync(resolve(out, 'groups.json'))
    ? JSON.parse(await readFile(resolve(out, 'groups.json'), 'utf8'))
    : GROUPS
  const only = arg('only', '')
  for (const file of (await readdir(out))
    .filter((f) => f.endsWith('.heapsnapshot.gz') && (!only || f.startsWith(only)))
    .sort()) {
    const stem = file.replace('.heapsnapshot.gz', '')
    if (
      process.argv.includes('--only-missing') &&
      existsSync(resolve(out, `${stem}.analysis.json`))
    )
      continue
    const began = performance.now()
    const meta = JSON.parse(await readFile(resolve(out, `${stem}.meta.json`), 'utf8')) as Meta
    const result = analyze(await readSnapshot(resolve(out, file)), { ...meta, groups })
    await writeFile(
      resolve(out, `${stem}.analysis.json`),
      JSON.stringify(
        { stem, cell: meta.cell, arm: meta.arm, heap: meta.heap, rows: meta.rows, ...result },
        null,
        2,
      ),
    )
    console.log(
      `${stem}: live ${result.totals.liveMiB} MiB, ${result.owners.resolved} owners, missing ${result.owners.missing.length}; ${((performance.now() - began) / 1000).toFixed(0)} s`,
    )
  }
  process.exit(0)
}

if (phase !== 'capture') throw new Error(`Unknown phase ${phase}`)
if (!devLocal && hostname() !== 'flatblock')
  throw new Error(`Capture runs on flatblock, got ${hostname()}`)
if (!devLocal && !process.argv.includes('--lease-confirmed'))
  throw new Error('Capture needs the bench:flatblock lease and --lease-confirmed')
await mkdir(out, { recursive: true })
// A deployed bundle (no checkout on the capture host) names the built tree's SHA.
const runtimeSha =
  arg('sha', '') ||
  execFileSync('git', ['rev-parse', 'HEAD'], { timeout: 10_000 }).toString().trim()
const runner = () => ({ host: hostname(), loadavg: loadavg(), uptimeSeconds: uptime() })

const server = createServer(async (req, res) => {
  try {
    const path = resolve(
      build,
      `.${decodeURIComponent(new URL(req.url!, 'http://localhost').pathname)}`,
    )
    if (!path.startsWith(`${build}/`)) {
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
          '.woff2': 'font/woff2',
          '.json': 'application/json',
        } as Record<string, string>
      )[extname(path)] ?? 'application/octet-stream',
    )
    res.end(await readFile(path))
  } catch {
    res.writeHead(404)
    res.end()
  }
})
await new Promise<void>((done) => server.listen(port, '127.0.0.1', done))
const flatblockChrome = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(flatblockChrome) ? { executablePath: flatblockChrome } : {}),
  env: { ...process.env, LD_LIBRARY_PATH: resolve('.toolchain/lib') },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-precise-memory-info'],
})
await writeFile(
  resolve(out, 'provenance.json'),
  JSON.stringify(
    {
      runtimeSha,
      arguments: process.argv.slice(2),
      pid: process.pid,
      browser: browser.version(),
      runner: runner(),
      devLocal,
      synthetic: true,
      seed: 4443,
    },
    null,
    2,
  ),
)

async function open(arm: 'legacy' | 'pool', cell: string) {
  const context = await browser.newContext({
    viewport: { width: 1800, height: 1000 },
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  page.setDefaultNavigationTimeout(180_000)
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  // POD-4959's clock anchor, so time-derived fields match its memory cells.
  await page.addInitScript(() => {
    const began = performance.now()
    Date.now = () => Date.parse('2026-09-20T12:00:00Z') + Math.floor(performance.now() - began)
  })
  const began = performance.now()
  const query = `?mobxSidebar=${arm === 'pool' ? 1 : 0}&scale=${cell === '4x' ? 4 : 1}${cell === 'h10a1' ? '&cell=h10a1' : ''}`
  await page.goto(url + query, { waitUntil: 'load' })
  await page.waitForFunction(
    () => window.__memory?.ready() && document.querySelector('[data-issue-row]') !== null,
  )
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  )
  const startupMs = performance.now() - began
  const mode = await page.evaluate(() => window.__memory.mode())
  const expected = process.argv.includes('--plant-mode')
    ? arm === 'pool'
      ? 'legacy'
      : 'pool'
    : arm
  if (mode !== expected) throw new Error(`Mode guard RED: expected ${expected}, got ${mode}`)
  const errors = [...failures, ...(await page.evaluate(() => window.__memory.errors()))]
  if (errors.length) throw new Error(`Fixture errors: ${errors.join('; ')}`)
  const cdp = await context.newCDPSession(page)
  return { page, cdp, startupMs, close: () => context.close() }
}
async function gc(page: Page, cdp: CDPSession) {
  await cdp.send('HeapProfiler.collectGarbage')
  await page.waitForTimeout(150)
  await cdp.send('HeapProfiler.collectGarbage')
  return cdp.send('Runtime.getHeapUsage')
}
async function snapshot(cdp: CDPSession, path: string) {
  const gzip = createGzip({ level: 6 })
  const file = createWriteStream(path)
  gzip.pipe(file)
  const receive = ({ chunk }: { chunk: string }) => {
    gzip.write(chunk)
  }
  cdp.on('HeapProfiler.addHeapSnapshotChunk', receive)
  await cdp.send('HeapProfiler.takeHeapSnapshot', {
    reportProgress: false,
    captureNumericValue: false,
  })
  cdp.off('HeapProfiler.addHeapSnapshotChunk', receive)
  await new Promise<void>((done, fail) => {
    file.on('finish', done)
    file.on('error', fail)
    gzip.end()
  })
}
const order = (i: number) => (i % 2 === 0 ? arms : [...arms].reverse())

try {
  for (const cell of cells) {
    for (let i = 0; i < samples; i++)
      for (const arm of order(i)) {
        const opened = await open(arm, cell)
        await opened.page.waitForTimeout(500)
        const heap = await gc(opened.page, opened.cdp)
        const state = await opened.page.evaluate(() => window.__memory.state())
        const record = {
          kind: 'usage',
          cell,
          arm,
          iteration: i,
          startupMs: opened.startupMs,
          heap,
          state,
          runtimeSha,
          runner: runner(),
          devLocal,
        }
        await appendFile(resolve(out, 'records.jsonl'), `${JSON.stringify(record)}\n`)
        console.log(
          `${cell} ${arm} ${i}: ${(heap.usedSize / 1048576).toFixed(1)} MiB V8 used after GC`,
        )
        if (i === samples - 1) {
          // The last fresh context of each arm also yields the snapshot.
          const ids = await opened.page.evaluate(() => window.__memory.ids())
          await opened.page.evaluate(() => window.__memory.releaseFixtureInputs())
          const heapAfterRelease = await gc(opened.page, opened.cdp)
          await opened.page.evaluate(() => window.__memory.holdOwners())
          const stem = `${cell}-${arm}`
          await snapshot(opened.cdp, resolve(out, `${stem}.heapsnapshot.gz`))
          await opened.page.evaluate(() => window.__memory.dropOwners())
          await writeFile(
            resolve(out, `${stem}.meta.json`),
            JSON.stringify({
              cell,
              arm,
              runtimeSha,
              heap,
              heapAfterRelease,
              rows: state.rows,
              issues: state.issues,
              sessions: state.sessions,
              ids,
              runner: runner(),
              devLocal,
            } satisfies Meta & Record<string, unknown>),
          )
          console.log(
            `${stem}: snapshot taken; ${(heapAfterRelease.usedSize / 1048576).toFixed(1)} MiB after releasing fixture inputs`,
          )
        }
        await opened.close()
      }
  }
} finally {
  await browser.close()
  await new Promise<void>((done) => server.close(() => done()))
}
