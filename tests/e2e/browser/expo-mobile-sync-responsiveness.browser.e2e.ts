import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium sync-boundary proof',
)
test.setTimeout(120_000)

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-1421')

test.beforeAll(() => mkdirSync(ARTIFACTS, { recursive: true }))

test('cold blocks intentionally; warm catch-up remains navigable', async ({ page }) => {
  await page.goto('/mobile/work?demo=1&syncDemo=cold')
  await expect(page.getByTestId('boot-splash')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/LOADING WORKSPACE/)).toBeVisible()
  await expect(page.getByText('638 of 1,024 items')).toBeVisible()
  await expect(page.getByRole('button', { name: 'New work' })).not.toBeVisible()
  await page.screenshot({ path: resolve(ARTIFACTS, 'cold-sync.png'), fullPage: true })

  await page.goto('/mobile/work?demo=1&syncDemo=warm')
  const warmStatus = page.getByTestId('warm-sync-status')
  await expect(warmStatus).toBeVisible({ timeout: 30_000 })
  await expect(warmStatus).toContainText('Updating')
  await expect(page.getByTestId('warm-sync-status-host')).toHaveCSS('pointer-events', 'none')

  // This is the real browser hit-test boundary: the status remains on screen
  // while a control beneath its global layer still receives the tap.
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page).toHaveURL(/\/mobile\/issues(?:\?|$)/)
  await expect(warmStatus).toBeVisible()
  await page.screenshot({ path: resolve(ARTIFACTS, 'warm-sync.png'), fullPage: true })
})
