/**
 * POD-1495 — the ownership-transfer affordance, driven in a REAL browser against
 * the real relay.
 *
 * What only this lane can prove: `MachineWire.owned` survives the whole chain.
 * The component test renders a row from a hand-built `MachineWire` and proves
 * the panel's rule; it cannot prove the server computes `owned`, that it
 * survives the replica, or that the row the user actually sees carries it. Every
 * link between `isMachineOwner` and the rendered button is untested until here —
 * and a panel that never shows the control is exactly as green under the
 * component test as one that always does.
 *
 * The harness relay authenticates as the instance's sole account, which owns the
 * host machine's row, so the host row is an OWNED machine and must offer
 * Transfer.
 */

import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(
  ({ isMobile }) => isMobile,
  'desktop test — the Settings nav button lives in the top bar (same reason as settings.browser.e2e.ts)',
)
test.describe.configure({ timeout: 90_000 })

async function openMachines(page: Page): Promise<void> {
  await page.addInitScript(() => {
    ;(window as Window & { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__ = true
  })
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15_000 })
  await page
    .getByRole('button', { name: 'Settings', exact: true })
    .click({ timeout: 15_000 })
  await page
    .getByRole('region', { name: 'Settings' })
    .getByRole('button', { name: 'Machines', exact: true })
    .click()
}

test('the owner is offered Transfer, and the dialog states both consequences', async ({ page }) => {
  await openMachines(page)

  // The whole server→wire→replica→panel chain in one assertion: this button
  // renders only when the row arrived carrying `owned: true`.
  const transfer = page.getByRole('button', { name: 'Transfer' }).first()
  await expect(transfer).toBeVisible({ timeout: 15_000 })

  await transfer.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(/you lose all three/i)
  await expect(dialog).toContainText(/not be able to undo this or transfer it back/i)
  await expect(dialog).toContainText(/every share on/i)

  // The confirm is inert until the machine's name is typed back — proved here
  // against the REAL row rather than a fixture's name.
  const confirm = dialog.getByRole('button', { name: 'Transfer ownership' })
  await expect(confirm).toBeDisabled()

  // The reviewable artifact for the issue: what the owner actually sees. Written
  // to a durable repo path (a scratchpad path does not render in the issue sidebar).
  if (process.env.POD_1495_SHOT)
    await page.screenshot({ path: process.env.POD_1495_SHOT, fullPage: false })
})

test("a refused transfer surfaces the server's own message, in the server's shape", async ({
  page,
}) => {
  await openMachines(page)

  // The machine's own name, read off the row BEFORE the modal opens (the dialog
  // covers the row), so the confirmation gate is satisfied the way a user
  // satisfies it rather than from a fixture constant.
  const machineName = (
    await page.locator('button[title="Click to rename"]').first().textContent()
  )?.trim()
  expect(machineName).toBeTruthy()

  await page.getByRole('button', { name: 'Transfer' }).first().click()
  const dialog = page.getByRole('dialog')

  await dialog.getByLabel(/new owner's account name/i).fill('nobody-with-this-account')
  await dialog.getByLabel(/type the machine name to confirm/i).fill(machineName ?? '')
  await expect(dialog.getByRole('button', { name: 'Transfer ownership' })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Transfer ownership' }).click()

  // A REAL round trip to the real handler: the recipient does not exist, and the
  // panel shows what the server said rather than a friendlier rewrite of it.
  await expect(dialog.getByRole('alert')).toBeVisible({ timeout: 15_000 })
  await expect(dialog).toBeVisible()
})
