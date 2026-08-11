import { expect, type Locator, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * Runtime verification of the Podium-development gating of update controls
 * (POD-1882) against the real Live UI on the harness relay.
 *
 * What only a real drive can show, and what unit tests therefore do not cover:
 * the two Settings pages agree with each other and with the SERVER's resolved
 * state — the fleet-default selector on Updates is present with the flag off,
 * grows a Development option with it on, and the per-machine selector on
 * Machines appears and disappears with the same flag while the machine's
 * resolved source stays readable either way.
 */
test.skip(({ isMobile }) => isMobile, 'desktop test (settings nav is desktop-oriented)')

// Same reason as experimental-settings.browser.e2e.ts: first boot on a loaded
// harness box runs well past the default timeout.
test.setTimeout(300_000)

const SHOTS = process.env.PODIUM_UPDATE_CONTROLS_SHOTS

async function openSettings(page: Page, tab: string): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 120_000 })
  await page.evaluate((target) => {
    history.pushState(null, '', `/settings/${target}${location.search}`)
    dispatchEvent(new PopStateEvent('popstate'))
  }, tab)
}

async function openUpdates(page: Page): Promise<void> {
  await openSettings(page, 'updates')
  await expect(page.getByRole('heading', { name: 'Updates' })).toBeVisible({ timeout: 30_000 })
}

async function openMachines(page: Page): Promise<void> {
  await openSettings(page, 'machines')
  await expect(page.locator('[data-machine-update-controls]').first()).toBeVisible({
    timeout: 30_000,
  })
}

function flagRow(page: Page): Locator {
  return page.locator('.settings-row').filter({ hasText: 'Podium development' })
}

async function setDeveloping(page: Page, enabled: boolean): Promise<void> {
  await openSettings(page, 'experimental')
  await expect(page.getByRole('heading', { name: 'Experimental' })).toBeVisible({ timeout: 30_000 })

  const flagSwitch = flagRow(page).getByRole('switch').first()
  await expect(flagSwitch).toBeEnabled({ timeout: 20_000 })
  if ((await flagSwitch.getAttribute('aria-checked')) === String(enabled)) return

  await flagSwitch.click()
  const updateDialog = page.getByRole('dialog', { name: 'Podium update' })
  if (await updateDialog.isVisible().catch(() => false)) {
    await updateDialog.getByRole('button', { name: 'Later' }).click()
  }
  const save = page.getByRole('button', { name: /^Save changes$/ })
  await save.click()
  await expect(page.getByText('Saved ✓')).toBeVisible({ timeout: 15_000 })
  await expect(save).toBeHidden({ timeout: 15_000 })
}

test('the update controls follow the Podium-development flag', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })

  // ---- flag OFF: released channels only, no per-machine selector ----
  await setDeveloping(page, false)

  await openUpdates(page)
  const fleetRow = page.locator('.settings-row').filter({ hasText: 'Fleet default channel' })
  await expect(fleetRow.getByRole('button', { name: 'Stable' })).toBeVisible()
  await expect(fleetRow.getByRole('button', { name: 'Edge' })).toBeVisible()
  // The point of the issue: the selector itself is ordinary operation and stays.
  await expect(fleetRow.getByRole('button', { name: 'Development' })).toHaveCount(0)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/updates-flag-off.png`, fullPage: true })

  await openMachines(page)
  const controls = page.locator('[data-machine-update-controls]').first()
  await expect(controls.getByLabel(/^Update channel for /)).toHaveCount(0)
  // Hidden control, but never a hidden ANSWER — the machine still says where it is.
  await expect(controls.locator('[data-machine-update-source]')).toBeVisible()
  await expect(controls.getByText(/Target /)).toBeVisible()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/machines-flag-off.png`, fullPage: true })

  // ---- flag ON: Development offered, per-machine selector back ----
  await setDeveloping(page, true)

  await openUpdates(page)
  const fleetRowOn = page.locator('.settings-row').filter({ hasText: 'Fleet default channel' })
  await expect(fleetRowOn.getByRole('button', { name: 'Development' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(fleetRowOn.getByRole('button', { name: 'Stable' })).toBeVisible()
  await expect(fleetRowOn.getByRole('button', { name: 'Edge' })).toBeVisible()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/updates-flag-on.png`, fullPage: true })

  await openMachines(page)
  const selector = page.locator('[data-machine-update-controls]').first().getByLabel(/^Update channel for /)
  await expect(selector).toBeVisible({ timeout: 30_000 })
  await selector.click()
  // "Fleet default" is the clear-the-pin choice and comes first.
  await expect(page.getByRole('option', { name: 'Fleet default' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'Development' })).toBeVisible()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/machines-flag-on.png`, fullPage: true })
  await page.keyboard.press('Escape')

  // Leave the install as the harness found it.
  await setDeveloping(page, false)
})
