/** Independent minified builds, interleaved on one leased flatblock host. */
import { spawn, execFileSync } from 'node:child_process'
import { cp, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname, cpus, loadavg, freemem } from 'node:os'
import { extname, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import type { installStreamDriver } from '../test/conversation-stream-driver'

if (hostname() !== 'flatblock') throw new Error('Conversation A/B runs on flatblock only.')
const args = new Set(process.argv.slice(2))
for (const arg of args) if (!['--build-only', '--capture-only', '--lease-held'].includes(arg)) throw new Error(`Unknown argument: ${arg}`)
const root = process.cwd()
const bun = resolve(root, '.toolchain/bun')
if (process.execPath !== bun) throw new Error(`Use the checkout toolchain: ${bun}`)
if (process.env.TMPDIR !== resolve(root, '.tmp')) throw new Error('Use the issue checkout .tmp as TMPDIR')
const legacySha = 'a11ccc804aaf848ebc3b498b48d997d14493d130'
const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const output = resolve('.artifacts/conversation-stream')
const legacyRoot = resolve(output, 'legacy')
const fixtures = [
  'apps/web/vite.conversation-stream.config.ts', 'apps/web/vite.sidebar-pool-perf.config.ts',
  'apps/web/harness/conversation-render-meter.ts',
  'apps/web/test/conversation-stream-driver.ts', 'apps/web/test/header-fixture.ts', 'apps/web/test/sidebar-fixture.ts',
  'apps/web/test/conversation-stream.browser.tsx', 'apps/web/test/conversation-stream.browser.html',
  'apps/mobile/vite.conversation-stream.config.ts', 'apps/mobile/vite.inbox.config.ts',
  'apps/mobile/test/conversation-stream.browser.tsx', 'apps/mobile/test/conversation-stream.browser.html',
  'apps/mobile/test/inbox-platform.tsx',
  'apps/mobile/test/conversation-stream-platform.tsx',
]
const percentile = (values: number[], q: number) => {
  const ordered = [...values].sort((a, b) => a - b)
  if (q === .5 && ordered.length) return (ordered[Math.floor((ordered.length - 1) / 2)]! + ordered[Math.ceil((ordered.length - 1) / 2)]!) / 2
  return ordered[Math.max(0, Math.ceil(ordered.length * q) - 1)] ?? 0
}
const command = (program: string, argv: string[], cwd = root) => new Promise<void>((done, reject) => {
  const child = spawn(program, argv, { cwd, stdio: ['ignore', 'inherit', 'inherit'] })
  console.log(`Started pid=${child.pid}: ${program} ${argv.join(' ')}`)
  child.once('error', reject)
  child.once('exit', code => code === 0 ? done() : reject(new Error(`${program} exited ${code}`)))
})
const host = () => ({ at: new Date().toISOString(), load: loadavg(), freeBytes: freemem(),
  cpu: cpus().reduce((total, cpu) => ({ idle: total.idle + cpu.times.idle,
    total: total.total + Object.values(cpu.times).reduce((sum, value) => sum + value, 0) }), { idle: 0, total: 0 }) })
type Stream = Awaited<ReturnType<ReturnType<typeof installStreamDriver>['run']>>
const reports: (Stream & Record<string, unknown>)[] = []
await mkdir(output, { recursive: true })
let created = false, leased = false
try {
  if (!args.has('--capture-only')) {
    await command('git', ['worktree', 'add', '--detach', legacyRoot, legacySha])
    created = true
    await cp(resolve('.toolchain'), resolve(legacyRoot, '.toolchain'), { recursive: true })
    await command(resolve(legacyRoot, '.toolchain/bun'), ['run', 'setup:worktree'], legacyRoot)
    for (const file of fixtures) {
      await mkdir(resolve(legacyRoot, file, '..'), { recursive: true })
      await copyFile(resolve(file), resolve(legacyRoot, file))
    }
    for (const surface of ['web', 'phone'])
      for (const [arm, cwd] of [['before', legacyRoot], ['after', root]] as const)
        await command(bun, ['apps/web/node_modules/vite/bin/vite.js', 'build', '--config',
          `apps/${surface === 'web' ? 'web' : 'mobile'}/vite.conversation-stream.config.ts`,
          '--outDir', resolve(output, `${surface}-${arm}-build`)], cwd)
    await writeFile(resolve(output, 'builds.json'), JSON.stringify({ legacySha, candidateSha, fixtures }, null, 2))
    await command('git', ['worktree', 'remove', '--force', legacyRoot])
    created = false
  }
  if (!args.has('--build-only')) {
    const manifest = JSON.parse(await readFile(resolve(output, 'builds.json'), 'utf8'))
    if (manifest.legacySha !== legacySha || manifest.candidateSha !== candidateSha) throw new Error('Saved builds belong to another revision')
    if (!args.has('--lease-held')) {
      await command('podium', ['lock', 'acquire', 'bench:flatblock', '--ttl', '20m', '--wait'])
      leased = true
    }
    for (const surface of ['web', 'phone'])
      for (const [index, arm] of ['before', 'after', 'before', 'after'].entries()) {
        const build = resolve(output, `${surface}-${arm}-build`)
        const server = createServer(async (request, response) => {
          try {
            const pathname = new URL(request.url!, 'http://fixture.invalid').pathname
            const file = resolve(build, `.${pathname}`)
            if (!file.startsWith(`${build}/`)) throw new Error('Invalid path')
            const content = await readFile(file)
            response.writeHead(200, {
              'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream',
              'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
            })
            response.end(content)
          } catch { response.writeHead(404); response.end() }
        })
        await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
        const address = server.address() as { port: number }
        const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
          env: { ...process.env, LD_LIBRARY_PATH: [resolve('.toolchain/lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } })
        const loads: ReturnType<typeof host>[] = []
        let timer: ReturnType<typeof setInterval> | undefined
        try {
          const page = await browser.newPage({ viewport: surface === 'web' ? { width: 1400, height: 900 } : { width: 390, height: 844 }, reducedMotion: 'reduce' })
          const errors: string[] = []
          page.on('pageerror', error => errors.push(error.message))
          await page.goto(`http://127.0.0.1:${address.port}/test/conversation-stream.browser.html`)
          try { await page.waitForFunction(() => window.__conversationStream?.ready(), null, { timeout: 60_000 }) }
          catch (error) {
            await page.screenshot({ path: resolve(output, `${surface}-${arm}-failed.png`) })
            throw new Error(`Fixture not ready: ${JSON.stringify({ errors, body: (await page.locator('body').innerText()).slice(-2000) })}; ${error}`)
          }
          await page.locator('textarea').focus()
          const cdp = await page.context().newCDPSession(page)
          const system = await browser.newBrowserCDPSession()
          await cdp.send('Performance.enable')
          await cdp.send('HeapProfiler.collectGarbage')
          const read = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]))
          const before = await read()
          const processesBefore = (await system.send('SystemInfo.getProcessInfo')).processInfo
          loads.push(host()); timer = setInterval(() => loads.push(host()), 1000)
          console.log(`SAMPLE ${surface} ${arm} ${index + 1}: start load=${JSON.stringify(loads[0])}`)
          const running = page.evaluate(() => window.__conversationStream.run())
          const typingStarted = Date.now()
          for (let key = 0; key < 112; key++) {
            await page.waitForTimeout(Math.max(0, typingStarted + (key + 1) * 250 - Date.now()))
            await page.keyboard.type('x')
          }
          const stream = await running
          const after = await read()
          const processesAfter = (await system.send('SystemInfo.getProcessInfo')).processInfo
          clearInterval(timer); timer = undefined; loads.push(host())
          const cpuByTypeMs: Record<string, number> = {}
          for (const process of processesAfter) {
            const previous = processesBefore.find(row => row.id === process.id)
            if (previous) cpuByTypeMs[process.type] = (cpuByTypeMs[process.type] ?? 0) + (process.cpuTime - previous.cpuTime) * 1000
          }
          await cdp.send('HeapProfiler.collectGarbage')
          const heapBytes = (await read()).JSHeapUsedSize!
          const taskMs = (after.TaskDuration! - before.TaskDuration!) * 1000
          const cpuMs = Object.values(cpuByTypeMs).reduce((sum, ms) => sum + ms, 0)
          const report = { surface, arm, sample: index + 1, sha: arm === 'before' ? legacySha : candidateSha,
            ...stream, taskMs, taskMsPerToken: taskMs / stream.sent,
            scriptMsPerToken: (after.ScriptDuration! - before.ScriptDuration!) * 1000 / stream.sent,
            layoutMsPerToken: (after.LayoutDuration! - before.LayoutDuration!) * 1000 / stream.sent,
            styleMsPerToken: (after.RecalcStyleDuration! - before.RecalcStyleDuration!) * 1000 / stream.sent,
            rowRendersPerToken: stream.work.row / stream.sent, frameRendersPerToken: stream.work.frame / stream.sent,
            cpuMs, cpuByTypeMs, cpuPercentOneCore: cpuMs / stream.elapsedMs * 100,
            heapBytes, loads, typingP50Ms: percentile(stream.typing.map(row => row.latencyMs), .5),
            typingP95Ms: percentile(stream.typing.map(row => row.latencyMs), .95),
            streamDomP95Ms: percentile(stream.latencies.map(row => row.domMs), .95),
            streamPaintProxyP95Ms: percentile(stream.latencies.map(row => row.latencyMs), .95),
            catchupDomP95Ms: percentile(stream.latencies.filter(row => row.atMs >= 9500 && row.atMs <= 15000).map(row => row.domMs), .95),
            errors: [...errors, ...stream.errors] }
          reports.push(report)
          await writeFile(resolve(output, 'captures.json'), JSON.stringify(reports, null, 2))
          await page.screenshot({ path: resolve(output, `${surface}-${arm}-${index + 1}.png`) })
          console.log(JSON.stringify({ ...report, latencies: undefined, typing: undefined, checkpoints: undefined, loads: [loads[0], loads.at(-1)] }))
          if (report.errors.length || stream.corpus.retained !== 2000 || stream.shown < stream.sent * .95 ||
            stream.sent < 285 || stream.typing.length !== 112 || stream.typing.some(row => !row.retained))
            throw new Error(`${surface} ${arm} sample did not retain/render the required corpus, tokens and typing`)
        } finally {
          if (timer) clearInterval(timer)
          await browser.close(); await new Promise<void>(done => server.close(() => done()))
        }
      }
    const metrics = ['typingP50Ms', 'typingP95Ms', 'taskMsPerToken', 'scriptMsPerToken', 'layoutMsPerToken',
      'styleMsPerToken', 'rowRendersPerToken', 'frameRendersPerToken', 'cpuMs', 'cpuPercentOneCore', 'heapBytes',
      'streamDomP95Ms', 'streamPaintProxyP95Ms', 'catchupDomP95Ms']
    const summary = Object.fromEntries(['web', 'phone'].map(surface => [surface, Object.fromEntries(metrics.map(metric => {
      const value = (arm: string) => percentile(reports.filter(row => row.surface === surface && row.arm === arm).map(row => row[metric] as number), .5)
      const before = value('before'), after = value('after')
      return [metric, { before, after, ratio: before ? after / before : null }]
    }))]))
    const report = { legacySha, candidateSha, host: hostname(), cpu: cpus()[0]?.model, cpuCount: cpus().length,
      order: ['before', 'after', 'before', 'after'], durationMs: 30_000, messages: 2000,
      methodology: { phone: 'React Native Web in Chromium, not native device CPU', typing: 'Trusted browser keydown timestamp to controlled value retained across two animation frames; 112 keys at 250ms pacing',
        stream: '10 cumulative Markdown tokens/sec; 2000-item catch-up at 10 sec; DOM latency plus a two-frame paint proxy',
        render: 'Vite-only counters at actual list, row, composer and shell function entry; no product source edits',
        cpu: 'Chromium process CPU deltas including renderer/worker/browser; CDP main-thread task/script/layout/style separately',
        taskPerToken: 'Total main-thread work divided by emitted tokens, including typing and catch-up',
        samples: 'Two independent browser samples per arm; arithmetic midpoint median with two values; raw values and load retained' },
      summary, reports }
    await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ summary }, null, 2))
  }
} finally {
  if (leased) await command('podium', ['lock', 'release', 'bench:flatblock'])
  if (created) await command('git', ['worktree', 'remove', '--force', legacyRoot])
}
