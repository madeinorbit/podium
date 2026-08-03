import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * THE PANEL'S LIFECYCLE ARBITRATION, REAL-CLICKED (POD-408).
 *
 * `panel-surface.ts` decides which of four states a session's panel is in and
 * `lifecycle-actions.ts` decides what the way back is called; this drives both
 * through a real browser, in both directions:
 *
 *   live → parked   Hibernate, from the header overflow menu
 *   parked → live   Resume, from the banner over the read-only transcript
 *
 * The chat/native segment is the tell: it exists ONLY on a live surface, so its
 * disappearance and reappearance IS the arbitration, observed rather than
 * asserted about.
 *
 * FIXTURE: `PODIUM_E2E_PANEL_LIFECYCLE=1` on the harness server (see
 * tests/e2e/serve-harness.ts) — one live, resumable, idle agent session. Without
 * it there is nothing parkable on screen, so this spec FAILS with a named reason
 * rather than passing silently: a suite that reports green for a fixture it
 * never had is the instrument the browser lane exists to remove.
 */
test.skip(({ isMobile }) => isMobile, 'desktop panel verification')

test('hibernate parks the panel and resume arbitrates it back to live', async ({ page }) => {
  test.fail(
    process.env.PODIUM_E2E_PANEL_LIFECYCLE !== '1',
    'needs PODIUM_E2E_PANEL_LIFECYCLE=1 on the harness server — without it there is no resumable session to park',
  )
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.addInitScript(() => localStorage.setItem('podium.panelModeDefault', 'native'))
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })

  const aside = page.locator('aside').first()
  await aside.waitFor({ state: 'visible', timeout: 60_000 })
  const row = aside.locator('[data-session]').filter({ hasText: 'Lifecycle panel subject' }).first()
  await expect(row).toBeVisible({ timeout: 60_000 })
  await row.click()

  // LIVE: two views offered, because there is a PTY behind them.
  await expect(page.getByTestId('mode-native')).toBeVisible({ timeout: 45_000 })
  await expect(page.getByTestId('mode-chat')).toBeVisible()

  // live → parked, through the real menu item (keyed on the ACTION, not its label).
  await page.getByTestId('header-menu').first().click()
  const hibernate = page.getByTestId('lifecycle-hibernate')
  await expect(hibernate).toBeVisible({ timeout: 15_000 })
  await hibernate.click()

  // PARKED: the transcript stays readable under a banner whose only action is
  // the way back, and the mode segment is gone — there is no terminal to switch to.
  const resume = page.getByTestId('lifecycle-resume')
  await expect(resume).toBeVisible({ timeout: 45_000 })
  await expect(resume).toHaveText('Resume')
  await expect(page.getByTestId('mode-native')).toHaveCount(0)

  // parked → live.
  await resume.click()
  await expect(page.getByTestId('lifecycle-resume')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.getByTestId('mode-native')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('mode-chat')).toBeVisible()
})

test('the mode segment switches the panel between chat and native, and back', async ({ page }) => {
  // The terminal/chat half of the arbitration, with the draft channel intact:
  // the terminal is NOT disposed across the toggle (Task 6's warm toggle), which
  // is what makes the chat→native draft flush a re-arm rather than a remount.
  test.fail(
    process.env.PODIUM_E2E_PANEL_LIFECYCLE !== '1',
    'needs PODIUM_E2E_PANEL_LIFECYCLE=1 on the harness server',
  )
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.addInitScript(() => localStorage.setItem('podium.panelModeDefault', 'native'))
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  const aside = page.locator('aside').first()
  await aside.waitFor({ state: 'visible', timeout: 60_000 })
  await aside
    .locator('[data-session]')
    .filter({ hasText: 'Lifecycle panel subject' })
    .first()
    .click()

  const native = page.getByTestId('mode-native')
  const chat = page.getByTestId('mode-chat')
  await expect(native).toBeVisible({ timeout: 45_000 })
  await expect(native).toHaveAttribute('aria-selected', 'true')
  // The terminal surface is rendered in native mode…
  await expect(page.getByTestId('terminal-surface')).toBeVisible({ timeout: 45_000 })

  await chat.click()
  await expect(chat).toHaveAttribute('aria-selected', 'true')
  // …and is still MOUNTED in chat mode, just hidden — the warm toggle.
  await expect(page.getByTestId('terminal-surface')).toHaveCount(1)
  await expect(page.getByTestId('terminal-surface')).toBeHidden()

  await native.click()
  await expect(native).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('terminal-surface')).toBeVisible()
})
