import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium proof',
)
test.setTimeout(120_000)

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-500')

test('Expo opens on Work and keeps decisions in their source context', async ({ page }) => {
  mkdirSync(ARTIFACTS, { recursive: true })
  await page.goto('/mobile?demo=1')

  await expect(page).toHaveURL(/\/mobile\/work(?:\?|$)/, { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Work', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Super agent', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Tray', exact: true })).toHaveCount(0)
  await page.screenshot({ path: resolve(ARTIFACTS, 'mobile-work-home.png'), fullPage: true })

  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.getByRole('button', { name: 'Issue 87: OAuth refresh loop logs users out' }).click()
  await expect(page.getByTestId('issue-question-card')).toContainText(
    'Should refresh tokens rotate on every use, or only on expiry?',
  )
  await page.screenshot({ path: resolve(ARTIFACTS, 'mobile-task-question.png'), fullPage: true })
  await page.getByRole('button', { name: 'Answer in session' }).click()
  await expect(page).toHaveURL(/\/mobile\/session\/demo-auth/, { timeout: 30_000 })

  await page.goto('/mobile/session/demo-perf?demo=1')
  const action = page.getByTestId('session-action-card')
  await expect(action).toContainText('Login screen ready to merge')
  await action.getByRole('button', { name: 'Send back…' }).click()
  await expect(action.getByLabel('Send back… feedback')).toBeVisible()
  await action.getByLabel('Send back… feedback').fill('Keep the Work deep-link coverage.')
  await page.screenshot({ path: resolve(ARTIFACTS, 'mobile-session-offer.png'), fullPage: true })
})
