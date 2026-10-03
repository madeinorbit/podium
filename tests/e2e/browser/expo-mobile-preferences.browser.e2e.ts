import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/** Saved settings and stage folds through the actual phone web export, with
 * the isolated harness's synthetic principal. Reload applies the pool switch.
 */
test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium preference proof',
)
test.setTimeout(180_000)
test.use({ serviceWorkers: 'block' })
const artifacts = resolve(import.meta.dirname, '../../../.artifacts/POD-5221')
test.beforeAll(() => mkdirSync(artifacts, { recursive: true }))

async function settings(page: Page): Promise<void> {
  await page.goto(`/mobile/settings?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Sync cursor')).toBeVisible({ timeout: 60_000 })
}

async function tasks(page: Page): Promise<void> {
  await page.goto(`/mobile/issues?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('button', { name: /^Backlog, \d+ tasks?$/ })).toBeVisible({
    timeout: 60_000,
  })
}

test('saved preferences survive the pool-on restart and return to the same legacy values', async ({
  page,
}) => {
  const http = RELAY.replace(/^ws/, 'http')
  const reposResponse = await page.request.get(`${http}/trpc/repos.list`)
  expect(reposResponse.ok(), await reposResponse.text()).toBe(true)
  const repos = (await reposResponse.json()) as { result: { data: string[] } }
  const repoPath =
    repos.result.data.find((repo) => repo.includes('zz-podium-e2e-repo-')) ?? repos.result.data[0]
  expect(repoPath).toBeDefined()
  // An empty task board has no stage headers. Seed only the isolated harness.
  const created = await page.request.post(`${http}/trpc/issues.create`, {
    data: { repoPath, title: 'Phone preference reload proof', startNow: false },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const issue = (await created.json()) as { result: { data: { id: string } } }
  const staged = await page.request.post(`${http}/trpc/issues.update`, {
    data: { id: issue.result.data.id, patch: { stage: 'backlog' } },
  })
  expect(staged.ok(), await staged.text()).toBe(true)
  const errors: string[] = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.log('[phone-preferences pageerror]', error.stack ?? error.message)
  })
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('[phone-preferences console]', message.text())
  })
  await settings(page)
  await expect(page.getByLabel('MobX pilot', { exact: true })).not.toBeChecked()
  await page.getByLabel('MobX pilot', { exact: true }).click()
  await expect(page.getByText('Applies at the next app start. This launch: off.')).toBeVisible()
  // Let the production AsyncStorage write-behind bridge reach durable storage.
  await page.waitForTimeout(2_000)
  await settings(page)
  await expect(page.getByLabel('MobX pilot', { exact: true })).toBeChecked()
  await expect(page.getByText('Applies at the next app start. This launch: on.')).toBeVisible()

  await tasks(page)
  const backlog = page.getByRole('button', { name: /^Backlog, \d+ tasks?$/ })
  await expect(backlog).toHaveAttribute('aria-expanded', 'true')
  await backlog.click()
  await expect(backlog).toHaveAttribute('aria-expanded', 'false')
  await page.waitForTimeout(2_000)
  await tasks(page)
  await expect(backlog).toHaveAttribute('aria-expanded', 'false')
  await page.screenshot({ path: resolve(artifacts, 'pool-saved-fold.png') })

  await settings(page)
  await page.getByLabel('MobX pilot', { exact: true }).click()
  await expect(page.getByLabel('MobX pilot', { exact: true })).not.toBeChecked()
  await expect(page.getByText('Applies at the next app start. This launch: on.')).toBeVisible()
  await page.waitForTimeout(2_000)
  await tasks(page)
  await expect(backlog).toHaveAttribute('aria-expanded', 'false')
  await backlog.click()
  await expect(backlog).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(2_000)
  await tasks(page)
  await expect(backlog).toHaveAttribute('aria-expanded', 'true')
  expect(errors).toEqual([])
})
