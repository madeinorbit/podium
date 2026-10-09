/** Production-only fast-scroll proof. Synthetic fixtures never contact an operator instance. */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname } from 'node:os'
import { extname, resolve } from 'node:path'
import { chromium } from '@playwright/test'

if (hostname() !== 'flatblock') throw new Error('Run the scroll proof on flatblock')
console.log(`Fast-scroll foreground PID ${process.pid}`)
const arm = process.argv[2]
if (!['before', 'after'].includes(arm ?? '')) throw new Error('Choose before or after')
const output = resolve('.artifacts/fast-scroll', arm!)
await mkdir(output, { recursive: true })
const fixtures = ['lists', 'chat', 'phone-lists', 'phone-chat'] as const
if (process.argv.includes('--build')) {
  const { build } = await import('../node_modules/vite/dist/node/index.js')
  for (const fixture of fixtures.filter(name => !process.argv.includes('--fixture') || name === process.argv[process.argv.indexOf('--fixture') + 1])) {
    const base = fixture === 'lists'
      ? (await import('./sidebar-acceptance.vite')).default
      : fixture === 'chat'
        ? (await import('../vite.conversation-stream.config')).default
        : fixture === 'phone-lists'
          ? await (await import('../../mobile/vite.conversation-stream.config')).default()
          : await (await import('../../mobile/vite.conversation-stream.config')).default()
    if (fixture === 'phone-lists') base.resolve!.alias = (base.resolve!.alias as any[]).map(alias => ({ ...alias, replacement: alias.replacement.endsWith('/stub-bottom-sheet.tsx') ? resolve('apps/mobile/test/fast-scroll-sheet.tsx') : alias.replacement.endsWith('/conversation-stream-platform.tsx') ? resolve('apps/mobile/test/fast-scroll-platform.tsx') : alias.replacement }))
    console.log(`Building ${arm} ${fixture}`)
    await build({ ...base, configFile: false, logLevel: 'warn',
      define: { ...base.define, __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
      plugins: [...(arm === 'before' ? [{ name: 'unchanged-product-windowing', enforce: 'pre' as const, load(id: string) { const path = ['apps/web/src/features/worklist/pool-sidebar.tsx', 'apps/web/src/features/worklist/worklist-motion.tsx', 'apps/mobile/src/hooks/useNativeTranscriptScroll.ts', 'apps/web/src/features/issues/use-bounded-virtual-list.ts', 'apps/web/src/app/flight-deck-window.tsx', 'packages/client-core/src/react/use-dom-transcript-scroll.ts', 'apps/mobile/src/components/IssueTargetSheet.tsx', 'apps/mobile/src/components/TranscriptViewport.native.tsx', ...['WorkScreen', 'IssuesScreen', 'InboxScreen', 'SessionsScreen'].map(name => `apps/mobile/src/screens/${name}.tsx`)].find(path => id.endsWith('/' + path)); return path ? execFileSync('git', ['show', 'ff68b5e727:' + path], { encoding: 'utf8' }) : null } }] : []), ...(base.plugins?.filter(plugin => !/meter|acceptance-state/.test((plugin as { name?: string })?.name ?? '')) ?? [])],
      build: { ...base.build, outDir: resolve(output, fixture), emptyOutDir: true, minify: true, sourcemap: false,
        rolldownOptions: fixture === 'phone-lists' ? { ...base.build?.rolldownOptions, input: resolve('apps/mobile/test/inbox.browser.html') } : base.build?.rolldownOptions,
        rollupOptions: fixture === 'phone-lists' ? { input: resolve('apps/mobile/test/inbox.browser.html') } : base.build?.rollupOptions },
    })
  }
  await writeFile(resolve(output, 'revision.txt'), JSON.stringify({ source: arm === 'before' ? 'ff68b5e727' : execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), fixture: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }))
  process.exit(0)
}

