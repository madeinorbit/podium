/** Real-browser lifetime evidence belongs to the integration lane. */
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'

let server: ViteDevServer
let browser: Browser
let origin: string

beforeAll(async () => {
  const appRoot = fileURLToPath(new URL('..', import.meta.url))
  server = await createServer({
    configFile: false, root: appRoot,
    resolve: {
      conditions: ['@podium/source'], dedupe: ['react', 'react-dom'],
      alias: { '@': `${appRoot}/src` },
    },
    esbuild: { jsx: 'automatic' },
    server: { host: '127.0.0.1', port: 0 },
    optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'mobx', 'mobx-react-lite'] },
    plugins: [{
      name: 'private-pool-fixture',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith('/__pool_test')) return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<div id="root"></div><script type="module" src="/test/store-worklist-pool.browser.tsx"></script>')
        })
      },
    }],
  })
  await server.listen()
  const address = server.httpServer!.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind TCP')
  origin = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__poolFixture?.ready(), null, { timeout: 30_000 })
}

describe('principal pool lifetime in Chromium', () => {
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
      if (/client-graph|\/mobx(?:[_.\/]|$)/.test(request.url())) graphRequests.push(request.url())
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
