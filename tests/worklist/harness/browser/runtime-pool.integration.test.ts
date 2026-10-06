/** Real-browser lifetime evidence belongs to the integration lane. */
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { resolve } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {} from './runtime-pool-fixture'

let server: Server
let browser: Browser
let origin: string

beforeAll(async () => {
  // Vite runs in its own foreground process, outside the Vitest worker.
  // Rebuild from source so test:file never serves stale or absent fixture bytes.
  execFileSync(process.execPath, [
    'x', 'vite', 'build', '--config',
    'tests/worklist/harness/browser/runtime-pool.vite.config.ts',
  ], {
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
    timeout: 120_000, stdio: 'pipe',
  })
  const dist = fileURLToPath(new URL('../../node_modules/.cache/runtime-pool-browser/', import.meta.url))
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://fixture').pathname
    const relative = pathname === '/__pool_test' ? '/test/store-worklist-pool.browser.html' : pathname
    const target = resolve(dist, `.${relative}`)
    if (!target.startsWith(dist)) { response.writeHead(403).end(); return }
    try {
      response.setHeader('Content-Type', target.endsWith('.js') ? 'application/javascript' : 'text/html')
      response.end(readFileSync(target))
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind TCP')
  origin = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
}, 150_000)

afterAll(async () => {
  await browser?.close()
  if (server !== undefined) await new Promise<void>((done) => server.close(() => done()))
})

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__poolFixture?.ready(), null, { timeout: 30_000 })
}

describe('principal pool lifetime in Chromium', () => {
  it('resolves a cold issue chip with the network disabled and never calls the server resolver', async () => {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.goto(`${origin}/__pool_test?mobxSidebar=1&mobxChips=1`)
      await ready(page)
      await page.waitForSelector('#offline-reference-host [data-ref="POD-0"][data-issue-availability="unavailable"]', { state: 'attached' })
      // Observing the reference itself would warm it; inspect residency only.
      const before = await page.evaluate(() => {
        const state = window.__poolFixture.referenceState()
        return { cold: state.cold, resident: state.resident }
      })
      expect(before).toEqual({ cold: true, resident: false })
      await page.context().setOffline(true)
      expect(await page.evaluate(() => navigator.onLine)).toBe(false)
      const requests: string[] = []
      page.on('request', request => requests.push(request.url()))
      await page.evaluate(() => window.__poolFixture.mountReference())
      try {
        await page.waitForFunction(() =>
          document.querySelector('#offline-reference-host [data-ref="POD-1234"]')?.getAttribute('aria-label') ===
            'Archived Done task POD-1234: Cold offline issue',
        )
      } catch (cause) {
        const state = await page.evaluate(() => ({
          ...window.__poolFixture.referenceState(),
          html: document.getElementById('offline-reference-host')?.innerHTML,
          failures: window.__poolFixture.state().failures,
        }))
        throw new Error(JSON.stringify({ state, requests, errors }), { cause })
      }
      const after = await page.evaluate(() => window.__poolFixture.referenceState())
      expect(after).toEqual({ online: false, cold: false, resident: true,
        issueId: 'iss_offline_reference', serverCalls: 0 })
      expect(requests).toEqual([])
      expect(errors).toEqual([])
      if (process.env.ISSUE_REFERENCE_OFFLINE_SHOT) {
        await page.evaluate(({ before, after, requests }) => {
          const heading = document.createElement('h1')
          heading.textContent = 'Cold issue chip resolved offline'
          const evidence = document.createElement('pre')
          evidence.textContent = JSON.stringify({ before, after, networkRequests: requests,
            label: document.querySelector('#offline-reference-host [data-ref="POD-1234"]')?.getAttribute('aria-label') }, null, 2)
          document.body.prepend(heading)
          document.body.append(evidence)
        }, { before, after, requests })
        await page.screenshot({ path: process.env.ISSUE_REFERENCE_OFFLINE_SHOT })
      }
    } finally {
      await page.close()
    }
  }, 60_000)

  it('releases the old pool and row object after a principal switch, rebuild and sign-out GC', async () => {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.goto(`${origin}/__pool_test?mobxSidebar=1`)
      await ready(page)
      const cdp = await page.context().newCDPSession(page)
      const heaps: number[] = []
      for (const step of ['switch', 'rebuild', 'sign-out'] as const) {
        await page.evaluate((change) => {
          window.__poolFixture.show(change === 'sign-out' ? null : 'fixture-bob', change === 'rebuild')
        }, step)
        if (step !== 'sign-out') await ready(page)
        // A new job clears WeakRef's keep-alive set before the external GC.
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)))
        await cdp.send('HeapProfiler.collectGarbage')
        const survivors = await page.evaluate(() => window.__poolFixture.survivors())
        expect(survivors, step).toEqual([])
        heaps.push((await cdp.send('Runtime.getHeapUsage')).usedSize)
      }
      expect(await page.evaluate(() => window.__poolFixture.state())).toEqual({
        replicas: 3, attachments: 3, pool: false, failures: [],
      })
      expect(errors).toEqual([])
      console.info('fixture Chromium GC: zero pool/model survivors after switch, rebuild, sign-out; heap bytes', heaps)
    } finally {
      await page.close()
    }
  }, 120_000)

  it('does not import the graph or MobX when the startup switch is off', async () => {
    const page = await browser.newPage()
    const graphRequests: string[] = []
    page.on('request', (request) => {
      if (/client-graph|runtime-pool|\/mobx(?:[_.\/]|$)/.test(request.url())) graphRequests.push(request.url())
    })
    try {
      await page.goto(`${origin}/__pool_test?mobxSidebar=0`)
      await ready(page)
      expect(await page.evaluate(() => window.__poolFixture.state())).toEqual({
        replicas: 1, attachments: 1, pool: false, failures: [],
      })
      expect(graphRequests).toEqual([])
    } finally {
      await page.close()
    }
  }, 60_000)
})
