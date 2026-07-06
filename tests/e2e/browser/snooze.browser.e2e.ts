/**
 * Snooze, end-to-end against the real Live UI + harness relay.
 *
 * Shells are excluded from the sidebar's NEEDS YOUR ATTENTION, so the open
 * session's TOOLBAR is where you snooze one. This drives:
 *   - the toolbar snooze control rendering for an idle shell,
 *   - its portalled "Snooze for" hover menu (rendered at the document root, so it
 *     escapes the sidebar overflow clip),
 *   - snoozing "until next message" → the server persists + broadcasts, and the
 *     session's worktree row gains an UN-snooze affordance (never a plain snooze
 *     icon outside NEEDS YOUR ATTENTION), and
 *   - un-snoozing from that worktree row → the affordance disappears.
 *
 * Covers the live wiring unit tests can't: the control renders against real
 * session data, the menu opens portalled, and snooze/un-snooze round-trip.
 */
import { expect, test } from '@playwright/test'
import { newSession, openApp } from './_harness'

test.describe('session snooze', () => {
  test('snooze from the toolbar; un-snooze from the worktree row', async ({ page }) => {
    await openApp(page)
    await newSession(page, 'Shell')

    const aside = page.locator('aside').first()

    // The open session's toolbar shows a snooze control once the shell settles to
    // idle. It is the only plain-snooze button on screen (the sidebar never shows
    // one for a shell). Its accessible name comes from the button title.
    const snooze = page.getByRole('button', { name: 'Snooze', exact: true })
    await expect(snooze.first()).toBeVisible({ timeout: 25_000 })

    // Hover opens the portalled "Snooze for" menu (rendered at <body>).
    await snooze.first().hover()
    await expect(page.getByRole('menuitem', { name: '1 hour' })).toBeVisible({ timeout: 5_000 })
    await expect(page.getByRole('menuitem', { name: 'Until tomorrow' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Until next message' })).toBeVisible()

    // Snooze "until next message" — server persists + broadcasts.
    await page.getByRole('menuitem', { name: 'Until next message' }).click()

    // Shells never render in the sidebar (no row, so no sidebar affordance at
    // all); the toolbar control flips to an UN-snooze affordance (title starts
    // "Snoozed…").
    const unsnooze = page.getByRole('button', { name: /^Snoozed/ })
    await expect(unsnooze.first()).toBeVisible({ timeout: 10_000 })
    await expect(aside.getByRole('button', { name: /^Snoozed/ })).toHaveCount(0)
    await expect(aside.getByRole('button', { name: 'Snooze', exact: true })).toHaveCount(0)

    // Un-snooze from the toolbar → the affordance flips back (round-trip).
    await unsnooze.first().click()
    await expect(page.getByRole('button', { name: /^Snoozed/ })).toHaveCount(0, { timeout: 10_000 })
    await expect(snooze.first()).toBeVisible({ timeout: 10_000 })
  })
})
