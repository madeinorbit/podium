/**
 * Snooze, end-to-end against the real Live UI + harness relay.
 *
 * Creates a shell session (a quiet shell settles to `idle`, which lands in the
 * sidebar's NEEDS YOUR ATTENTION group and renders the snooze control), then:
 *   - opens the portalled "Snooze for" hover menu (rendered at the document root,
 *     so it escapes the sidebar's overflow clip), and
 *   - picks "Until next message" → the server persists + broadcasts the snooze,
 *     the row drops out of NEEDS YOUR ATTENTION, and — snooze being attention-only
 *     now — its control disappears from the sidebar. Full client↔server round-trip.
 *
 * This covers the live wiring the unit tests can't: the control renders against
 * real session data, the hover menu opens portalled, and snoozing actually
 * persists + broadcasts + re-partitions the sidebar.
 */
import { expect, test } from '@playwright/test'
import { newSession, openApp } from './_harness'

test.describe('session snooze', () => {
  test('snooze control + portalled menu remove a row from NEEDS YOUR ATTENTION', async ({
    page,
  }) => {
    await openApp(page)
    await newSession(page, 'Shell')

    const aside = page.locator('aside').first()

    // The shell shows in NEEDS YOUR ATTENTION with a permanently-visible "Snooze"
    // control (its accessible name comes from the button title).
    const snooze = aside.getByRole('button', { name: 'Snooze', exact: true })
    await expect(snooze.first()).toBeVisible({ timeout: 25_000 })
    const before = await snooze.count()

    // Hover opens the "Snooze for" menu. It is portalled to <body>, so query it at
    // the page level (not under <aside>).
    await snooze.first().hover()
    await expect(page.getByRole('menuitem', { name: '1 hour' })).toBeVisible({ timeout: 5_000 })
    await expect(page.getByRole('menuitem', { name: 'Until tomorrow' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Until next message' })).toBeVisible()

    // Pick "Until next message" → snooze. The server persists + broadcasts; the row
    // leaves NEEDS YOUR ATTENTION and its (attention-only) plain snooze control
    // disappears, so the plain-snooze count drops by one. Full round-trip.
    await page.getByRole('menuitem', { name: 'Until next message' }).click()
    await expect(snooze).toHaveCount(before - 1, { timeout: 10_000 })

    // But in its normal worktree location the session now shows an UN-snooze
    // affordance (title starts "Snoozed…") — never a plain snooze icon out there.
    const unsnooze = aside.getByRole('button', { name: /^Snoozed/ })
    await expect(unsnooze.first()).toBeVisible({ timeout: 10_000 })

    // Un-snoozing from the worktree row returns the session to NEEDS YOUR ATTENTION:
    // the plain snooze control comes back and the un-snooze affordance is gone.
    await unsnooze.first().click()
    await expect(snooze).toHaveCount(before, { timeout: 10_000 })
    await expect(aside.getByRole('button', { name: /^Snoozed/ })).toHaveCount(0)
  })
})
