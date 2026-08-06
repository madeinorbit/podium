import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium proof',
)
test.setTimeout(120_000)

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-1291')
const VIEWPORT_ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-425')

test('Expo session keeps a long chat inside the phone viewport', async ({ page }) => {
  await page.goto('/mobile/session/demo-auth?demo=1')

  const composer = page.getByLabel('Message the agent…')
  await expect(composer).toBeVisible({ timeout: 30_000 })
  const geometry = await page.evaluate(() => {
    const scroller = [...document.querySelectorAll<HTMLElement>('*')]
      .filter((element) => element.scrollHeight > element.clientHeight + 1)
      .filter((element) => ['auto', 'scroll'].includes(getComputedStyle(element).overflowY))
      .sort(
        (left, right) =>
          right.scrollHeight - right.clientHeight - (left.scrollHeight - left.clientHeight),
      )[0]
    const input = document.querySelector<HTMLElement>('[aria-label="Message the agent…"]')
    if (!scroller || !input) throw new Error('chat viewport elements are unavailable')
    const inputRect = input.getBoundingClientRect()
    return {
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
      listHeight: scroller.clientHeight,
      listScrollHeight: scroller.scrollHeight,
      composerBottom: inputRect.bottom,
    }
  })

  expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.viewportHeight + 1)
  expect(geometry.listHeight).toBeLessThan(geometry.listScrollHeight)
  expect(geometry.composerBottom).toBeLessThanOrEqual(geometry.viewportHeight)
  expect(geometry.composerBottom).toBeGreaterThan(geometry.viewportHeight - 100)

  mkdirSync(VIEWPORT_ARTIFACTS, { recursive: true })
  await page.screenshot({
    path: resolve(VIEWPORT_ARTIFACTS, 'mobile-chat-viewport.png'),
    fullPage: true,
  })
})

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
