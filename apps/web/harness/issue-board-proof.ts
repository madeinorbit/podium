/** Foreground Chromium board-open/filter captures, on the operator-sized fixture. */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname } from 'node:os'
import { extname, resolve } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { paintOf, traceStart } from './browser-paint'

const args = process.argv.slice(2)
const label = args.find(arg => arg.startsWith('--label='))?.slice(8) ?? 'before'
const countsOnly = args.includes('--counts-only')
if (hostname() !== 'flatblock') throw new Error('Browser proof runs on flatblock')
if (!countsOnly && !args.includes('--lease-confirmed')) throw new Error('Timing capture requires bench:flatblock')
const root = resolve('.artifacts/issue-board')
const buildDir = resolve(root, 'build')
await mkdir(root, { recursive: true })
const { build } = await import('../node_modules/vite/dist/node/index.js')
const { default: config } = await import('./sidebar-acceptance.vite')
await build({ ...config, configFile: false,
  plugins: config.plugins?.filter(plugin => !(plugin && 'name' in plugin && plugin.name === 'acceptance-state-boundaries')),
  build: { ...config.build, outDir: buildDir, sourcemap: false, minify: 'esbuild',
    rollupOptions: { input: resolve('apps/web/harness/issue-board.browser.html') } },
})
const server = createServer(async (request, response) => {
  const file = resolve(buildDir, '.' + new URL(request.url!, 'http://localhost').pathname)
  if (!file.startsWith(buildDir + '/')) { response.writeHead(403).end(); return }
  try {
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
    response.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream')
    response.end(await readFile(file))
  } catch { response.writeHead(404).end() }
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const executablePath = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`
const browser = await chromium.launch({ headless: true, ...(existsSync(executablePath) ? { executablePath } : {}), args: ['--no-sandbox'] })
const runs: unknown[] = []
const outputs: Record<string, unknown[]> = {}

async function rendered(page: Page) {
  return page.locator('main').evaluate(node => [...node.querySelectorAll('button, [data-issue-id], [data-testid="issue-column"], h1, h2, h3')].map(element => ({
    tag: element.tagName, id: element.getAttribute('data-issue-id'), label: element.getAttribute('aria-label'),
    text: element.textContent?.trim(), title: element.getAttribute('title'),
  })))
}
async function capture(page: Page, trigger: string, expected: string, perform: () => Promise<unknown>) {
  await page.evaluate(({ trigger, expected }) => {
    const state = { input: false, dom: false, settled: false }
    Object.assign(window, { __boardCapture: state })
    performance.clearMarks()
    const input = (event: Event) => {
      if (!event.isTrusted || !(event.target instanceof Element) || !event.target.closest(trigger)) return
      state.input = true
      performance.mark('acceptance:input')
      document.removeEventListener('pointerdown', input, true)
    }
    document.addEventListener('pointerdown', input, true)
    const observer = new MutationObserver(() => {
      if (!state.input || state.dom || !document.querySelector(expected)) return
      state.dom = true
      performance.mark('acceptance:selected-dom')
      observer.disconnect()
      requestAnimationFrame(() => requestAnimationFrame(() => { state.settled = true }))
    })
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  }, { trigger, expected })
  const cdp = await page.context().newCDPSession(page)
  const stop = countsOnly ? null : await traceStart(cdp)
  await page.evaluate(() => (Reflect.get(window, '__boardHarness') as { reset(): void }).reset())
  try {
    await perform()
    await page.waitForFunction(() => Reflect.get(window, '__boardCapture')?.settled)
    const timings = stop ? paintOf(await stop()) : null
    const counts = await page.evaluate(() => (Reflect.get(window, '__boardHarness') as { stats(): unknown }).stats())
    return { ...(timings ?? {}), counts }
  } finally { await cdp.detach() }
}

try {
  const arms = label === 'before' ? ['legacy', 'legacy'] : ['legacy', 'pool', 'pool', 'legacy']
  for (const [run, arm] of arms.entries()) {
    const context = await browser.newContext({ viewport: { width: 1800, height: 1000 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    await page.goto(`${origin}/harness/issue-board.browser.html?mobxSidebar=1&mobxBoard=${arm === 'pool' ? 1 : 0}`)
    await page.waitForFunction(() => Reflect.get(window, '__boardHarness')?.ready(), undefined, { timeout: 120_000 })
    const initial = await page.evaluate(() => Reflect.get(window, '__boardHarness').state())
    const open = await capture(page, '[data-board-open]', '[data-testid="issues-board"] [data-issue-id]', () => page.locator('[data-board-open]').click())
    const full = await rendered(page)
    const population = () => page.locator('[data-testid="issue-column"] h3 + span').evaluateAll(nodes => nodes.reduce((n, node) => n + Number(node.textContent), 0))
    const fullRows = await population()
    if (initial.issues !== 19468 || initial.sessions !== 17208) throw new Error('Wrong 4x fixture cardinality')
    await page.getByRole('button', { name: 'Filter', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Status', exact: true }).click()
    const choice = page.locator('[data-slot="dropdown-menu-item"]').filter({ hasText: 'Planning' }).first()
    try { await choice.waitFor() }
    catch (error) {
      console.log(JSON.stringify(await page.locator('[role^="menuitem"]').evaluateAll(nodes => nodes.map(node => ({ role: node.getAttribute('role'), text: node.textContent, slot: node.getAttribute('data-slot') })))))
      await page.screenshot({ path: resolve(root, 'filter-driver.png') })
      throw error
    }
    const filter = await capture(page, '[role="menuitem"]', 'button[title="Remove filter"]', () => choice.click())
    await page.keyboard.press('Escape')
    const filtered = await rendered(page)
    const filteredRows = await population()
    if (!(filteredRows > 0 && filteredRows < fullRows)) throw new Error('Filter must select a nonempty proper subset')
    outputs[arm] ??= [full, filtered]
    if (run === 0) await page.screenshot({ path: resolve(root, `${label}-board.png`) })
    const final = await page.evaluate(() => ({ state: Reflect.get(window, '__boardHarness').state(), errors: Reflect.get(window, '__boardHarness').errors() }))
    if (errors.length || final.errors.length) throw new Error(`Fixture errors: ${JSON.stringify([...errors, ...final.errors])}`)
    runs.push({ arm, status: 'planning', fullRows, filteredRows, initial, final: final.state, open, filter })
    console.log(JSON.stringify({ run, arm, fullRows, filteredRows, open, filter, final: final.state }))
    await context.close()
  }
  if (outputs.pool && JSON.stringify(outputs.pool) !== JSON.stringify(outputs.legacy)) throw new Error('Rendered board parity differs')
  const report = { sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), label, countsOnly, browser: browser.version(), runs, renderedParity: outputs.pool ? true : null }
  await writeFile(resolve(root, `${label}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ saved: `${root}/${label}.json`, renderedParity: report.renderedParity }))
} finally {
  await browser.close()
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
}
