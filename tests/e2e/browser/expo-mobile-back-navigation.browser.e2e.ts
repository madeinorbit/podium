import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium proof',
)
test.setTimeout(120_000)

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-1291')

test('Expo session back preserves history and recovers from a direct load', async ({
  context,
  page,
}) => {
  await page.goto('/mobile/issues?demo=1')
  await page.getByRole('button', { name: 'Issue 87: OAuth refresh loop logs users out' }).click()
  await page.getByRole('button', { name: 'Fix OAuth token refresh' }).click()

  await expect(page).toHaveURL(/\/mobile\/session\/demo-auth/, { timeout: 30_000 })

  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page).toHaveURL(/\/mobile\/issue\/demo-issue-auth/)

  const directPage = await context.newPage()
  await directPage.goto('/mobile/session/demo-auth?demo=1')
  await expect(directPage.getByRole('button', { name: 'Back', exact: true })).toBeVisible({
    timeout: 30_000,
  })
  await directPage.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(directPage).toHaveURL(/\/mobile\/work(?:\?|$)/)
  await expect(directPage.getByText('Work', { exact: true }).first()).toBeVisible()

  mkdirSync(ARTIFACTS, { recursive: true })
  await directPage.screenshot({
    path: resolve(ARTIFACTS, 'mobile-session-back-fallback.png'),
    fullPage: true,
  })
})
