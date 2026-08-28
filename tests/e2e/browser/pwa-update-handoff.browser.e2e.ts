import { readFileSync, writeFileSync } from 'node:fs'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

const OLD_VERSION = 'dev+pwa-old'
const NEW_VERSION = 'dev+pwa-new'

const WAITING_OPERATION = {
  id: 'op_pwa_handoff',
  kind: 'update',
  details: { target: { version: NEW_VERSION, channel: 'dev' } },
  state: 'waiting',
  createdBy: 'user',
  startedAt: Date.now() - 10_000,
  updatedAt: Date.now(),
  finishedAt: null,
  steps: [
    { id: 'prepare', title: 'Preparing the update', state: 'done' },
    { id: 'server', title: 'Updating your server', state: 'done' },
    { id: 'web', title: 'Serving the new app', state: 'done' },
  ],
  awaiting: [{ id: 'reload', surface: 'web', title: 'Reload this page' }],
  deferred: [],
  error: null,
}

const dist = new URL('../../../apps/web/dist/', import.meta.url)
const indexUrl = new URL('index.html', dist)
const swUrl = new URL('sw.js', dist)

type TrpcEntry = {
  result?: Record<string, unknown>
}
type ServedFile = {
  url: URL
  bytes: Buffer
}

function servedFiles(url: URL): ServedFile[] {
  return [url, new URL(`${url.pathname}.br`, url), new URL(`${url.pathname}.gz`, url)].map(
    (candidate) => ({ url: candidate, bytes: readFileSync(candidate) }),
  )
}

function writeServed(url: URL, body: string): void {
  const bytes = Buffer.from(body)
  writeFileSync(url, bytes)
  writeFileSync(new URL(`${url.pathname}.br`, url), brotliCompressSync(bytes))
  writeFileSync(new URL(`${url.pathname}.gz`, url), gzipSync(bytes))
}

function indexBuild(source: string, version: string, marker: string): string {
  return source
    .replace(
      /<meta name="podium-version" content="[^"]+">/,
      `<meta name="podium-version" content="${version}">`,
    )
    .replace('<head>', `<head><meta name="pwa-handoff-build" content="${marker}">`)
}

function workerBuild(source: string, marker: string, activationDelayMs = 0): string {
  const withRevision = source.replace(
    /\{url:"index\.html",revision:"[^"]+"\}/,
    `{url:"index.html",revision:"pwa-handoff-${marker}"}`,
  )
  return `${withRevision}\n${
    activationDelayMs > 0
      ? `self.addEventListener('activate',event=>event.waitUntil(new Promise(resolve=>setTimeout(resolve,${activationDelayMs}))));`
      : ''
  }\n`
}

