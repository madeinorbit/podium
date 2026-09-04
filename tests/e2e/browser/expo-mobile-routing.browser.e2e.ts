import { expect, type Page, test } from '@playwright/test'

test.skip(({ isMobile }) => !isMobile, 'phone browser proof')
test.setTimeout(90_000)

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
  await expect(page.getByText('Inbox', { exact: true }).first()).toBeVisible({ timeout: 30_000 })

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