const reports: unknown[] = []
for (const fixture of fixtures.filter(name => !process.argv.includes('--fixture') || name === process.argv[process.argv.indexOf('--fixture') + 1])) {
  const directory = resolve(output, fixture)
  const server = createServer(async (req, res) => {
    try {
      const file = resolve(directory, '.' + new URL(req.url!, 'http://fixture.invalid').pathname)
      if (!file.startsWith(directory + '/')) throw new Error('Invalid path')
      res.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream')
      res.end(await readFile(file))
    } catch { res.writeHead(404); res.end() }
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const browser = await chromium.launch({ executablePath: process.env.PODIUM_SCROLL_CHROME, channel: process.env.PODIUM_SCROLL_CHROME ? undefined : 'chromium', headless: true, args: ['--no-sandbox'],
    env: { ...process.env, LD_LIBRARY_PATH: resolve('.toolchain/lib') } })
  console.log(`Production Chromium ${browser.version()}`)
  try {
    const variants = fixture === 'lists' ? ['scroll', 'list', 'explorer', 'full', 'waterfall-css'] : fixture === 'phone-lists' ? ['inbox', 'work', 'tasks', 'sessions', 'target'] : ['chat']
    for (const variant of variants.filter(name => !process.argv.includes('--variant') || process.argv[process.argv.indexOf('--variant') + 1]!.split(',').includes(name))) {
      const page = await browser.newPage({ viewport: fixture.startsWith('phone') ? { width: 390, height: 844 } : { width: 1600, height: 900 }, reducedMotion: 'reduce' })
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const name = fixture === 'lists' ? 'sidebar-acceptance' : fixture === 'phone-lists' ? 'inbox' : 'conversation-stream'
      console.log(`Opening ${arm} ${fixture} ${variant}`)
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/test/${name}.browser.html?scale=4&surface=${variant === 'list' ? 'scroll' : variant === 'waterfall' ? 'full' : variant}&scrollScreen=${variant}&enableWaterfall=${variant === 'waterfall' ? 1 : 0}`)
      await page.waitForFunction(() => (window as any).__acceptance?.ready() || (window as any).__conversationStream?.ready() || (window as any).__inbox?.readiness().attached, null, { timeout: 90_000 }).catch(async error => { console.log(await page.evaluate(() => ({ errors: (window as any).__acceptance?.errors() ?? (window as any).__inbox?.stats(), body: document.body.innerText.slice(0, 1000) }))); throw error })
      await page.waitForTimeout(750)
      await page.evaluate(() => document.fonts.ready)
      if (variant === 'list') { await page.getByTitle('Display', { exact: true }).click(); await page.getByRole('menuitemradio', { name: 'List', exact: true }).click(); await page.keyboard.press('Escape'); await page.waitForTimeout(500) }
      if (fixture === 'lists' && ['full', 'waterfall'].includes(variant)) {
        const id = 'i14942'
        await page.evaluate(id => (window as any).__acceptance.select(id), id)
        await page.waitForTimeout(1000)
        if (variant === 'waterfall') { await page.getByRole('button', { name: 'Waterfall', exact: true }).click(); await page.waitForTimeout(500) }
      }
      await page.keyboard.press('Escape')
      const candidates = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('*')]
        .filter(el => el.clientHeight > 100 && el.clientWidth > 100 && el.scrollHeight > el.clientHeight + 300 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) && el.getBoundingClientRect().right > 0 && el.getBoundingClientRect().left < innerWidth)
        .map((el, i) => { el.dataset.scrollProof = String(i); return { index: i, class: el.className, testid: el.dataset.testid, height: el.clientHeight, range: el.scrollHeight - el.clientHeight, text: el.innerText.slice(0, 70) } }))
      console.log(fixture, variant, JSON.stringify({ candidates, errors }))
      for (const candidate of candidates) {
        if (variant !== 'scroll' && candidate.testid === 'work-scroll') continue
        const selector = `[data-scroll-proof="${candidate.index}"]`
        const box = await page.locator(selector).boundingBox()
        if (!box || box.x < 0 || box.x + box.width > (fixture.startsWith('phone') ? 390 : 1600)) continue
        const tag = `${fixture}-${variant}-${candidate.index}`
        if (process.argv.includes('--paint-buffer')) await page.addStyleTag({ content: `${selector} [data-window-row], ${selector} > div > div { contain: layout paint; will-change: transform; }` })
        await page.locator(selector).evaluate(el => { el.scrollTop = 0 })
        await page.waitForTimeout(250)
        await page.screenshot({ path: resolve(output, `${tag}-settled.png`) })
        const cdp = await page.context().newCDPSession(page)
        const frames: { data: string; timestamp: number }[] = []
        cdp.on('Page.screencastFrame', event => {
          frames.push({ data: event.data, timestamp: event.metadata.timestamp! })
          void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId })
        })
        await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 })
        const sample = await page.evaluate(({ selector, diagnose }) => {
          const scroll = document.querySelector<HTMLElement>(selector)!
          const rows = '[data-window-row], [data-virtual-issue-key], [data-deck-measure], [data-row-key], [data-testid="work-list-row"]'
          const state = { samples: [] as { time: number; top: number; blankPx: number; area: number; mounted: number; textBlankPx: number }[], active: true }
          ;(window as any).__scrollProof = state
          const tick = () => {
            if (!state.active) return
            const box = scroll.getBoundingClientRect()
            const nodes = [...scroll.querySelectorAll<HTMLElement>(rows)]
            const regions = [...scroll.querySelectorAll<HTMLElement>('[data-testid="worklist-window"], ul[style], [data-window-container]')].filter(el => !el.parentElement?.closest('[data-testid="worklist-window"], ul[style], [data-window-container]'))
            const spans = (regions.length ? regions : [scroll]).map(el => el.getBoundingClientRect()).filter(r => r.bottom > box.top && r.top < box.bottom)
            let blankPx = 0, area = 0
            for (const region of spans) {
              const top = Math.max(box.top, region.top), bottom = Math.min(box.bottom, region.bottom)
              const intervals = nodes.map(n => n.getBoundingClientRect()).filter(r => r.bottom > top && r.top < bottom).sort((a, b) => a.top - b.top)
              if (!nodes.length) continue // Native RN Web lists are fully mounted; raster proof below.
              let edge = top
              for (const row of intervals) { if (row.top - edge > 20) blankPx += Math.min(row.top, bottom) - edge; edge = Math.max(edge, row.bottom) }
              if (bottom - edge > 20) blankPx += bottom - edge
              area += bottom - top
            }
            const textRects = diagnose ? [...scroll.querySelectorAll<HTMLElement>('*')].filter(el => [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())).map(el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.bottom > box.top && r.top < box.bottom).sort((a,b) => a.top-b.top) : []
            let textEdge = box.top, textBlankPx = 0
            for (const r of textRects) { if (r.top - textEdge > 120) textBlankPx += r.top - textEdge; textEdge = Math.max(textEdge, r.bottom) }
            if (diagnose && box.bottom - textEdge > 120) textBlankPx += box.bottom - textEdge
            state.samples.push({ textBlankPx, time: Date.now(), top: scroll.scrollTop, blankPx, area, mounted: nodes.length })
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
          return true
        }, { selector, diagnose: process.argv.includes('--diagnose') })
        void sample
        const start = Date.now()
        for (let step = 0; step < 40; step++) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x + box.width / 2, y: box.y + box.height / 2, deltaX: 0, deltaY: step < 20 ? 600 : -600 })
          await page.waitForTimeout(Math.max(0, start + (step + 1) * 20 - Date.now()))
        }
        await page.waitForTimeout(150)
        const samples = await page.evaluate(() => { const state = (window as any).__scrollProof; state.active = false; return state.samples as { time: number; top: number; blankPx: number; area: number; mounted: number }[] })
        await cdp.send('Page.stopScreencast')
        await cdp.detach()
        if (Math.max(...samples.map(s => s.top)) - Math.min(...samples.map(s => s.top)) < 300 || frames.length < 10) throw new Error(`${tag}: wheel did not reach the list; no scroll result`)
        // Decode compositor frames after capture, outside the measured scroll.
        const raster = await page.evaluate(async ({ frames, box }) => {
          const results: { blankPx: number; maxGap: number; timestamp: number }[] = []
          for (const frame of frames) {
            const img = new Image(); img.src = 'data:image/jpeg;base64,' + frame.data; await img.decode()
            const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height
            const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0)
            const x = Math.max(0, Math.ceil(box.x + 22)), y = Math.max(0, Math.ceil(box.y + 6))
            const width = Math.min(img.width - x, Math.floor(box.width - 44)), height = Math.min(img.height - y, Math.floor(box.height - 12))
            const data = ctx.getImageData(x, y, width, height).data
            let gap = 0, maxGap = 0, blankPx = 0
            for (let row = 0; row < height; row++) {
              let lo = 255, hi = 0
              for (let col = 0; col < width; col++) { const at = (row * width + col) * 4; const v = (data[at]! + data[at + 1]! + data[at + 2]!) / 3; lo = Math.min(lo, v); hi = Math.max(hi, v) }
              if (hi - lo < 35) gap++
              else { maxGap = Math.max(maxGap, gap); if (gap > 120) blankPx += gap; gap = 0 }
            }
            maxGap = Math.max(maxGap, gap); if (gap > 120) blankPx += gap
            results.push({ blankPx, maxGap, timestamp: frame.timestamp })
          }
          return results
        }, { frames, box })
        const worst = raster.reduce((a, b) => a.blankPx >= b.blankPx ? a : b, raster[0] ?? { blankPx: 0, timestamp: 0 })
        const frame = frames.find(f => f.timestamp === worst.timestamp)
        if (frame) await writeFile(resolve(output, `${tag}-worst.jpg`), Buffer.from(frame.data, 'base64'))
        const report = { fixture, variant, candidate, samples: samples.length, blankFrames: samples.filter(s => s.blankPx > 20).length,
          maxBlankPx: Math.max(0, ...samples.map(s => s.blankPx)), maxBlankPercent: Math.max(0, ...samples.map(s => s.area ? s.blankPx / s.area * 100 : 0)),
          mountedPeak: Math.max(0, ...samples.map(s => s.mounted)), compositorFrames: frames.length, textBlankFrames: samples.filter((s: any) => s.textBlankPx > 0).length,
          rasterBlankFrames: raster.filter(r => r.blankPx > 0).length, rasterMaxBlankPx: worst.blankPx,
          samplesRaw: samples, raster, errors }
        reports.push(report)
        console.log(tag, JSON.stringify({ ...report, samplesRaw: undefined, raster: undefined }))
        await writeFile(resolve(output, `${tag}.json`), JSON.stringify(report, null, 2))
      }
      await page.close()
    }
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())) }
}
await writeFile(resolve(output, 'report.json'), JSON.stringify(reports, null, 2))
