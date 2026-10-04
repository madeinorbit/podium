/** Live sidebar capture. Credentials remain in memory; raw evidence stays on ludovico. */
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { hostname, loadavg } from 'node:os'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { preview } from 'vite'
import { installCommitObserver, saveComponentLocations, startCpu } from './full-screen-profile'

if (hostname() !== 'ludovico') throw new Error('Live evidence must stay on ludovico')
const label = process.argv.find(a => a.startsWith('--label='))?.slice(8) ?? 'baseline'
const inspect = process.argv.includes('--inspect')
const root = resolve('.artifacts/live-sidebar', label)
await mkdir(root, { recursive: true })
process.env.PODIUM_WEB_PORT = '55619'
const server = await preview({ root: resolve('apps/web'), configFile: resolve('apps/web/vite.config.ts'),
  preview: { host: '127.0.0.1', port: 55619, strictPort: true } })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' })
try {
  const token = execFileSync('podium', ['auth', 'mint-session', '--ttl', '2h', '--print-only'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  await context.addCookies([{ name: 'podium_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }])
  const page = await context.newPage()
  await installCommitObserver(page)
  await page.addInitScript(() => {
    localStorage.setItem('podium.panelMode', 'chat')
    const state = { input: null as number | null, dom: null as number | null, twoRaf: false,
      target: '', processingStart: 0, events: [] as unknown[], mutations: [] as unknown[] }
    Object.assign(window, { __speedCapture: state })
    new PerformanceObserver(list => state.events.push(...list.getEntries().map(e => e.toJSON())))
      .observe({ type: 'event', durationThreshold: 16, buffered: true })
    document.addEventListener('click', e => {
      if (!state.target || !(e.target instanceof Element) || !e.target.closest(`[data-issue-row="${state.target}"]`)) return
      state.input = e.timeStamp
      state.processingStart = performance.now()
      performance.mark('speed:input', { startTime: e.timeStamp })
      performance.mark('speed:handler')
    }, true)
    new MutationObserver(() => {
      if (state.input === null || state.dom !== null) return
      const row = document.querySelector(`[data-issue-row="${state.target}"]`)
      if (!row || !row.className.includes('selected')) return
      state.dom = performance.now()
      performance.mark('speed:dom')
      requestAnimationFrame(() => requestAnimationFrame(() => { state.twoRaf = true }))
    }).observe(document, { subtree: true, attributes: true, childList: true, characterData: true })
  })
  await page.goto('http://127.0.0.1:55619/?e2e=1&switchTrace=1', { waitUntil: 'domcontentloaded' })
  await page.locator('[data-issue-row]').first().waitFor({ timeout: 180_000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(10_000)
  const cdp = await context.newCDPSession(page)
  const rows = await page.locator('[data-issue-row]').evaluateAll(nodes => nodes.map(n => ({
    id: n.getAttribute('data-issue-row')!, className: n.className,
    attributes: [...n.attributes].map(a => a.name),
  })))
  console.log(JSON.stringify({ label, rows: rows.length, renderer: await page.evaluate(() => window.__speedReact.renderer),
    loadavg: loadavg(), classes: [...new Set(rows.map(r => r.className))],
    attributes: [...new Set(rows.flatMap(r => r.attributes))] }))
  if (inspect) {
    console.log(JSON.stringify(await page.evaluate(() => ({ globals: Object.keys(window).filter(k => /podium|pool|kernel/i.test(k)),
      main: [...document.querySelectorAll('main, [data-pane], [data-panel-resident], .issue-panel, .mission-pane')]
        .map(n => ({ tag: n.tagName, className: n.className, attributes: [...n.attributes].map(a => a.name) })) }))))
  } else {
    const targets = rows.filter(r => !r.className.includes('selected')).slice(0, 20).map(r => r.id)
    if (targets.length !== 20) throw new Error('Need 20 distinct sidebar targets')
    // The client has a bounded pane cache: revisits and resident warm visits are separate labels.
    const order = [...targets.map((id, index) => ({ id, index, visit: 'first' })),
      ...[...targets].reverse().map(id => ({ id, index: targets.indexOf(id), visit: 'revisit' }))]
    const summaries = []
    for (const [iteration, item] of order.entries()) {
      const row = page.locator(`[data-issue-row="${item.id}"]`).first()
      await row.scrollIntoViewIfNeeded()
      const box = await row.boundingBox()
      if (!box) throw new Error('Sidebar target has no bounds')
      await page.mouse.move(box.x + Math.min(120, box.width / 2), box.y + box.height / 2)
      await page.waitForTimeout(1000)
      await page.evaluate(id => {
        const state = (window as any).__speedCapture
        Object.assign(state, { target: id, input: null, dom: null, twoRaf: false, events: [], mutations: [] })
        window.__speedReact.commits = []
        performance.clearMarks()
      }, item.id)
      const events: any[] = []
      const receive = ({ value }: { value: any[] }) => events.push(...value)
      cdp.on('Tracing.dataCollected', receive)
      await cdp.send('Tracing.start', { categories: 'toplevel,devtools.timeline,blink.user_timing,latencyInfo,benchmark', transferMode: 'ReportEvents' })
      const stopCpu = await startCpu(cdp)
      await page.mouse.click(box.x + Math.min(120, box.width / 2), box.y + box.height / 2)
      await page.waitForFunction(() => (window as any).__speedCapture.twoRaf, { timeout: 60_000 })
      await page.waitForTimeout(300)
      const profile = await stopCpu()
      const complete = new Promise<void>(done => cdp.once('Tracing.tracingComplete', done))
      await cdp.send('Tracing.end')
      await complete
      cdp.off('Tracing.dataCollected', receive)
      const state = await page.evaluate(() => ({ boundary: (window as any).__speedCapture, react: window.__speedReact,
        traces: (window as any).__podiumSwitchTraces?.recent().slice(-1), elements: document.querySelectorAll('*').length }))
      const input = events.find(e => e.name === 'speed:input')
      const dom = events.find(e => e.name === 'speed:dom')
      const paint = events.filter(e => e.name === 'Paint' && e.ph === 'X' && e.pid === input?.pid && e.ts >= dom?.ts)
        .sort((a, b) => a.ts - b.ts)[0]
      if (!input || !dom || !paint) throw new Error('Missing input, selected DOM or actual Paint')
      const click = state.boundary.events.filter((e: any) => e.name === 'click').at(-1)
      const numbers = { iteration, target: item.index, visit: item.visit,
        inputDelayMs: click ? click.processingStart - click.startTime : state.boundary.processingStart - state.boundary.input,
        clickToPaintMs: (paint.ts + paint.dur - input.ts) / 1000,
        selectedDomMs: (dom.ts - input.ts) / 1000, elements: state.elements, commits: state.react.commits.length }
      const file = `click-${iteration.toString().padStart(2, '0')}`
      await writeFile(resolve(root, file + '.trace.json'), JSON.stringify({ traceEvents: events }))
      await writeFile(resolve(root, file + '.cpuprofile'), JSON.stringify(profile))
      await writeFile(resolve(root, file + '.json'), JSON.stringify({ ...numbers, ...state }))
      summaries.push(numbers)
      console.log(JSON.stringify(numbers))
    }
    await saveComponentLocations(page, cdp, resolve(root, 'components.json'))
    await writeFile(resolve(root, 'summary.json'), JSON.stringify({ label, sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), samples: summaries }, null, 2))
  }
} finally {
  await context.close()
  await browser.close()
  await server.httpServer.close()
}
