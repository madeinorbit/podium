import { hostname } from 'node:os'
import { expect, test } from '@playwright/test'
import { openApp } from './_harness'

test.skip(({ isMobile }) => isMobile, 'the right dock is desktop chrome')

test('right-dock shell identifies its runtime machine', async ({ page }) => {
  await openApp(page)

  await page.getByRole('button', { name: 'Shell', exact: true }).click()
  const shellPanel = page.locator('[data-right-dock-panel="shell"]')
  await expect(shellPanel).toBeVisible()

  const machineBadge = shellPanel.getByLabel(`Running on ${hostname()}`)
  await expect(machineBadge).toBeVisible()
  await expect(machineBadge).toHaveText(hostname())
})
