import { expect, test } from '@playwright/test'
import { openApp } from './_harness'

/**
 * Drives the real Live UI (built bundle + harness relay + a real local daemon —
 * see serve-harness.ts) so the agent-quota tool is exercised end to end: the
 * sidebar tools-row button switches the main view, QuotaView mounts, and its
 * `trpc.quota.summary` query flows relay → daemon → the real Claude/Codex quota
 * fetchers on this host. We assert the view mounts and reaches a terminal state
 * (never stuck on "Loading quota…") rather than pinning exact percentages, which
 * depend on the host's live plan usage.
 */
test('agent quota: sidebar button opens QuotaView which renders a terminal state', async ({
  page,
  isMobile,
}) => {
  // The desktop tools-row Gauge button is the entry point exercised here. On
  // mobile the same Agent-quota action lives inside the action sheet (mirroring
  // the Usage entry); QuotaView itself is identical, and this desktop path proves
  // it renders end to end with live daemon data.
  test.skip(
    isMobile,
    'Mobile entry is in the action sheet; desktop tools-row entry is covered here.',
  )
  await openApp(page)

  // Tools-row Gauge button (mirrors the Usage button) — title="Agent quota".
  const quotaBtn = page.locator('[title="Agent quota"]')
  await expect(quotaBtn).toBeVisible({ timeout: 15_000 })
  await quotaBtn.click()

  // View switched + QuotaView mounted + button reflects active state.
  await expect(page.getByRole('heading', { name: 'Agent quota' })).toBeVisible()
  await expect(quotaBtn).toHaveAttribute('aria-pressed', 'true')

  // The query resolves through the real daemon (which spawns codex app-server),
  // so allow a generous window. A terminal state is any agent card (window
  // labels) or a graceful empty/auth state — but NOT the loading placeholder.
  const body = page.locator('section[aria-label="Agent quota"]')
  await expect(body).toContainText(
    /5-hour|Weekly|Not signed in|Token expired|Unavailable|No agents reported quota/,
    { timeout: 30_000 },
  )
  await expect(body).not.toContainText('Loading quota…')
})
