import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'phone session layout proof',
)
test.use({ viewport: { width: 393, height: 659 } })

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-427')

test('phone chat spends the vertical budget on the transcript', async ({ page }) => {
  mkdirSync(ARTIFACTS, { recursive: true })

  await page.goto('/mobile/session/demo-perf?demo=1')
  await expect(page.getByLabel('Message the agent…')).toBeVisible({ timeout: 60_000 })

  await expect(page.getByRole('button', { name: 'Open terminal' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Chat view' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Native agent view' })).toHaveCount(0)

  const caption = page.getByTestId('composer-caption')
  await expect(caption).toBeVisible()
  await expect(caption).toHaveCSS('font-size', '11px')

  const composerBottom = await page
    .getByTestId('composer-bar')
    .evaluate((element) => Math.round(element.getBoundingClientRect().bottom))
  expect(composerBottom).toBeLessThanOrEqual(659)

  await page.screenshot({
    path: resolve(ARTIFACTS, 'phone-session-chat-659px.png'),
  })

  await page.getByRole('button', { name: 'Open terminal' }).click()
  await expect(page).toHaveURL(/\/mobile\/session\/demo-perf\/terminal(?:\?|$)/)
  await expect(page.getByRole('button', { name: 'Chat' })).toBeVisible()
})
