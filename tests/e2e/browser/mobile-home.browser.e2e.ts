import { expect, test } from '@playwright/test'
import { openApp } from './_harness'

/**
 * #227: the mobile home view is the sidebar work list (WORK rows, spawn button,
 * app tools), and the header's one dropdown lists the panels of the selected
 * issue — no worktree picker.
 *
 * Deliberately does NOT use `newSession`: that helper waits on the `__podium`
 * terminal test API, which the mobile panel doesn't expose here (already true
 * on main). `openApp` spawns an agent through the home work list, which is
 * exactly the surface under test.
 */
test.skip(({ isMobile }) => !isMobile, 'mobile layout only')
// Cold start (relay boot + first agent spawn) eats most of the default budget.
test.setTimeout(120_000)

test('mobile home is the work list, and the header dropdown lists issue panels', async ({
  page,
}) => {
  await openApp(page) // spawns an agent by clicking the home list's `New … in …`

  // Home: the sidebar's work list, not the Command center board.
  await page.locator('button[title="Work"]').click()
  // #41: the WORK header gave way to always-on project group labels.
  await expect(page.getByTestId('project-group-label').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-testid="unified-issue-row"]').first()).toBeVisible()
  await expect(page.getByRole('button', { name: /^New .+ in .+/ })).toBeVisible()
  await expect(page.getByLabel('Add repo')).toBeVisible()
  await expect(page.getByText('Command center')).toHaveCount(0)
  // The retired worktree sheet is gone.
  await expect(page.getByText('WORKTREES')).toHaveCount(0)

  // Back into the workspace through a work row, then open the panel dropdown:
  // it lists the selected issue's panels, each with pin + kill.
  await page
    .locator('[data-testid="unified-issue-row"]')
    .first()
    .locator('button.flex-1')
    .first()
    .click()
  await page.getByLabel('Select panel').click({ timeout: 15_000 })
  const menu = page.locator('div.z-30')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('button', { name: 'Pin panel' }).first()).toBeVisible()
  expect(await menu.locator('button[title="Kill session"]').count()).toBeGreaterThanOrEqual(1)
})
