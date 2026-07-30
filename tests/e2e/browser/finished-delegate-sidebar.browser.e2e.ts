import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop sidebar verification')
test('a parked finished delegate reads finished, never paused', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  const aside = page.locator('aside').first()
  await aside.waitFor({ state: 'visible', timeout: 60_000 })
  const issueRow = aside
    .getByTestId('unified-issue-row')
    .filter({ hasText: 'Finished delegate decay' })
    .first()
  await expect(issueRow).toBeVisible({ timeout: 30_000 })
  const delegate = issueRow.locator('[data-session]').filter({
    hasText: 'Finished relay delegate A',
  })
  await expect(delegate).toBeVisible()
  await expect(delegate.getByTestId('session-outcome-chip')).toHaveText('finished')
  await expect(issueRow.getByText('paused', { exact: true })).toHaveCount(0)
})
