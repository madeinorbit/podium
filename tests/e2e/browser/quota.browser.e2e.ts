import { expect, test } from '@playwright/test'
import { openApp } from './_harness'

/**
 * Drives the real Live UI (built bundle + harness relay + a real local daemon —
 * see serve-harness.ts) so the agent-quota status item is exercised end to end:
 * a gauge glyph appears in the host status strip (HostIndicators, beside the
 * memory/connection glyphs) once `trpc.quota.summary` resolves — relay → daemon
 * → the real Claude/Codex quota endpoints — and clicking it opens the per-window
 * breakdown dialog. We assert it reaches a terminal (non-loading) state rather
 * than pinning percentages, which depend on the host's live plan usage.
 */
test('agent quota: status-strip glyph opens the per-agent breakdown', async ({
  page,
  isMobile,
}) => {
  // The glyph also renders compact in the mobile header; the desktop status
  // strip is exercised here (the component and dialog are identical).
  test.skip(isMobile, 'Desktop status strip covered here; glyph also renders compact on mobile.')
  await openApp(page)

  // The glyph mounts only after the first quota payload arrives (real daemon →
  // live Claude/Codex). Generous wait for the network round-trips.
  const glyph = page.getByRole('button', { name: /Agent quota/ })
  await expect(glyph).toBeVisible({ timeout: 30_000 })
  await glyph.click()

  // Click opens the breakdown dialog with the per-agent cards in a terminal
  // (non-loading) state — window labels, or a graceful auth/error note.
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(/5-hour|Weekly|Not signed in|Token expired|Unavailable/)
})
