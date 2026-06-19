/**
 * Snooze, end-to-end against the real Live UI + harness relay.
 *
 * Creates a shell session (a quiet shell settles to `idle`, which lands in the
 * sidebar's attention bucket and renders the snooze control next to the pin),
 * then drives the snooze control through:
 *   - the hover "Snooze for" menu (1h / Until tomorrow / Until next message),
 *   - a direct click → snooze "until next message", round-tripped through the
 *     server (setSnooze → WS sessionsChanged broadcast → re-render in the snoozed
 *     state), and
 *   - a click on the snoozed control → un-snooze, round-tripped back.
 *
 * This covers the live wiring the unit tests can't: the component renders against
 * real session data, and a click actually persists + broadcasts + re-renders.
 */
import { expect, test } from '@playwright/test'
import { newSession, openApp } from './_harness'

test.describe('session snooze', () => {
  test('renders, opens the menu, and round-trips snooze/un-snooze', async ({ page }) => {
    await openApp(page)
    await newSession(page, 'Shell')

    const aside = page.locator('aside').first()

    // The session row renders a permanently-visible "Snooze" control next to the
    // pin (its accessible name comes from the button's title). Proves the control
    // is wired into the live sidebar against real session data.
    const snooze = aside.getByRole('button', { name: 'Snooze', exact: true }).first()
    await expect(snooze).toBeVisible({ timeout: 25_000 })

    // Hover opens the "Snooze for" submenu with the three options.
    await snooze.hover()
    await expect(aside.getByRole('menuitem', { name: '1 hour' })).toBeVisible({ timeout: 5_000 })
    await expect(aside.getByRole('menuitem', { name: 'Until tomorrow' })).toBeVisible()
    await expect(aside.getByRole('menuitem', { name: 'Until next message' })).toBeVisible()

    // A direct click snoozes "until next message"; the server persists it and
    // broadcasts the updated session, so the row re-renders in its snoozed state
    // (the title flips to "Snoozed…"). Full client↔server↔client round-trip.
    await snooze.click()
    const snoozed = aside.getByRole('button', { name: /^Snoozed/ }).first()
    await expect(snoozed).toBeVisible({ timeout: 10_000 })

    // Clicking the snoozed control un-snoozes it — the row returns to the plain
    // "Snooze" state, proving the clear path round-trips too.
    await snoozed.click()
    await expect(aside.getByRole('button', { name: 'Snooze', exact: true }).first()).toBeVisible({
      timeout: 10_000,
    })
  })
})
