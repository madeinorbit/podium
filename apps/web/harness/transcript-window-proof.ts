/** Matched production builds and attached-DOM/heap/scroll evidence, flatblock only. */
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname } from 'node:os'
import { extname, resolve } from 'node:path'

if (hostname() !== 'flatblock') throw new Error('Run on flatblock only')
const arm = process.argv[2]
if (arm !== 'before' && arm !== 'after') throw new Error('Choose before or after')
const directory = resolve('.artifacts/transcript-window', arm)
await mkdir(directory, { recursive: true })
if (process.argv.includes('--build')) {
  const { build } = await import('../node_modules/vite/dist/node/index.js')
  const base = (await import('../vite.sidebar-pool-perf.config')).default
  const baseline = '36aeb3b8f4'
  const paths = ['apps/web/src/features/chat/TranscriptFeed.tsx', 'packages/client-core/src/react/use-dom-transcript-scroll.ts', 'apps/web/src/styles.css']
  await build({ ...base, configFile: false, logLevel: 'warn',
    plugins: [...(arm === 'before' ? [{ name: 'original-transcript', enforce: 'pre' as const,
      load(id: string) { const path = paths.find(path => id.endsWith('/' + path)); return path ? execFileSync('git', ['show', `${baseline}:${path}`], { encoding: 'utf8' }) : null } }] : []),
      ...base.plugins!.filter((plugin: any) => !/meter/.test(plugin?.name ?? ''))],
    build: { outDir: directory, emptyOutDir: true, minify: true,
      rollupOptions: { input: resolve('apps/web/test/transcript-window.browser.html') } } })
  process.exit(0)
}
const server = createServer(async (req, res) => {
  try {
    const file = resolve(directory, '.' + new URL(req.url!, 'http://fixture.invalid').pathname)
    if (!file.startsWith(directory + '/')) throw new Error('Invalid path')
    res.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream')
    res.end(await readFile(file))
  } catch { res.writeHead(404); res.end() }
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], env: { ...process.env, LD_LIBRARY_PATH: resolve('.toolchain/lib') } })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${(server.address() as any).port}/test/transcript-window.browser.html`)
  await page.waitForFunction(() => (window as any).__transcriptWindowProof?.stats().drawn > 0)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300)
  const cdp = await page.context().newCDPSession(page)
  const samples = []
  for (const target of [200, 1000, 2200, 4200, 6200, 8058]) {
    while (await page.evaluate(() => (window as any).__transcriptWindowProof.stats().loaded) < target) {
      await page.evaluate(() => (window as any).__transcriptWindowProof.page())
      await page.waitForTimeout(50)
    }
    await page.waitForTimeout(200)
    await cdp.send('HeapProfiler.collectGarbage')
    const heap = await cdp.send('Runtime.getHeapUsage')
    const stats = await page.evaluate(() => (window as any).__transcriptWindowProof.stats())
    samples.push({ ...stats, heapUsed: heap.usedSize, heapTotal: heap.totalSize })
  }
  const fastScroll = await page.evaluate(async () => {
    const scroll = document.querySelector<HTMLElement>('[data-feed-scroller]')!
    const samples = []
    for (let step = 1; step <= 50; step++) {
      scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * (step % 25) / 24
      await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
      const box = scroll.getBoundingClientRect()
      const rows = [...scroll.querySelectorAll<HTMLElement>('[data-block]')].filter(row => !row.hasAttribute('data-transcript-placeholder'))
      const visible = rows.filter(row => { const rect = row.getBoundingClientRect(); return rect.bottom > box.top && rect.top < box.bottom })
      samples.push({ top: scroll.scrollTop, visible: visible.length, drawn: rows.length })
    }
    return samples
  })
  await page.evaluate(() => (window as any).__transcriptWindowProof.jump(4000))
  await page.waitForTimeout(200)
  const jump = await page.evaluate(() => (window as any).__transcriptWindowProof.stats())
  await page.screenshot({ path: resolve(directory, 'window.png') })
  const report = { arm, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), browser: browser.version(), samples, fastScroll, jump, errors }
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  if (errors.length || fastScroll.some(sample => sample.visible === 0)) throw new Error('Production scroll proof failed')
} finally { await browser.close(); await new Promise<void>(done => server.close(() => done())) }
