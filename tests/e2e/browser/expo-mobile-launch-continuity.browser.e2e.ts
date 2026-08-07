import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium launch proof',
)
test.setTimeout(180_000)

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-503')
const RELAY = process.env.PODIUM_RELAY ?? `ws://localhost:${Number(process.env.PORT ?? 8799)}`
const DEAD_SERVER = 'ws://127.0.0.1:1'
const AUTH_STATUS = { needsAuth: false, authed: true, userId: 'user:sole' }

test.beforeAll(() => mkdirSync(ARTIFACTS, { recursive: true }))

test('a slow cold launch has one uninterrupted brand transition', async ({ page }) => {
  await page.addInitScript(() => {
    const seen = new WeakSet<Element>()
    const probe = { mounts: 0, maxAtOnce: 0 }
    ;(globalThis as unknown as { __launchProbe: typeof probe }).__launchProbe = probe
    const sample = () => {
      const current = [...document.querySelectorAll('[aria-label="Podium"]')]
      for (const element of current) {
        if (seen.has(element)) continue
        seen.add(element)
        probe.mounts += 1
      }
      probe.maxAtOnce = Math.max(probe.maxAtOnce, current.length)
    }
    new MutationObserver(sample).observe(document, { childList: true, subtree: true })
  })
  await page.route('**/auth/status', async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500))
    await route.continue()
  })

  await page.goto(`/mobile?server=${RELAY}`)
  await expect(page.getByLabel('Podium')).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: resolve(ARTIFACTS, '01-slow-server-brand.png'), fullPage: true })
  await expect(page.getByRole('button', { name: 'New work' })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByLabel('Podium')).toHaveCount(0)

  const probe = await page.evaluate(
    () =>
      (globalThis as unknown as { __launchProbe: { mounts: number; maxAtOnce: number } })
        .__launchProbe,
  )
  expect(probe).toEqual({ mounts: 1, maxAtOnce: 1 })
  await page.screenshot({ path: resolve(ARTIFACTS, '02-cold-first-frame.png'), fullPage: true })
})

test('a cold offline launch paints the Work silhouette, never its empty state', async ({
  page,
}) => {
  await page.route('http://127.0.0.1:1/auth/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AUTH_STATUS),
    }),
  )
  await page.goto(`/mobile?server=${encodeURIComponent(DEAD_SERVER)}`)

  await expect(page.getByLabel('Loading work')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/No work yet/)).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe('/mobile/work')
  await page.screenshot({
    path: resolve(ARTIFACTS, '03-cold-offline-skeleton.png'),
    fullPage: true,
  })
})

test('a warm and then offline launch paint cached task detail first', async ({ page }) => {
  await page.goto(`/mobile?server=${RELAY}`)
  await expect(page.getByRole('button', { name: 'New work' })).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Tasks' }).click()
  await page.getByRole('button', { name: 'New task' }).click()
  await expect(page.getByLabel(/^Repository /).first()).toBeVisible({ timeout: 30_000 })

  const title = `Launch cache ${Date.now()}`
  await page.getByLabel('Task title').fill(title)
  await page.getByRole('button', { name: 'Agent will start now' }).click()
  await page.getByRole('button', { name: 'Create task' }).click()
  await expect(page.getByText(title, { exact: false })).toBeVisible({ timeout: 30_000 })

  await page.reload()
  await expect(page.getByText(title, { exact: false })).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: resolve(ARTIFACTS, '04-warm-cached-detail.png'), fullPage: true })

  await page.route('http://127.0.0.1:1/auth/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AUTH_STATUS),
    }),
  )
  const offline = new URL(page.url())
  offline.searchParams.set('server', DEAD_SERVER)
  await page.goto(offline.href)

  await expect(page.getByText(title, { exact: false })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel('Loading task detail')).toHaveCount(0)
  await page.screenshot({
    path: resolve(ARTIFACTS, '05-offline-cached-detail.png'),
    fullPage: true,
  })
})
