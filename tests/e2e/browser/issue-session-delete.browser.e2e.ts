import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * Real browser coverage for the issue/session lifecycle: the unified sidebar's
 * issue menu tombstones both its draft issue and session while stopping the
 * runtime; the tracker exposes the tombstone through Show deleted and restores
 * the session as an exited record. Removing that exited session then exercises
 * the standalone session-tombstone path through a real click.
 */
test.skip(({ isMobile }) => isMobile, 'desktop test (unified issue row lives in the aside)')

test('sidebar issue delete removes its sessions and the tracker can restore the tombstone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })

  const aside = page.locator('aside').first()
  await aside.waitFor({ state: 'visible', timeout: 60_000 })
  const rows = aside.getByTestId('unified-issue-row')
  if ((await rows.count()) === 0) {
    const spawn = aside.getByRole('button', { name: /^New .+ in .+/ })
    await expect(spawn).toBeEnabled({ timeout: 30_000 })
    await spawn.click()
  }
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })
  const before = await rows.count()
  const target = rows.first()

  await target.locator('button.flex-1').click({ button: 'right' })
  const issueMenu = page.locator('[role="menu"][aria-label="Issue actions"]')
  await expect(issueMenu).toBeVisible({ timeout: 10_000 })

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('Issues and sessions can be restored')
    void dialog.accept()
  })
  await issueMenu.getByRole('menuitem', { name: 'Delete', exact: true }).click()

  await expect.poll(async () => rows.count(), { timeout: 20_000 }).toBe(before - 1)
  await expect(aside.getByTestId('unified-worktree-row')).toHaveCount(0)
  await expect(
    aside.getByText('Nothing yet — start an agent or create an issue above.'),
  ).toBeVisible()

  // The app nav lives in the top bar since the shell relayout (#40/#41).
  await page.getByRole('button', { name: 'Issues', exact: true }).click({ timeout: 15_000 })
  const board = page.getByRole('region', { name: 'Issues' })
  await expect(board).toBeVisible({ timeout: 10_000 })
  await board.getByRole('button', { name: 'Filter', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Show deleted' }).click()
  await page.keyboard.press('Escape')

  const deletedCard = board
    .locator('[data-issue-id]')
    .filter({ has: page.getByText('Deleted', { exact: true }) })
    .first()
  await expect(deletedCard).toBeVisible({ timeout: 15_000 })
  await deletedCard.click({ button: 'right' })
  await expect(issueMenu).toBeVisible({ timeout: 10_000 })
  await expect(issueMenu.getByRole('menuitem', { name: 'Restore', exact: true })).toBeVisible()
  await expect(issueMenu.getByRole('menuitem', { name: 'Delete', exact: true })).toHaveCount(0)
  await issueMenu.getByRole('menuitem', { name: 'Restore', exact: true }).click()

  await expect(deletedCard).toHaveCount(0, { timeout: 15_000 })
  await expect(aside.getByTestId('unified-issue-row')).toHaveCount(before)
  await aside.getByTestId('unified-issue-row').first().locator('button.flex-1').click()
  await expect(
    page.getByText('The agent process is no longer running. Transcript is read-only.', {
      exact: true,
    }),
  ).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(
    page.getByText('The agent process is no longer running. Transcript is read-only.', {
      exact: true,
    }),
  ).toHaveCount(0, { timeout: 15_000 })

  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await expect(
    page.getByText('The agent process is no longer running. Transcript is read-only.', {
      exact: true,
    }),
  ).toHaveCount(0)
})
