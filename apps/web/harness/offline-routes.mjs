/** Focused production-chunk regression, with the real shell and local replica.
 * No daemon, operator corpus, clicks, timings, or performance measurements.
 * Run: bun run test:offline-routes (on an agent VM via remote-lane).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { build } from '../node_modules/vite/dist/node/index.js'

const out = resolve('.artifacts/offline-routes')
mkdirSync(out, { recursive: true })
await build({ configFile: resolve('apps/web/vite.offline-routes.config.ts'), logLevel: 'warn' })
const dist = resolve(out, 'build')
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    const file = Bun.file(resolve(dist, `.${path}`))
    if (!path.endsWith('/') && (await file.exists())) return new Response(file)
    if (path.startsWith('/assets/')) return new Response('Missing', { status: 404 })
    return new Response(Bun.file(resolve(dist, 'harness/offline-routes.html')), {
      headers: { 'content-type': 'text/html' },
    })
  },
})
const result = {
  sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  status: 'running',
  screens: [],
  frameNavigated: [],
  documentRequests: [],
  loadedScripts: [],
  offlineScriptRequests: [],
  errors: [],
}
let browser
let page
try {
  const browserEnv = { ...process.env }
  const userLib = resolve(homedir(), '.cache/podium-chromium-deps/root/usr/lib/x86_64-linux-gnu')
  if (existsSync(userLib)) browserEnv.LD_LIBRARY_PATH = userLib
  else delete browserEnv.LD_LIBRARY_PATH
  browser = await chromium.launch({
    env: browserEnv,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    serviceWorkers: 'block',
  })
  page = await context.newPage()
  let phase = 'startup'
  const frameChecks = []
  await page.addInitScript(() => {
    window.offlineDocumentId = crypto.randomUUID()
    localStorage.setItem('podium.panelModeDefault', 'chat')
  })
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return
    const entry = { phase, url: frame.url(), documentId: null }
    result.frameNavigated.push(entry)
    frameChecks.push(
      frame
        .evaluate(() => window.offlineDocumentId)
        .then(
          (id) => {
            entry.documentId = id
          },
          () => {
            entry.documentId = 'context-replaced'
          },
        ),
    )
  })
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      result.documentRequests.push({ phase, url: request.url() })
    if (phase === 'offline' && request.resourceType() === 'script')
      result.offlineScriptRequests.push(request.url())
  })
  page.on('response', (response) => {
    if (response.request().resourceType() === 'script' && response.ok())
      result.loadedScripts.push(new URL(response.url()).pathname)
  })
  page.on('pageerror', (error) => result.errors.push(error.message))
  await page.goto(`${server.url}?demo=1`, { waitUntil: 'networkidle' })
  await expect(page.locator('.desktop-shell')).toBeVisible({ timeout: 30000 })
  await page.waitForFunction(() => Boolean(window.offlineRoutes))
  // These production chunks must finish loading while no route has visited them.
  const graph = JSON.parse(readFileSync(resolve(dist, '.vite/import-graph.json'), 'utf8'))
  for (const source of [
    'features/issues/IssuesView.tsx',
    'app/FlightDeck.tsx',
    'features/issues/IssuePage.tsx',
    'features/workflows/WorkflowsView.tsx',
    'features/automations/AutomationsView.tsx',
    'features/specs/SpecsView.tsx',
  ]) {
    const chunks = Object.entries(graph.chunks)
      .filter(([, chunk]) => chunk.modules.includes(`apps/web/src/${source}`))
      .map(([file]) => file)
    assert(chunks.length > 0, `No built chunk for ${source}`)
    assert(
      chunks.every((file) => result.loadedScripts.some((path) => path.endsWith(`/${file}`))),
      `Idle import missing: ${source}`,
    )
  }
  assert(
    !result.loadedScripts.some((path) => path.includes('/UsageView-')),
    'Usage was unexpectedly prefetched',
  )
  const documentId = await page.evaluate(() => window.offlineDocumentId)
  const navigate = (path) =>
    page.evaluate((path) => {
      history.pushState(null, '', `${path}?demo=1`)
      dispatchEvent(new PopStateEvent('popstate'))
    }, path)
  const check = async (name, run, ready) => {
    await run()
    await ready()
    await expect(page.locator('.desktop-shell')).toBeVisible()
    await expect(page.locator('[data-offline-screen]')).toHaveCount(0)
    assert.equal(
      await page.evaluate(() => window.offlineDocumentId),
      documentId,
      `${name} replaced the document`,
    )
    assert(!page.url().startsWith('chrome-error:'), `${name} opened a browser error page`)
    result.screens.push({ screen: name, ready: true, documentId })
    await page.screenshot({ path: resolve(out, `${name}.png`) })
  }
  phase = 'offline'
  await context.setOffline(true)
  await check(
    'board',
    () => navigate('/issues'),
    () => expect(page.getByLabel('Search tasks')).toBeVisible(),
  )
  await expect(page.locator('.desktop-shell-row')).toContainText(
    'OAuth refresh loop logs users out',
  )
  await check(
    'deck',
    () => page.evaluate(() => window.offlineRoutes.openDeck()),
    () => expect(page.locator('.deck-header')).toContainText('Host resource lifecycle policy'),
  )
  await check(
    'issue-page',
    () => navigate('/issues/demo-issue-auth'),
    () => expect(page.getByTestId('issue-page')).toContainText('OAuth refresh loop logs users out'),
  )
  await check(
    'search',
    async () => {
      await navigate('/issues')
      await page.getByLabel('Search tasks').fill('OAuth')
    },
    () =>
      expect(page.locator('.desktop-shell-row')).toContainText('OAuth refresh loop logs users out'),
  )
  assert.deepEqual(
    result.offlineScriptRequests,
    [],
    'Warmed navigation tried to fetch code offline',
  )

  // No visit or prefetch for this real route. It must fail only within the shell.
  phase = 'uncached-offline'
  await navigate('/usage')
  await expect(page.locator('[data-offline-screen]')).toContainText(
    'This screen is not available offline.',
    { timeout: 10000 },
  )
  await expect(page.locator('.desktop-shell')).toBeVisible()
  assert.equal(await page.evaluate(() => window.offlineDocumentId), documentId)
  await page.screenshot({ path: resolve(out, 'uncached-offline.png') })
  phase = 'online-recovery'
  await context.setOffline(false)
  await expect(page.getByTestId('usage-sheet')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('[data-offline-screen]')).toHaveCount(0)
  assert.equal(await page.evaluate(() => window.offlineDocumentId), documentId)
  result.screens.push({ screen: 'uncached-online-recovery', ready: true, documentId })
  await page.screenshot({ path: resolve(out, 'online-recovery.png') })
  await Promise.all(frameChecks)
  assert.deepEqual(
    result.documentRequests.filter((entry) => entry.phase !== 'startup'),
    [],
    'Document navigation after startup',
  )
  assert(
    result.frameNavigated
      .filter((entry) => entry.phase !== 'startup')
      .every((entry) => entry.documentId === documentId),
    'framenavigated replaced the document',
  )
  assert.deepEqual(result.errors, [], 'Unhandled page error')
  result.status = 'passed'
  console.log(
    'Offline routes passed: board, deck, issue page, search; uncached usage recovered on online. No document navigation.',
  )
} catch (error) {
  result.status = 'failed'
  result.failure = String(error.stack ?? error)
  await page?.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {})
  throw error
} finally {
  writeFileSync(resolve(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  await browser?.close()
  await server.stop(true)
}
