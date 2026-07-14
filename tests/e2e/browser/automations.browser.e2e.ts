/**
 * Verifies the Unified-sidebar nav links (Issues / Automations) and the Automations
 * view — now a REAL backend surface (#470) [spec:SP-17db], not the seeded prototype
 * this spec used to assert. The load-bearing assertion is the one the mock could
 * never pass: a created automation SURVIVES A RELOAD.
 */
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test('unified sidebar links + a scheduled automation that persists', async ({ page }) => {
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

  // Automations link opens the automations view.
  await automationsLink.click()
  await expect(automationsLink).toHaveAttribute('aria-pressed', 'true')
  const view = page.getByRole('region', { name: 'Automations' })
  await expect(view.getByRole('heading', { name: 'Automations' })).toBeVisible()

  // Both real halves are present; the mock cards ("Worktree cleanup" et al) are gone.
  await expect(view.getByRole('heading', { name: 'Notification triggers' })).toBeVisible()
  await expect(view.getByRole('heading', { name: 'Scheduled' })).toBeVisible()
  await expect(view.getByText('Worktree cleanup')).toHaveCount(0)
  await expect(view.getByText('No scheduled automations yet.', { exact: false })).toBeVisible()

  // ── Compose a real scheduled automation ────────────────────────────────────
  await view.getByRole('button', { name: 'New automation' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('New automation')).toBeVisible()
  await dialog.getByLabel('Name').fill('Nightly test sweep')
  await dialog.getByLabel('Task prompt').fill('Run the test suite and report what broke.')

  // The cron preview reacts to the frequency picker (daily 09:00 is the default).
  await expect(dialog.locator('code')).toHaveText('0 9 * * *')
  await dialog.getByRole('combobox').first().click()
  await page.getByRole('option', { name: 'Weekly' }).click()
  await expect(dialog.locator('code')).toHaveText('0 9 * * 1') // Monday default

  // Reactive is visibly unbuilt: the shape is there, Create is refused.
  await dialog.getByRole('tab', { name: 'Reactive loop' }).click()
  await expect(dialog.getByText('not yet wired to a runner', { exact: false })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Create automation' })).toBeDisabled()
  await dialog.getByRole('tab', { name: 'Schedule' }).click()

  // Target defaults to a repo; make it explicitly global so the spec never depends
  // on which repos the harness registered.
  await dialog.getByLabel('Target').click()
  await page.getByRole('option', { name: 'Global (home directory)' }).click()

  await dialog.getByRole('button', { name: 'Create automation' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()

  // The card is real: name, human schedule, global target, enabled.
  const card = view.getByText('Nightly test sweep', { exact: true })
  await expect(card).toBeVisible()
  await expect(view.getByText('Weekly on Monday at 09:00', { exact: false })).toBeVisible()
  await expect(view.getByText('Global (home directory)', { exact: false })).toBeVisible()
  const toggle = view.getByRole('switch', { name: /Nightly test sweep/ })
  await expect(toggle).toBeChecked()

  // ── The assertion the mock could never make: it survives a reload ──────────
  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 20_000,
  })
  await sidebar.getByRole('button', { name: 'Automations', exact: true }).click()
  await expect(view.getByText('Nightly test sweep', { exact: true })).toBeVisible()

  // Toggling persists too.
  const persisted = view.getByRole('switch', { name: /Nightly test sweep/ })
  await expect(persisted).toBeChecked()
  await persisted.click()
  await expect(view.getByRole('switch', { name: /Enable Nightly test sweep/ })).not.toBeChecked()

  // Expanding shows the REAL (empty) run history — no invented "Pruned 3 worktrees".
  await view.getByRole('button', { name: /Expand Nightly test sweep runs/ }).click()
  await expect(view.getByText('No runs yet')).toBeVisible()

  // Delete removes it for good.
  await view.getByRole('button', { name: 'Delete Nightly test sweep' }).click()
  await expect(view.getByText('Nightly test sweep', { exact: true })).toHaveCount(0)
  await expect(view.getByText('No scheduled automations yet.', { exact: false })).toBeVisible()
})
