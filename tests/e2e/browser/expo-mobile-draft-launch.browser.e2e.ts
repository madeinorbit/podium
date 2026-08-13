import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium proof',
)
test.setTimeout(120_000)

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-1087')
const TRACKED_TASK_ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-1096')

async function openPicker(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`/mobile?server=${RELAY}&e2e=1`)
  await expect(page.getByRole('button', { name: 'New work' })).toBeVisible({
    timeout: 60_000,
  })
  const newWork = page.getByRole('button', { name: 'New work' })
  const title = page.getByText('New work', { exact: true })
  await expect(async () => {
    if (!(await title.isVisible())) await newWork.click()
    await expect(title).toBeVisible({ timeout: 1_500 })
  }).toPass({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Model, Auto' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose project' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New task' })).toHaveCount(0)
}

test('Expo plus keeps tracked task creation on the Tasks tab', async ({ page }) => {
  mkdirSync(TRACKED_TASK_ARTIFACTS, { recursive: true })
  await openPicker(page)
  await page.screenshot({
    path: resolve(TRACKED_TASK_ARTIFACTS, 'mobile-new-work-picker.png'),
    fullPage: true,
  })
  await page.keyboard.press('Escape').catch(() => {})
  await page.getByRole('button', { name: 'Tasks' }).click()
  await page.getByRole('button', { name: 'New task' }).click()

  await expect(page).toHaveURL(/\/mobile\/new-issue(?:\?|$)/)
  await expect(page.getByText('New task', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Task title')).toBeVisible()
  await page.screenshot({
    path: resolve(TRACKED_TASK_ARTIFACTS, 'mobile-new-task-route.png'),
    fullPage: true,
  })
})

test('Expo plus launches inside a draft task through the desktop spawn path', async ({ page }) => {
  mkdirSync(ARTIFACTS, { recursive: true })
  await openPicker(page)
  await page.screenshot({ path: resolve(ARTIFACTS, 'mobile-harness-picker.png'), fullPage: true })

  await page.getByRole('button', { name: 'Choose project' }).click()
  await expect(page.getByText('Project', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'podium', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'podium', exact: true }).click()

  await expect(page).toHaveURL(/\/mobile\/session\//, { timeout: 30_000 })
  await expect(page.getByRole('button', { name: /Task POD-\d+ — peek/ })).toBeVisible({
    timeout: 30_000,
  })
  await page.screenshot({ path: resolve(ARTIFACTS, 'mobile-draft-session.png'), fullPage: true })
})

test('Expo plus exposes machine choice for a repository on multiple hosts', async ({ page }) => {
  mkdirSync(ARTIFACTS, { recursive: true })
  await openPicker(page)
  const machineField = page.getByRole('button', { name: /^Machine,/ })
  test.skip((await machineField.count()) === 0, 'requires PODIUM_E2E_MULTI_MACHINE=1')
  await machineField.click()

  await expect(page.getByText('Machine', { exact: true })).toBeVisible()
  const dialog = page.getByRole('dialog')
  const localMachine = dialog
    .getByRole('button')
    .filter({ hasNotText: /E2E Target|Back/ })
    .first()
  await expect(localMachine).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'E2E Target', exact: true })).toBeVisible()
  await page.screenshot({ path: resolve(ARTIFACTS, 'mobile-machine-picker.png'), fullPage: true })

  await localMachine.click()
  await page.getByRole('button', { name: 'Choose project' }).click()
  const shared = page.getByRole('button', { name: 'shared', exact: true })
  if ((await shared.count()) > 0) await shared.click()
  else await page.getByRole('button', { name: 'podium', exact: true }).click()
  await expect(page).toHaveURL(/\/mobile\/session\//, { timeout: 30_000 })
  await expect(page.getByRole('button', { name: /Task POD-\d+ — peek/ })).toBeVisible({
    timeout: 30_000,
  })
})
