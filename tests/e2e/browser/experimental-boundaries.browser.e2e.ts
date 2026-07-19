import { expect, test } from '@playwright/test'
import { openApp } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop experimental-boundary test')
test.setTimeout(180_000)

test('enabled experimental chrome drives each real surface', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openApp(page)

  const search = page.getByRole('button', { name: 'Search', exact: true })
  await expect(search).toBeVisible()
  await search.click()
  const palette = page.locator('[aria-label="Command palette"]')
  await expect(palette).toBeVisible()
  await palette.getByRole('combobox').press('Escape')

  const split = page.getByRole('button', { name: 'Split', exact: true })
  await expect(split).toBeVisible()
  await split.click()
  await expect(page.getByText('Pick a panel for this pane:', { exact: true })).toBeVisible()
  await split.click()
  await expect(page.getByText('Pick a panel for this pane:', { exact: true })).toBeHidden()

  const panels = page.getByRole('navigation', { name: 'Panels' })
  await panels.getByRole('button', { name: 'Git', exact: true }).click()
  const gitDock = page.locator('[data-right-dock-panel="git"]')
  await expect(gitDock).toBeVisible()
  await expect(gitDock.getByText('Git — coming soon', { exact: true })).toBeVisible()

  await panels.getByRole('button', { name: 'Messages', exact: true }).click()
  await expect(page.locator('[data-right-dock-panel="mail"]')).toBeVisible()

  const primary = page.getByRole('navigation', { name: 'Primary' })
  const workflows = primary.getByRole('button', { name: 'Workflows', exact: true })
  const specs = primary.getByRole('button', { name: 'Specs', exact: true })
  const automations = primary.getByRole('button', { name: 'Automations', exact: true })

  await workflows.click()
  await expect(workflows).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible()

  await specs.click()
  await expect(specs).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText('Specs', { exact: true }).last()).toBeVisible()

  await automations.click()
  await expect(automations).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('region', { name: 'Automations' })).toBeVisible()

  await page
    .getByRole('complementary')
    .getByRole('button', { name: 'Settings', exact: true })
    .click()
  const settings = page.getByRole('region', { name: 'Settings' })
  await expect(settings).toBeVisible()
  const notifications = settings.getByRole('button', {
    name: 'Notifications',
    exact: true,
  })
  await expect(notifications).toBeVisible({ timeout: 30_000 })
  await notifications.click()
  await expect(notifications).toHaveAttribute('aria-current', 'true')
})
