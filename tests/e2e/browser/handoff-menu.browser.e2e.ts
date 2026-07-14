import { expect, test } from '@playwright/test'
import { openApp } from './_harness'

test.skip(
  ({ isMobile }) => isMobile || process.env.PODIUM_E2E_HANDOFF !== '1',
  'dedicated desktop handoff harness',
)

test('Handoff flyout lists and invokes an eligible target machine', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openApp(page)

  const tab = page.locator('[data-session]').last()
  await expect(tab).toBeVisible()
  await tab.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Session actions' })
  const trigger = menu.getByRole('menuitem', { name: 'Handoff', exact: true })
  await expect(menu).toBeVisible()
  await expect(trigger).toBeVisible()
  await trigger.hover()

  const targets = page.getByRole('menu', { name: 'Handoff targets' })
  const target = targets.getByRole('menuitem', { name: 'E2E Target', exact: true })
  await expect(target).toBeVisible()
  await target.click()
  await expect(menu).toBeHidden()
  // Keyecho deliberately has no native resume ref; reaching this server error proves
  // the real menu click invoked sessions.handoff instead of being a decorative flyout.
  await expect(page.locator('[data-sonner-toast]')).toContainText('session has no resume reference')
})
