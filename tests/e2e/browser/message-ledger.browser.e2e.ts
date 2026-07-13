/**
 * Message ledger dock (#237) [spec:SP-34d7 web]: the right rail's Messages
 * panel shows the active session's delivery ledger — sender → recipient,
 * status chip, urgency/lifecycle, message id — fed by `messages.ledger`.
 * Sends ride the real gate (operator capability via /trpc), so this drives
 * send → deliver/queue → ledger end-to-end in a real browser.
 */
import { expect, test } from '@playwright/test'
import { makeTrpc } from '../../../apps/web/src/app/trpc'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'the right dock is desktop chrome')
test.setTimeout(180_000)

test('Messages dock tab lists ledger rows for the active session', async ({ page }) => {
  // Self-sufficient open (cold harness starts can outlast gotoWorkspace's
  // 10s sidebar wait): load, wait out the boot screen, spawn one agent.
  await page.addInitScript(() => localStorage.setItem('podium.panelMode', 'native'))
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  const repoDialog = page.getByRole('dialog', { name: 'Find repositories' })
  if (await repoDialog.isVisible().catch(() => false)) {
    await repoDialog.getByRole('button', { name: 'Close' }).click()
  }
  const aside = page.locator('aside').first()
  await aside.waitFor({ state: 'visible', timeout: 60_000 })
  // Spawn via the sidebar's `New <Agent> in <Repo>` split button (optimistic
  // spawn navigates into the workspace and focuses the pane).
  await aside
    .getByRole('button', { name: /^New .+ in .+/ })
    .first()
    .click()
  await expect(page.locator('button[aria-label="New panel"]:visible').first()).toBeVisible({
    timeout: 30_000,
  })

  const trpc = makeTrpc('http://localhost:8799')
  let sessions: { sessionId: string }[] = []
  await expect
    .poll(
      async () => {
        sessions = (await trpc.sessions.list.query()) as { sessionId: string }[]
        return sessions.length
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0)
  // Address every live session so whichever one the pane shows has traffic.
  for (const s of sessions) {
    await trpc.messages.send.mutate({
      to: s.sessionId,
      body: 'ledger probe — hello from the operator',
      urgency: 'fyi',
    })
  }

  // Open the Messages panel from the right rail.
  await page.getByRole('button', { name: 'Messages', exact: true }).click()
  const ledger = page.getByTestId('message-ledger')
  await expect(ledger).toBeVisible({ timeout: 15_000 })

  const row = ledger.getByTestId('ledger-row').first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row).toContainText('operator')
  await expect(row).toContainText(/queued|delivered/)
  await expect(row).toContainText('fyi')
  // Expanding a row reveals the delivery story + body.
  await row.getByRole('button').first().click()
  await expect(row).toContainText('ledger probe')

  await page.screenshot({
    path: 'test-results/message-ledger-dock.png',
    fullPage: false,
  })
})