test('one Reload waits for the real replacement worker and opens the new shell', async ({
  page,
  browserName,
  isMobile,
}) => {
  test.skip(browserName !== 'chromium' || isMobile, 'This proof targets the desktop Chromium PWA.')

  test.setTimeout(60_000)
  const originals = [...servedFiles(indexUrl), ...servedFiles(swUrl)]
  const originalIndex = originals.find(({ url }) => url.pathname.endsWith('/index.html'))!.bytes
  const originalWorker = originals.find(({ url }) => url.pathname.endsWith('/sw.js'))!.bytes

  writeServed(indexUrl, indexBuild(originalIndex.toString(), OLD_VERSION, 'old'))
  writeServed(swUrl, workerBuild(originalWorker.toString(), 'old'))

  await page.route('**/version', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        appVersion: NEW_VERSION,
        target: { version: NEW_VERSION, critical: false, artifacts: {} },
      }),
    })
  })
  let activeReads = 0
  let operationFinished = false
  await page.route('**/trpc/**', async (route) => {
    const procedurePath = new URL(route.request().url()).pathname.split('/trpc/')[1] ?? ''
    const procedures = decodeURIComponent(procedurePath).split(',')
    const targets = procedures.some((procedure) =>
      ['operations.active', 'operations.history', 'updates.fleet'].includes(procedure),
    )
    if (!targets) {
      await route.fallback()
      return
    }

    const upstream = await route.fetch()
    const upstreamBody = (await upstream.json()) as TrpcEntry[]
    const patched = procedures.map((procedure, index) => {
      const current = upstreamBody[index] ?? {}
      const withData = (data: unknown): TrpcEntry => ({
        ...current,
        result: { ...current.result, data },
      })
      if (procedure === 'operations.active') {
        activeReads += 1
        return withData(operationFinished ? null : WAITING_OPERATION)
      }
      if (procedure === 'operations.history') return withData([])
      if (procedure === 'updates.fleet') {
        return withData({
          total: 0,
          behind: 0,
          converging: 0,
          failed: 0,
          targetVersion: NEW_VERSION,
          machines: [],
        })
      }
      return current
    })
    await route.fulfill({
      response: upstream,
      contentType: 'application/json',
      body: JSON.stringify(patched),
    })
  })

  try {
    await page.goto(`/?server=${RELAY}&e2e=1`)
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve) =>
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
            once: true,
          }),
        )
      }
    })
    await page.reload()
    expect(await page.locator('meta[name="pwa-handoff-build"]').getAttribute('content')).toBe('old')

    // This is a genuine production service-worker update: the generated
    // Workbox worker installs a different index revision and waits. Holding its
    // activate event beyond the old 2 s fallback makes the race deterministic.
    writeServed(indexUrl, indexBuild(originalIndex.toString(), NEW_VERSION, 'new'))
    writeServed(swUrl, workerBuild(originalWorker.toString(), 'new', 4_000))
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready
      await registration.update()
      if (registration.waiting) return
      await new Promise<void>((resolve, reject) => {
        const installing = registration.installing
        if (!installing) return reject(new Error('replacement worker did not start installing'))
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed') resolve()
          if (installing.state === 'redundant') {
            reject(new Error('replacement worker became redundant during installation'))
          }
        })
      })
      if (!registration.waiting) throw new Error('replacement worker never entered waiting')
    })
    expect(activeReads).toBeGreaterThan(0)

    const panel = page.getByRole('dialog', { name: 'Podium update' })
    const reload = panel.getByRole('button', { name: 'Reload', exact: true })
    await expect(reload).toBeVisible({ timeout: 30_000 })
    expect(
      await page.evaluate(async () => {
        return (await navigator.serviceWorker.getRegistration())?.waiting?.state ?? null
      }),
    ).toBe('installed')

    let navigations = 0
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations += 1
    })
    const firstDocument = page.waitForResponse(
      (response) =>
        response.request().isNavigationRequest() && response.frame() === page.mainFrame(),
    )
    const navigated = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame())
    await reload.click()
    operationFinished = true
    const firstHtml = await (await firstDocument).text()
    expect(firstHtml).toContain('<meta name="pwa-handoff-build" content="new">')
    await navigated
    await page.waitForLoadState('domcontentloaded')

    // Read immediately after the FIRST navigation. A polling assertion could
    // accidentally pass after a second navigation and recreate the old guard
    // that could not go red.
    expect(await page.locator('meta[name="pwa-handoff-build"]').getAttribute('content')).toBe('new')
    expect(await page.locator('meta[name="podium-version"]').getAttribute('content')).toBe(
      NEW_VERSION,
    )
    await page.waitForTimeout(1_000)
    expect(navigations).toBe(1)
    await expect(panel).toHaveCount(0, { timeout: 30_000 })
    await expect(page.getByTestId('wire-skew-banner')).toHaveCount(0)
  } finally {
    await page
      .evaluate(async () => {
        for (const registration of await navigator.serviceWorker.getRegistrations()) {
          await registration.unregister()
        }
        for (const key of await caches.keys()) await caches.delete(key)
      })
      .catch(() => undefined)
    for (const { url, bytes } of originals) writeFileSync(url, bytes)
  }
})
