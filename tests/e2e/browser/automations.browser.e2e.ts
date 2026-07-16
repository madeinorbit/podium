/**
 * Verifies the desktop header nav links (Issues / Automations) and the Automations
 * view — now a REAL backend surface (#470) [spec:SP-17db], not the seeded prototype
 * this spec used to assert. The load-bearing assertion is the one the mock could
 * never pass: a created automation SURVIVES A RELOAD.
 */
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop automation-library test')

test('desktop header links + a scheduled automation that persists', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('podium.view', 'home')
  })
  await page.goto(`/?server=${RELAY}&e2e=1`)
  const header = page.getByTestId('desktop-topbar')
  await expect(header).toBeVisible({ timeout: 60_000 })

  // Both preserved destinations are present in the redesigned desktop header.
  const issuesLink = header.getByRole('button', { name: 'Issues', exact: true })
  const automationsLink = header.getByRole('button', { name: 'Automations', exact: true })
  await expect(issuesLink).toBeVisible()
  await expect(automationsLink).toBeVisible()

  // Issues link opens the existing issues view.
  await issuesLink.click()
  await expect(issuesLink).toHaveAttribute('aria-current', 'page')

  // Automations link opens the automations view.
  await automationsLink.click()
  await expect(automationsLink).toHaveAttribute('aria-current', 'page')
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

  // Edit through the real action: exact cron prefill is preserved and session mode
  // changes ride the durable metadata rail back into the card without a refetch.
  await view.getByRole('button', { name: 'Edit Nightly test sweep' }).click()
  const editDialog = page.getByRole('dialog')
  await expect(editDialog.getByText('Edit automation')).toBeVisible()
  await expect(editDialog.getByLabel('Cron expression')).toHaveValue('0 9 * * 1')
  await expect(editDialog.getByLabel('Session mode')).toContainText(
    'Fresh issue and session each run',
  )
  await editDialog.getByLabel('Session mode').click()
  await page.getByRole('option', { name: 'Resume the previous session' }).click()
  await editDialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(editDialog).toBeHidden()
  await expect(view.getByText('Resume previous session', { exact: false })).toBeVisible()

  // ── The assertion the mock could never make: it survives a reload ──────────
  await page.reload()
  await expect(header).toBeVisible({ timeout: 20_000 })
  await header.getByRole('button', { name: 'Automations', exact: true }).click()
  await expect(view.getByText('Nightly test sweep', { exact: true })).toBeVisible()
  await expect(view.getByText('Resume previous session', { exact: false })).toBeVisible()

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

test('a one-off automation persists its exact future run', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('podium.view', 'home')
  })
  await page.goto(`/?server=${RELAY}&e2e=1`)

  const header = page.getByTestId('desktop-topbar')
  await expect(header).toBeVisible({ timeout: 60_000 })
  await header.getByRole('button', { name: 'Automations', exact: true }).click()

  const view = page.getByRole('region', { name: 'Automations' })
  await view.getByRole('button', { name: 'New automation' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill('Quota wakeup')
  await dialog.getByLabel('Task prompt').fill('Continue the queued overnight work.')
  await dialog.getByRole('combobox').first().click()
  await page.getByRole('option', { name: 'One time' }).click()

  const future = new Date(Date.now() + 24 * 60 * 60 * 1_000)
  const two = (value: number): string => String(value).padStart(2, '0')
  const runAt = `${future.getFullYear()}-${two(future.getMonth() + 1)}-${two(future.getDate())}T${two(future.getHours())}:${two(future.getMinutes())}`
  await dialog.getByLabel('Run at').fill(runAt)
  await expect(dialog.getByText('will run once', { exact: false })).toBeVisible()
  await dialog.getByLabel('Target').click()
  await page.getByRole('option', { name: 'Global (home directory)' }).click()
  await dialog.getByRole('button', { name: 'Create automation' }).click()

  await expect(dialog).toBeHidden()
  await expect(view.getByText('Quota wakeup', { exact: true })).toBeVisible()
  await expect(view.getByText('One-off', { exact: true })).toBeVisible()
  await expect(view.getByText('One time at', { exact: false })).toBeVisible()
  await expect(view.getByText('Next run:', { exact: false })).toBeVisible()
  await expect(view.getByText(/Next run:.*Fresh session/)).toBeVisible()

  await page.reload()
  await expect(header).toBeVisible({ timeout: 20_000 })
  await header.getByRole('button', { name: 'Automations', exact: true }).click()
  await expect(view.getByText('Quota wakeup', { exact: true })).toBeVisible()
  await view.getByRole('button', { name: 'Edit Quota wakeup' }).click()
  await expect(page.getByRole('dialog').getByLabel('Run at')).toHaveValue(runAt)
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

  await view.getByRole('button', { name: 'Delete Quota wakeup' }).click()
  await expect(view.getByText('Quota wakeup', { exact: true })).toHaveCount(0)
})
