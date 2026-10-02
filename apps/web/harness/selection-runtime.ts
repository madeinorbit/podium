/** Focused continuation of POD-4959's ordinary-production browser fixture.
 * --phase=build, then --phase=timing|attribution --tag=before|after.
 * Timed runs require the caller's bench:flatblock lease. No live server/RPC. */
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname, loadavg, uptime } from 'node:os'
import { extname, resolve } from 'node:path'
import { chromium, type CDPSession } from '@playwright/test'
import { paintOf, traceStart } from './browser-paint'
import plan from './sidebar-acceptance-plan.json'
import type {} from '../test/sidebar-acceptance.browser'

const arg = (name: string, fallback: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const phase = arg('phase', 'timing')
const tag = arg('tag', 'before')
const samples = Number(arg('samples', phase === 'attribution' ? '6' : String(plan.samples)))
const root = resolve('.artifacts/selection-runtime', tag)
const build = resolve('.artifacts/sidebar-acceptance/build')
if (hostname() !== 'flatblock') throw new Error('Capture runs on flatblock')
await mkdir(root, { recursive: true })

if (phase === 'build') {
  const { build: viteBuild } = await import('../node_modules/vite/dist/node/index.js')
  await viteBuild({ configFile: resolve('apps/web/harness/sidebar-acceptance.vite.ts'), plugins: [{
    name: 'selection-runtime-boundaries', enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/test/sidebar-acceptance.browser.tsx')) return
      const needle = "patchBoundary(runtime, 'batch', 'runtime batch')"
      if (!code.includes(needle)) throw new Error('Missing runtime measurement attachment')
      return { code: code.replace(needle, `${needle}
        const seam = runtime as any
        for (const [object, prefix, methods] of [
          [seam, 'runtime', ['react', 'buildSnapshot', 'readSessionViews']],
          [seam.subStore, 'store', ['publish']],
          [seam.optimism, 'optimism', ['recomputeSessions', 'recomputeIssues', 'recomputeIssueProjections', 'recomputeIssueUserStates', 'paintSessions', 'pendingByRow']],
          [seam.reactions, 'reaction', ['worktreeFollow', 'sessionIssueFollow', 'worktreeFallback', 'pruneWorkspaces', 'reportViewState', 'updateMarkReadTimer', 'updateIssueVisitBaseline', 'updateIssueMarkReadTimer']],
        ] as const) for (const method of methods) patchBoundary(object, method, 'shared:' + prefix + '.' + method)
      `), map: null }
    },
  }] })
  process.exit(0)
}
if (!['timing', 'attribution', 'guard'].includes(phase)) throw new Error('Unknown capture phase')
if (phase !== 'guard' && !process.argv.includes('--lease-confirmed')) throw new Error('Capture needs bench:flatblock')
const sha = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim()
const server = createServer(async (req, res) => {
  try {
    const path = resolve(build, '.' + new URL(req.url!, 'http://localhost').pathname)
    if (!path.startsWith(build + '/')) { res.writeHead(403); res.end(); return }
    const bytes = await readFile(path)
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream')
    res.end(bytes)
  } catch { res.writeHead(404); res.end() }
})
await new Promise<void>(done => server.listen(41659, '127.0.0.1', done))
const browser = await chromium.launch({ headless: true,
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  env: { ...process.env, LD_LIBRARY_PATH: resolve('.toolchain/lib') },
  args: ['--no-sandbox', '--disable-dev-shm-usage'] })

