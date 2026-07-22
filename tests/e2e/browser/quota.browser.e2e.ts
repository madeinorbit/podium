import { expect, test } from '@playwright/test'
import { openApp } from './_harness'

/**
 * Drives the real Live UI (built bundle + harness relay + a real local daemon —
 * see serve-harness.ts) so the header quota control is exercised end to end:
 * relay → daemon → the real Claude/Codex quota endpoints. It verifies that the
 * header renders independently scoped pool meters, hover opens the read-only
 * preview, click pins the same breakdown, and Escape dismisses it.
 */
test('agent quota: scoped header meters preview and pin the breakdown', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The scoped meter treatment belongs to the 44px desktop header.')
  await openApp(page)

  // The chip mounts only after the first quota payload arrives (real daemon →
  // live Claude/Codex). Generous wait for the network round-trips.
  const chip = page.getByRole('button', { name: /Agent quota/ })
  await expect(chip).toBeVisible({ timeout: 30_000 })

  const pools = chip.locator('.header-quota-pool')
  await expect(pools.first()).toBeVisible()
  await expect(pools).toHaveCount(2)
  await expect(chip.locator('.header-quota-pool-label')).toHaveText(['CC', 'CX'])

  await chip.hover()
  const panel = page.locator('.health-popover')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Agent quota')
  await expect(panel).toContainText('1 constrained · 1 healthy')
  await expect(panel).not.toHaveClass(/health-popover-pinned/)

  // A real click pins and expands the same anchored surface; it does not open a
  // centered dialog or replace the account/window content.
  await chip.click()
  await expect(panel).toHaveClass(/health-popover-pinned/)
  await expect(panel.locator('.hp-section').first()).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
})
