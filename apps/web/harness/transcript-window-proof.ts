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
const baseline = '8f5ae42e45587ed9dd83e5a05abff6e67200a91d'
await mkdir(directory, { recursive: true })
if (process.argv.includes('--build')) {
  const { build } = await import('../node_modules/vite/dist/node/index.js')
  const base = (await import('../vite.sidebar-pool-perf.config')).default
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
const framebuffer = resolve(directory, 'display')
await mkdir(framebuffer, { recursive: true })
const nativeEnv = { ...process.env, DISPLAY: '', PROOT_NO_SECCOMP: '1', LD_LIBRARY_PATH: `${nativeTools}/usr/lib/x86_64-linux-gnu:${resolve('.toolchain/lib')}` }
const displayServer = spawn(`${nativeTools}/usr/bin/proot`, ['--kill-on-exit', '-b', `${nativeTools}/usr/bin/xkbcomp:/usr/bin/xkbcomp`, `${nativeTools}/usr/bin/Xvfb`, '-displayfd', '1', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-ac', '-xkbdir', `${nativeTools}/usr/share/X11/xkb`, '-fbdir', framebuffer], { env: nativeEnv, stdio: ['ignore', 'pipe', 'pipe'] })
displayServer.stderr.on('data', data => process.stderr.write(data))
const display = await new Promise<string>((done, reject) => {
  displayServer.stdout.once('data', data => done(`:${String(data).trim()}`))
  displayServer.once('exit', code => reject(new Error(`Xvfb exited ${code}`)))
  displayServer.once('error', reject)
})
nativeEnv.DISPLAY = display
const displayPid = Number((await readFile(`/proc/${displayServer.pid}/task/${displayServer.pid}/children`, 'utf8')).trim().split(' ')[0])
if (!(await readFile(`/proc/${displayPid}/cmdline`, 'utf8')).includes(`${nativeTools}/usr/bin/Xvfb`)) throw new Error('Unidentified private display process')
const stopDisplay = () => process.kill(displayPid, 'SIGTERM')
const browser = await chromium.launch({ headless: false, executablePath: resolve(process.env.HOME!, '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'), args: ['--no-sandbox'], env: nativeEnv }).catch(error => { stopDisplay(); throw error })
const nativeKey = (...keys: string[]) => execFileSync(`${nativeTools}/usr/bin/xdotool`, ['key', '--clearmodifiers', ...keys], { env: nativeEnv })
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
  const browserCdp = await browser.newBrowserCDPSession()
  const samples = []
  let pagingAnchor
  for (const target of [200, 1000, 2200, 4200, 6200, 8058]) {
    if (target === 8058) {
      await page.evaluate(() => (window as any).__transcriptWindowProof.jump(2000))
      await page.waitForTimeout(100)
      const before = await page.evaluate(() => (window as any).__transcriptWindowProof.stats())
      await page.evaluate(() => (window as any).__transcriptWindowProof.page())
      await page.waitForTimeout(100)
      const after = await page.evaluate(() => (window as any).__transcriptWindowProof.stats())
      pagingAnchor = { before, after }
      if (before.key !== after.key || Math.abs(before.offset - after.offset) > 1) throw new Error('Paging changed the reading anchor')
      await page.evaluate(() => (window as any).__transcriptWindowProof.bottom())
    }
    while (await page.evaluate(() => (window as any).__transcriptWindowProof.stats().loaded) < target) {
      await page.evaluate(() => (window as any).__transcriptWindowProof.page())
      await page.waitForTimeout(50)
    }
    await page.waitForTimeout(200)
    await cdp.send('HeapProfiler.collectGarbage')
    const heap = await cdp.send('Runtime.getHeapUsage')
    const stats = await page.evaluate(() => (window as any).__transcriptWindowProof.stats())
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo')
    const resident = await Promise.all(processInfo.filter(process => process.type === 'renderer').map(async process => {
      const status = await readFile(`/proc/${process.id}/status`, 'utf8')
      return Number(status.match(/^VmRSS:\s+(\d+)/m)![1]) * 1024
    }))
    const rendererResidentBytes = resident.reduce((sum, value) => sum + value, 0)
    samples.push({ ...stats, heapUsed: heap.usedSize, heapTotal: heap.totalSize, rendererResidentBytes })
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
  nativeKey('ctrl+f')
  execFileSync(`${nativeTools}/usr/bin/xdotool`, ['type', '--clearmodifiers', '--delay', '0', 'native-needle-4000'], { env: nativeEnv })
  await page.waitForTimeout(300)
  const nativeFind = await page.evaluate(() => ({ selection: document.getSelection()?.toString(), beforematch: (window as any).__nativeFindEvents, stats: (window as any).__transcriptWindowProof.stats() }))
  console.log(JSON.stringify({ nativeFind }))
  await writeFile(resolve(directory, 'native-find.json'), JSON.stringify(nativeFind, null, 2))
  if (!nativeFind.stats.text.some((text: string) => text.includes('native-needle-4000'))) throw new Error('Native Find did not reveal its off-window match')
  if (arm === 'after' && nativeFind.stats.drawn !== nativeFind.stats.loaded) throw new Error('Native Find did not retain its original rich ranges')
  await page.screenshot({ path: resolve(directory, 'find.png') })
  execFileSync('python3', ['apps/web/harness/xvfb-screen.py', resolve(framebuffer, 'Xvfb_screen0'), resolve(directory, 'browser-find.png')])
  const nativeFindRoundTrip = [{ query: 'native-needle-4000', ...nativeFind.stats }]
  for (const query of ['native-needle-6000', 'native-needle-4000']) {
    nativeKey('ctrl+f', 'ctrl+a')
    execFileSync(`${nativeTools}/usr/bin/xdotool`, ['type', '--clearmodifiers', '--delay', '0', query], { env: nativeEnv })
    await page.waitForTimeout(300)
    const stats = await page.evaluate(() => (window as any).__transcriptWindowProof.stats())
    await writeFile(resolve(directory, 'find-roundtrip.json'), JSON.stringify({ query, stats }, null, 2))
    execFileSync('python3', ['apps/web/harness/xvfb-screen.py', resolve(framebuffer, 'Xvfb_screen0'), resolve(directory, 'browser-find.png')])
    if (!stats.text.some((text: string) => text.includes(query))) throw new Error('Native Find round-trip did not reveal its match')
    nativeFindRoundTrip.push({ query, ...stats })
  }
  await page.screenshot({ path: resolve(directory, 'find.png') })
  execFileSync('python3', ['apps/web/harness/xvfb-screen.py', resolve(framebuffer, 'Xvfb_screen0'), resolve(directory, 'browser-find.png')])
  nativeKey('Escape')
  await page.waitForTimeout(100)
  const nativeReveal = await page.evaluate(() => ({ ...((window as any).__transcriptWindowProof.stats()), selection: document.getSelection()?.toString() }))
  if (nativeReveal.selection !== 'native-needle-4000') throw new Error('Native Find lost its range when the bar closed')
  if (arm === 'after' && nativeReveal.drawn >= 64) throw new Error('Native Find did not return to the viewport buffer')
  await page.evaluate(() => document.getSelection()!.removeAllRanges())
  // Closing an empty Find must also release the temporary full-row session.
  nativeKey('ctrl+f', 'ctrl+a', 'BackSpace')
  await page.waitForTimeout(100)
  nativeKey('Escape')
  await page.waitForTimeout(100)
  const emptyFindClose = await page.evaluate(() => (window as any).__transcriptWindowProof.stats())
  if (arm === 'after' && emptyFindClose.drawn >= 64) throw new Error('Empty native Find did not return to the viewport buffer')
  await page.evaluate(() => (window as any).__transcriptWindowProof.jump(4000))
  await page.waitForTimeout(100)
  await page.screenshot({ path: resolve(directory, 'window.png') })
  await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus() })
  await page.keyboard.press('Tab')
  const keyboardFocus = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement
    return { tag: element.tagName, text: element.textContent, row: element.closest('[data-row-key]')?.getAttribute('data-row-key') }
  })
  if (keyboardFocus.row !== 'message-0') throw new Error('Native Tab did not restore the first off-window message control')
  const report = { arm, baseline, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), browser: browser.version(), samples, pagingAnchor, fastScroll, jump, wheel, selectionCopy: { selected, copied }, nativeFind, nativeFindRoundTrip, nativeReveal, emptyFindClose, keyboardFocus, errors }
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ arm, samples: samples.map(({ loaded, elements, drawn, heapUsed }) => ({ loaded, elements, drawn, heapUsed })), blankFrames: fastScroll.filter(sample => sample.visible === 0).length, jump: { key: jump.key, offset: jump.offset }, errors }))
  if (errors.length || fastScroll.some(sample => sample.visible === 0)) throw new Error('Production scroll proof failed')
} finally { await browser.close(); stopDisplay(); await new Promise<void>(done => server.close(() => done())) }
