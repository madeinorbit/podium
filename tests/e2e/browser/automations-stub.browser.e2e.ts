/**
 * Verifies the Unified-sidebar nav links (Issues / Automations) and the
 * Automations prototype view: seeded deactivated cards, enable toggle, and the
 * New-automation composer (schedule cron preview, reactive trigger, create).
 */
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test('unified sidebar links + automations prototype', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('podium.view', 'home')
  })
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 20_000,
  })

  const sidebar = page.locator('aside').first()
  await sidebar.waitFor({ state: 'visible', timeout: 60_000 })

  // Both nav links present under the top action row.
  const issuesLink = sidebar.getByRole('button', { name: 'Issues', exact: true })
  const automationsLink = sidebar.getByRole('button', { name: 'Automations', exact: true })
  await expect(issuesLink).toBeVisible()
  await expect(automationsLink).toBeVisible()

  // Issues link opens the existing issues view.
  await issuesLink.click()
  await expect(issuesLink).toHaveAttribute('aria-pressed', 'true')

  // Automations link opens the new view.
  await automationsLink.click()
  await expect(automationsLink).toHaveAttribute('aria-pressed', 'true')
  const view = page.getByRole('region', { name: 'Automations' })
  await expect(view.getByRole('heading', { name: 'Automations' })).toBeVisible()

  // Seeded automations render, all deactivated.
  for (const name of [
    'Worktree cleanup',
    'Changelog update',
    'Stale issue nudge',
    'Dependency audit',
  ]) {
    await expect(view.getByText(name, { exact: true })).toBeVisible()
  }
  const cleanupToggle = view.getByRole('switch', { name: /Worktree cleanup/ })
  await expect(cleanupToggle).not.toBeChecked()
  await cleanupToggle.click()
  await expect(cleanupToggle).toBeChecked()

  // Expanding a card reveals its mock "Recent runs" list.
  await view.getByRole('button', { name: /Expand Worktree cleanup runs/ }).click()
  await expect(view.getByText('Pruned 3 worktrees', { exact: true })).toBeVisible()
  await expect(view.getByText('No changes needed', { exact: true })).toBeVisible()
  // A seeded automation without history shows the empty state.
  await view.getByRole('button', { name: /Expand Dependency audit runs/ }).click()
  await expect(view.getByText('No runs yet')).toBeVisible()

  // New-automation dialog: schedule cron preview reacts to frequency.
  await view.getByRole('button', { name: 'New automation' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('New automation')).toBeVisible()
  await dialog.getByLabel('Name').fill('Nightly test sweep')
  await expect(dialog.locator('code')).toHaveText('0 9 * * *') // daily 09:00 default
  await dialog.getByRole('combobox').first().click()
  await page.getByRole('option', { name: 'Weekly' }).click()
  await expect(dialog.locator('code')).toHaveText('0 9 * * 1') // Monday default

  // Reactive tab: trigger select + glob input for "File changed".
  await dialog.getByRole('tab', { name: 'Reactive loop' }).click()
  await dialog.getByRole('combobox').first().click()
  await page.getByRole('option', { name: 'File changed' }).click()
  await expect(dialog.getByLabel('Path glob')).toBeVisible()

  // Agent / Model / Thinking pickers with defaults.
  await expect(dialog.getByLabel('Agent')).toContainText('Claude Code')
  await expect(dialog.getByLabel('Model')).toContainText('Fable 5')
  await expect(dialog.getByLabel('Thinking')).toContainText('Medium')

  // Create appends a deactivated card and closes the dialog.
  await dialog.getByRole('button', { name: 'Create automation' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(view.getByText('Nightly test sweep', { exact: true })).toBeVisible()
  await expect(view.getByRole('switch', { name: /Nightly test sweep/ })).not.toBeChecked()
})
