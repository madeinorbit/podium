import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium proof',
)
test.setTimeout(180_000)

test('Expo mobile replica survives reload or surfaces degraded storage', async ({ page }) => {
  let blockFeed = false
  let blockedHttpRequests = 0

  // Keep the initial create and feed replication real. Once the task is visible,
  // cut both catch-up HTTP and the live socket so the reload can only succeed from
  // the OPFS-backed replica.
  await page.route(/\/trpc(?:\/|$)/, async (route) => {
    if (!blockFeed) {
      await route.continue()
      return
    }
    blockedHttpRequests += 1
    await route.abort()
  })
  await page.routeWebSocket(/\/client(?:\?|$)/, (websocket) => {
    if (blockFeed) {
      void websocket.close({ code: 1001, reason: 'local replica reload proof' })
      return
    }
    websocket.connectToServer()
  })

  const response = await page.goto(`/mobile?server=${RELAY}&e2e=1`, {
    waitUntil: 'domcontentloaded',
  })
  expect(response).not.toBeNull()
  expect(response?.headers()).toMatchObject({
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'credentialless',
    'cross-origin-resource-policy': 'same-origin',
  })
  await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toBeVisible({
    timeout: 60_000,
  })
  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          isolated: globalThis.crossOriginIsolated,
          sharedArrayBuffer: typeof globalThis.SharedArrayBuffer,
        })),
      { timeout: 30_000 },
    )
    .toEqual({ isolated: true, sharedArrayBuffer: 'function' })

  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.getByRole('button', { name: 'New task' }).click()
  await expect(page.getByLabel(/^Repository /).first()).toBeVisible({ timeout: 30_000 })

  const title = `Expo persistence reload ${Date.now()}`
  await page.getByLabel('Task title').fill(title)
  await page.getByRole('button', { name: 'Agent will start now' }).click()
  await page.getByRole('button', { name: 'Create task' }).click()

  await expect(page.getByText(title, { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Stage backlog — change' }).click()
  await page.getByRole('button', { name: 'planning', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stage planning — change' })).toBeVisible({
    timeout: 30_000,
  })
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'Work', exact: true }).click()
  const taskRow = page.getByRole('button', { name: new RegExp(title) })
  await expect(taskRow).toBeVisible({ timeout: 30_000 })

  blockFeed = true
  await page.reload({ waitUntil: 'domcontentloaded' })

  await expect(page.getByRole('button', { name: 'Work', exact: true })).toBeVisible({
    timeout: 60_000,
  })
  const storageNotice = page.getByText(
    /Offline entity storage is unavailable|Offline changes may not survive/,
  )
  let storageMode = 'loading'
  await expect
    .poll(
      async () => {
        storageMode = 'loading'
        if (await taskRow.isVisible()) storageMode = 'durable'
        else if (await storageNotice.isVisible()) storageMode = 'degraded'
        return storageMode
      },
      { timeout: 60_000 },
    )
    .toMatch(/durable|degraded/)
  if (storageMode === 'durable') await expect(taskRow).toBeVisible()
  else await expect(storageNotice).toBeVisible()
  console.log('[expo-mobile-persistence] reload storage mode: ' + storageMode)
  await expect.poll(() => blockedHttpRequests, { timeout: 30_000 }).toBeGreaterThan(0)
})
