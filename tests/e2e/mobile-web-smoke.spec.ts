import { expect, test, type Page } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL

if (!baseURL) {
  throw new Error('Set PLAYWRIGHT_BASE_URL to the Podium backend URL before running this smoke.')
}

test.use({
  baseURL,
  viewport: { width: 390, height: 844 },
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
})

function capturePageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function expectMobileRoute(page: Page): Promise<void> {
  await page.waitForURL(
    (url) => url.pathname === '/mobile' || url.pathname.startsWith('/mobile/'),
    { timeout: 30_000 },
  )
}

test('mobile web is served through the backend with desktop escape', async ({ page }) => {
  const pageErrors = capturePageErrors(page)

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expectMobileRoute(page)
  await expect(page).toHaveTitle(/Podium Mobile/i)
  await expect(page.getByText('Focus', { exact: true })).toBeVisible({ timeout: 30_000 })

  await page.goto('/mobile/settings', { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Settings', { exact: true })).toBeVisible()
  const desktopEscape = page.getByRole('button', { name: 'Open desktop' })
  await expect(desktopEscape).toBeVisible()

  await page.goto('/mobile/session/podium-mobile-smoke-missing', {
    waitUntil: 'domcontentloaded',
  })
  await expect(page.getByText('Session not found.')).toBeVisible()

  await page.goto('/mobile/session/podium-mobile-smoke-missing/terminal', {
    waitUntil: 'domcontentloaded',
  })
  await expect(page.getByText('Session', { exact: true })).toBeVisible()
  await expect(page.locator('body')).not.toContainText(/Podium could not start|Application error/i)

  await page.goto('/mobile/settings', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Open desktop' }).click()
  await page.waitForURL((url) => url.pathname === '/', { timeout: 30_000 })
  await expect(page).toHaveTitle(/^Podium$/)

  expect(pageErrors).toEqual([])
})