try {
  await writeFile(resolve(root, 'provenance.json'), JSON.stringify({ sha, tag, phase, samples, plan,
    browser: browser.version(), host: hostname(), pid: process.pid, ordinaryProduction: true,
    scope: 'Sidebar selection and shared state events; no full main-pane switch, startup or memory verdict.' }, null, 2))
  for (const scale of arg('scales', '1x,4x').split(',')) {
    if (!['1x', '4x'].includes(scale)) throw new Error('Unknown scale')
    const pages = {} as Record<'legacy' | 'pool', { page: Awaited<ReturnType<typeof browser.newPage>>; cdp: CDPSession; close(): Promise<void> }>
    for (const mode of ['legacy', 'pool'] as const) {
      const context = await browser.newContext({ viewport: { width: 1800, height: 1000 }, reducedMotion: 'reduce' })
      const page = await context.newPage()
      page.setDefaultTimeout(30_000); page.setDefaultNavigationTimeout(120_000)
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.addInitScript(() => {
        const began = performance.now()
        Date.now = () => Date.parse('2026-09-20T12:00:00Z') + Math.floor(performance.now() - began)
        const capture = { running: false, target: '', input: null as number | null, selected: null as number | null, twoRaf: false }
        document.addEventListener('click', event => {
          if (!capture.running || !(event.target as Element)?.closest('[data-issue-row]')) return
          if (!event.isTrusted) throw new Error('Untrusted selection')
          capture.input = event.timeStamp
          performance.mark('acceptance:input', { startTime: event.timeStamp })
          requestAnimationFrame(() => requestAnimationFrame(() => { capture.twoRaf = true }))
        }, true)
        new MutationObserver(() => {
          if (!capture.running || capture.input === null || capture.selected !== null) return
          if (document.querySelector(`[data-issue-row="${capture.target}"][data-selected="true"]`)) {
            capture.selected = performance.now(); performance.mark('acceptance:selected-dom')
          }
        }).observe(document, { childList: true, subtree: true, attributes: true })
        Object.assign(window, { __selectionCapture: capture })
      })
      await page.goto(`http://127.0.0.1:41659/test/sidebar-acceptance.browser.html?mobxSidebar=${mode === 'pool' ? 1 : 0}&scale=${scale === '4x' ? 4 : 1}&surface=sidebar&measure=1&perfPanel=1&panelMode=chat`)
      await page.waitForFunction(() => window.__acceptance?.ready() && document.querySelector('[data-issue-row]'))
      await page.evaluate(() => document.fonts.ready)
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      const state = await page.evaluate(() => ({ mode: window.__acceptance.mode(), pool: window.__acceptance.state().pool, errors: window.__acceptance.errors() }))
      if (state.mode !== mode || state.pool !== (mode === 'pool')) throw new Error(`Mode guard RED: requested ${mode}, actual ${JSON.stringify(state)}`)
      if (errors.length || state.errors.length) throw new Error(`Fixture errors: ${[...errors, ...state.errors].join('; ')}`)
      pages[mode] = { page, cdp: await context.newCDPSession(page), close: () => context.close() }
    }
    if (phase === 'guard') { console.log('Both startup mode guards green'); break }
    const rowIds = await pages.legacy.page.locator('[data-issue-row]').evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute('data-issue-row')!))])
    const shapes = await pages.legacy.page.evaluate(ids => window.__acceptance.shape(ids), rowIds)
    const ranked = shapes.filter(shape => shape.rows > 0).sort((a, b) => b.rows - a.rows)
    const canonical = await pages.legacy.page.evaluate(() => window.__acceptance.targets)
    const proposed = [ranked[0]!.id, ranked[1]!.id, canonical.markReadId, canonical.stageMoveId, canonical.archiveId, canonical.evictId]
    const targets = [...new Set(proposed.filter(id => rowIds.includes(id)))]
    for (const shape of [...ranked].reverse()) {
      if (targets.length === 6) break
      if (!targets.includes(shape.id)) targets.push(shape.id)
    }
    if (targets.length !== 6 || targets.some(id => !rowIds.includes(id))) throw new Error('Need six distinct mounted targets')
    await writeFile(resolve(root, `targets-${scale}.json`), JSON.stringify(targets))
    for (const kind of arg('events', 'click,unrelated,title,phase,draft').split(',')) {
      for (let i = 0; i < samples + plan.warmups; i++) for (const mode of (i % 2 ? ['pool', 'legacy'] : ['legacy', 'pool']) as ('legacy' | 'pool')[]) {
        const { page, cdp } = pages[mode]
        if (loadavg()[0]! > plan.maxLoad) throw new Error('Host load too high; retain existing records and rerun separately')
        await page.bringToFront()
        const target = targets[i % targets.length]!
        const row = page.locator(`[data-issue-row="${target}"]`).first()
        if (kind === 'click') { await row.scrollIntoViewIfNeeded(); await row.hover(); await page.waitForTimeout(40) }
        await page.evaluate(target => {
          window.__acceptance.begin(); performance.clearMarks()
          Object.assign((window as any).__selectionCapture, { running: true, target, input: null, selected: null, twoRaf: false })
        }, target)
        const stopTrace = kind === 'click' ? await traceStart(cdp) : null
        if (phase === 'attribution') { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 1000 }); await cdp.send('Profiler.start') }
        if (kind === 'click') {
          await row.click()
          await page.waitForFunction(() => { const c = (window as any).__selectionCapture; return c.twoRaf && c.selected !== null })
        } else await page.evaluate(({ kind, i }) => window.__acceptance.event(kind, i + 100), { kind, i })
        await page.waitForTimeout(80)
        await page.evaluate(() => window.__acceptance.settled())
        const result = await page.evaluate(() => {
          ;(window as any).__selectionCapture.running = false
          return { measurement: window.__acceptance.stop(), state: window.__acceptance.state(), errors: window.__acceptance.errors() }
        })
        if (result.errors.length) throw new Error(`Fixture errors: ${result.errors.join('; ')}`)
        if (kind === 'click' && result.state.selected !== target) throw new Error('Click selected wrong target')
        const profile = phase === 'attribution' ? (await cdp.send('Profiler.stop')).profile : null
        const trace = stopTrace ? await stopTrace() : null
        const paint = trace ? paintOf(trace) : null
        if (i < plan.warmups) continue
        const file = `${scale}-${mode}-${kind}-${i - plan.warmups}`
        if (profile) await writeFile(resolve(root, file + '.cpuprofile'), JSON.stringify(profile))
        if (trace) await writeFile(resolve(root, file + '.trace.json'), JSON.stringify({ traceEvents: trace }))
        await appendFile(resolve(root, 'records.jsonl'), JSON.stringify({ sha, phase, tag, scale, mode, kind, iteration: i - plan.warmups,
          target: kind === 'click' ? target : null, paint, result, loadavg: loadavg(), uptime: uptime(), profile: profile ? file + '.cpuprofile' : null }) + '\n')
      }
      console.log(`${tag} ${scale} ${kind}: ${samples} paired observations retained`)
    }
    await pages.legacy.close(); await pages.pool.close()
  }
} finally {
  await browser.close()
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
}
