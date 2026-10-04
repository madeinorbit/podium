import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/** Every production phone launch attaches one pool, without a setting or URL switch. */
test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium proof',
)
test.setTimeout(180_000)
test.use({ serviceWorkers: 'block' })
async function launch(page: Page, override = '') {
  const chunks: string[] = []
  const track = (request: import('@playwright/test').Request) => {
    if (/\/runtime-pool-[^/]*\.js$/.test(new URL(request.url()).pathname))
      chunks.push(request.url())
  }
  page.on('request', track)
  try {
    await page.goto(`/mobile/settings?server=${RELAY}${override}`, {
      waitUntil: 'domcontentloaded',
    })
    await expect(page.getByText('Sync cursor')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByLabel('MobX pilot', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Experimental', { exact: true })).toHaveCount(0)
    await expect.poll(() => chunks.length, { timeout: 30_000 }).toBe(1)
  } finally {
    page.off('request', track)
  }
}
test('the release phone always builds one pool, including obsolete OFF URL overrides', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await launch(page)
  await launch(page, '&mobxMobile=0&mobxSidebar=0&mobx=off')
  expect(errors).toEqual([])
})
