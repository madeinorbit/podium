import { expect, test } from '@playwright/test'

test('built app reloads after one deferred chunk request fails', async ({ page }) => {
  let chunkRequests = 0
  let mainFrameNavigations = 0

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations += 1
  })
  await page.route('**/assets/MotionDemo-*.js', async (route) => {
    chunkRequests += 1
    if (chunkRequests === 1) {
      await route.fulfill({
        status: 404,
        contentType: 'text/javascript',
        body: 'deferred chunk intentionally unavailable',
      })
      return
    }
    await route.continue()
  })

  await page.goto('/?e2e=1&motion-demo=1', { waitUntil: 'commit' })

  await expect(page.getByRole('heading', { name: 'Motion primitives' })).toBeVisible({
    timeout: 20_000,
  })
  expect(chunkRequests).toBe(2)
  expect(mainFrameNavigations).toBe(2)
})
