/** Two independent minified production builds; timed execution is flatblock-only. */
import { spawn, execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname, cpus, loadavg } from 'node:os'
import { extname, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import type {} from '../test/conversation-stream.browser'

if (hostname() !== 'flatblock') throw new Error('Conversation A/B runs on flatblock only.')
const legacySha = 'a11ccc804aaf848ebc3b498b48d997d14493d130'
const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const output = resolve('.artifacts/conversation-stream')
const legacyRoot = resolve(output, 'legacy')
const config = 'apps/web/vite.conversation-stream.config.ts'
const fixtureFiles = [config, 'apps/web/test/conversation-stream.browser.tsx', 'apps/web/test/conversation-stream.browser.html']
const percentile = (values: number[], q: number) => {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.max(0, Math.ceil(ordered.length * q) - 1)] ?? 0
}
const command = (program: string, args: string[], cwd = process.cwd()) => new Promise<void>((done, reject) => {
  const child = spawn(program, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? done() : reject(new Error(`${program} ${args.join(' ')} exited ${code}`)))
})
await mkdir(output, { recursive: true })
let created = false, leased = false
const reports: Record<string, unknown> = {}
try {
  await command('git', ['worktree', 'add', '--detach', legacyRoot, legacySha])
  created = true
  await command('bun', ['run', 'setup:worktree'], legacyRoot)
  for (const path of fixtureFiles) await copyFile(resolve(path), resolve(legacyRoot, path))
  for (const [arm, cwd] of [['legacy', legacyRoot], ['mobx', process.cwd()]] as const)
    await command('bun', ['apps/web/node_modules/vite/bin/vite.js', 'build', '--config', config, '--outDir', resolve(output, `${arm}-build`)], cwd)
  await command('podium', ['lock', 'acquire', 'bench:flatblock', '--ttl', '10m', '--wait'])
  leased = true
  for (const arm of ['legacy', 'mobx']) {
    const build = resolve(output, `${arm}-build`)
    const server = createServer(async (request, response) => {
      try {
        const pathname = new URL(request.url!, 'http://fixture.invalid').pathname
        const file = resolve(build, `.${pathname}`)
        if (!file.startsWith(`${build}/`)) throw new Error('Invalid path')
        response.writeHead(200, {
          'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream',
          'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
        })
        response.end(await readFile(file))
      } catch { response.writeHead(404); response.end() }
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address() as { port: number }
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-blink-features=MeasureMemory'] })
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' })
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`http://127.0.0.1:${address.port}/test/conversation-stream.browser.html`)
      await page.waitForFunction(() => window.__conversationStream?.ready(), null, { timeout: 60_000 })
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Performance.enable')
      await cdp.send('HeapProfiler.collectGarbage')
      const read = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]))
      const before = await read()
      const stream = await page.evaluate(() => window.__conversationStream.run())
      const after = await read()
      await cdp.send('HeapProfiler.collectGarbage')
      const heap = (await read()).JSHeapUsedSize!
      const memoryBytes = await page.evaluate(async () => {
        const measure = (performance as unknown as { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> }).measureUserAgentSpecificMemory
        return measure ? (await measure.call(performance)).bytes : null
      })
      const latencies = stream.latencies.map(row => row.latencyMs)
      const duringCatchup = stream.latencies.filter(row => row.atMs >= 9500 && row.atMs <= 15000).map(row => row.latencyMs)
      reports[arm] = { sha: arm === 'legacy' ? legacySha : candidateSha, ...stream,
        taskMs: (after.TaskDuration! - before.TaskDuration!) * 1000, heapBytes: heap, memoryBytes,
        latencyP95Ms: percentile(latencies, .95), catchupP95Ms: percentile(duringCatchup, .95), errors: [...errors, ...stream.errors] }
      await page.screenshot({ path: resolve(output, `${arm}.png`) })
      if (errors.length || stream.errors.length || stream.corpus.retained !== 2000 || stream.shown < stream.sent * .95)
        throw new Error(`${arm} fixture did not retain/render the required stream: ${JSON.stringify(reports[arm])}`)
    } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())) }
  }
  const legacy = reports.legacy as { taskMs: number; heapBytes: number; memoryBytes: number | null }
  const mobx = reports.mobx as typeof legacy & { catchupP95Ms: number }
  const verdict = {
    mainThreadNoWorse: mobx.taskMs <= legacy.taskMs,
    memoryNoWorse: (mobx.memoryBytes ?? mobx.heapBytes) <= (legacy.memoryBytes ?? legacy.heapBytes),
    catchupWithin50Ms: mobx.catchupP95Ms < 50,
  }
  const report = { legacySha, candidateSha, host: hostname(), cpu: cpus()[0]?.model, load: loadavg(), reports, verdict }
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, reports: Object.fromEntries(Object.entries(reports).map(([arm, value]) => [arm, { ...(value as object), latencies: undefined }])) }, null, 2))
  if (Object.values(verdict).some(value => !value)) process.exitCode = 1
} finally {
  if (leased) await command('podium', ['lock', 'release', 'bench:flatblock'])
  if (created) await command('git', ['worktree', 'remove', '--force', legacyRoot])
  if (Object.keys(reports).length) await writeFile(resolve(output, 'captures.json'), JSON.stringify(reports, null, 2))
}
