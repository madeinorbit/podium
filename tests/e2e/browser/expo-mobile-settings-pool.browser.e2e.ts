import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium proof',
)
test.setTimeout(180_000)
test.use({ serviceWorkers: 'block' })

async function launch(page: Page) {
  await page.goto(`/mobile/settings?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Settings', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Sync cursor')).toBeVisible({ timeout: 60_000 })
}
async function value(page: Page, label: string) {
  return (await page.getByText(label, { exact: true }).locator('..').innerText())
    .slice(label.length)
    .trim()
}

test('the production phone Settings preserves diagnostic rows after the pool attaches', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await launch(page)
  await expect.poll(() => value(page, 'Sync cursor'), { timeout: 30_000 }).not.toBe('none')
  const labels = [
    'Visible fleet',
    'Updates',
    'Sessions',
    'Tasks',
    'Conversations',
    'Queued sends',
    'Needs recovery',
  ]
  const before = await Promise.all(labels.map((label) => value(page, label)))
  await expect(page.getByLabel('MobX pilot', { exact: true })).toHaveCount(0)
  await launch(page)
  await expect.poll(() => value(page, 'Sync cursor'), { timeout: 30_000 }).not.toBe('none')
  await expect
    .poll(() => Promise.all(labels.map((label) => value(page, label))), { timeout: 30_000 })
    .toEqual(before)
  expect(errors).toEqual([])
  const artifacts = resolve('.artifacts/mobile-settings')
  mkdirSync(artifacts, { recursive: true })
  await page.screenshot({ path: resolve(artifacts, 'settings-pool.png'), fullPage: true })
})
