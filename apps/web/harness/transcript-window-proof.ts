/** Matched production builds and attached-DOM/heap/scroll evidence, flatblock only. */
import { chromium } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
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
      ...base.plugins!.filter((plugin: any) => !/meter|test-product-work-counters/.test(plugin?.name ?? ''))],
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
const nativeTools = resolve('.toolchain/native-find')
const nativeEnv = { ...process.env, DISPLAY: '', PROOT_NO_SECCOMP: '1', LD_LIBRARY_PATH: `${nativeTools}/usr/lib/x86_64-linux-gnu:${resolve('.toolchain/lib')}` }
const displayServer = spawn(`${nativeTools}/usr/bin/proot`, ['-b', `${nativeTools}/usr/bin/xkbcomp:/usr/bin/xkbcomp`, `${nativeTools}/usr/bin/Xvfb`, '-displayfd', '1', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-ac', '-xkbdir', `${nativeTools}/usr/share/X11/xkb`], { env: nativeEnv, stdio: ['ignore', 'pipe', 'pipe'] })
displayServer.stderr.on('data', data => process.stderr.write(data))
const display = await new Promise<string>((done, reject) => {
  displayServer.stdout.once('data', data => done(`:${String(data).trim()}`))
  displayServer.once('exit', code => reject(new Error(`Xvfb exited ${code}`)))
  displayServer.once('error', reject)
})
nativeEnv.DISPLAY = display
const browser = await chromium.launch({ headless: false, executablePath: resolve(process.env.HOME!, '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'), args: ['--no-sandbox'], env: nativeEnv }).catch(error => { displayServer.kill(); throw error })
const nativeKey = (id: string, ...keys: string[]) => execFileSync(`${nativeTools}/usr/bin/xdotool`, ['key', '--window', id, '--clearmodifiers', ...keys], { env: nativeEnv })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); console.log('Page error:', error.message) })
  page.on('console', message => { if (message.type() === 'error') console.log('Browser error:', message.text()) })
  await page.goto(`http://127.0.0.1:${(server.address() as any).port}/test/transcript-window.browser.html`)
  console.log('Production fixture opened')
  await page.waitForFunction(() => (window as any).__transcriptWindowProof?.stats().drawn > 0)
  console.log('Production rows ready')
  await page.evaluate(() => document.fonts.ready)
  console.log('Fonts ready')
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
    await writeFile(resolve(directory, 'samples.json'), JSON.stringify(samples, null, 2))
    console.log(JSON.stringify({ loaded: stats.loaded, elements: stats.elements, drawn: stats.drawn, heapUsed: heap.usedSize }))
  }
  const fastScroll = process.argv.includes('--debug') ? [] : await page.evaluate(async () => {
    const scroll = document.querySelector<HTMLElement>('[data-feed-scroller]')!
    const samples = []
    for (let step = 1; step <= 50; step++) {
      scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * (step % 25) / 24
      await new Promise<void>(done => requestAnimationFrame(() => setTimeout(done, 0)))
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
  // Exercise a real wheel event and the browser's native copy boundary.
  const feed = page.locator('[data-feed-scroller]')
  const feedBox = (await feed.boundingBox())!
  await page.mouse.move(feedBox.x + feedBox.width / 2, feedBox.y + feedBox.height / 2)
  await page.mouse.wheel(0, 1600)
  await page.waitForTimeout(100)
  const wheel = await page.evaluate(() => (window as any).__transcriptWindowProof.stats())
  const selected = await page.evaluate(() => {
    const el = document.querySelector('[data-feed-scroller]')!
    const box = el.getBoundingClientRect()
    const paragraphs = [...el.querySelectorAll<HTMLParagraphElement>('[data-block]:not([data-transcript-placeholder]) p')]
      .filter(p => { const r = p.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom })
    const range = document.createRange()
    range.setStart(paragraphs[0]!.firstChild!, 0)
    range.setEnd(paragraphs[1]!.lastChild!, paragraphs[1]!.lastChild!.textContent!.length)
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    return selection.toString()
  })
  await page.evaluate(() => { const el = document.querySelector<HTMLElement>('[data-feed-scroller]')!; el.scrollTop = 0 })
  await page.waitForTimeout(100)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.keyboard.press('Control+c')
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  if (!selected || copied !== selected) throw new Error('Selection/copy changed when its rows left the viewport')
  await page.evaluate(() => document.getSelection()!.removeAllRanges())
  await page.waitForTimeout(100)
  // Drive the browser's real Find bar. window.find omits beforematch in Blink.
  await page.evaluate(() => { (window as any).__nativeFindEvents = 0; document.addEventListener('beforematch', () => (window as any).__nativeFindEvents++, true) })
  const windowId = execFileSync(`${nativeTools}/usr/bin/xdotool`, ['search', '--onlyvisible', '--class', 'chrom(e|ium)'], { env: nativeEnv, encoding: 'utf8' }).trim().split('\n')[0]!
  execFileSync(`${nativeTools}/usr/bin/xdotool`, ['windowfocus', '--sync', windowId], { env: nativeEnv })
  nativeKey(windowId, 'ctrl+f')
  execFileSync(`${nativeTools}/usr/bin/xdotool`, ['type', '--window', windowId, '--clearmodifiers', '--delay', '0', 'native-needle-4000'], { env: nativeEnv })
  await page.waitForTimeout(300)
  const nativeFind = await page.evaluate(() => ({ selection: document.getSelection()?.toString(), beforematch: (window as any).__nativeFindEvents, stats: (window as any).__transcriptWindowProof.stats() }))
  console.log(JSON.stringify({ nativeFind }))
  await writeFile(resolve(directory, 'native-find.json'), JSON.stringify(nativeFind, null, 2))
  if (!nativeFind.stats.text.some((text: string) => text.includes('native-needle-4000'))) throw new Error('Native Find did not reveal its off-window match')
  if (arm === 'after' && !nativeFind.beforematch) throw new Error('Native Find did not exercise beforematch')
  await page.screenshot({ path: resolve(directory, 'find.png') })
  nativeKey(windowId, 'Escape')
  await page.waitForTimeout(100)
  const nativeReveal = await page.evaluate(() => ({ ...((window as any).__transcriptWindowProof.stats()), selection: document.getSelection()?.toString() }))
  if (nativeReveal.selection !== 'native-needle-4000') throw new Error('Native Find lost its range when the bar closed')
  await page.evaluate(() => document.getSelection()!.removeAllRanges())
  await page.evaluate(() => (window as any).__transcriptWindowProof.jump(4000))
  await page.waitForTimeout(100)
  await page.screenshot({ path: resolve(directory, 'window.png') })
  const report = { arm, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), browser: browser.version(), samples, fastScroll, jump, wheel, selectionCopy: { selected, copied }, nativeFind, nativeReveal, errors }
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ arm, samples: samples.map(({ loaded, elements, drawn, heapUsed }) => ({ loaded, elements, drawn, heapUsed })), blankFrames: fastScroll.filter(sample => sample.visible === 0).length, jump: { key: jump.key, offset: jump.offset }, errors }))
  if (errors.length || fastScroll.some(sample => sample.visible === 0)) throw new Error('Production scroll proof failed')
} finally { await browser.close(); displayServer.kill(); await new Promise<void>(done => server.close(() => done())) }
