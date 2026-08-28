/**
 * POD-1595 — THE WALKTHROUGH, RECORDED.
 *
 * Not a test of anything the other two suites do not already assert; this exists
 * to produce a VIDEO of the two changes as a person meets them, because both are
 * about timing and neither reads from a diff. It deliberately pauses between
 * beats so the recording is watchable rather than a blur, so it proves nothing
 * about latency — the assertions that do live in the sibling suites.
 *
 * FIXTURE: `PODIUM_E2E_STALE_VERDICT=1`.
 * Run:  PODIUM_E2E_STALE_VERDICT=1 bun scripts/browser-lane.ts \
 *         --suite pod1595-recording --project=chromium-desktop
 * The webm lands under tests/e2e/test-results/<test-dir>/.
 */
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop walkthrough')
test.skip(
  process.env.PODIUM_E2E_STALE_VERDICT !== '1',
  'needs PODIUM_E2E_STALE_VERDICT=1 on the harness server',
)

test.use({
  video: { mode: 'on', size: { width: 1280, height: 800 } },
  viewport: { width: 1280, height: 800 },
})

test('walkthrough: the working line, then a file dropped on the conversation', async ({ page }) => {
  test.setTimeout(240_000)
  const beat = (ms = 1_200): Promise<void> => page.waitForTimeout(ms)

  await page.addInitScript(() => localStorage.setItem('podium.panelModeDefault', 'chat'))
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  // THE UPDATE PANEL ARRIVES LATE, on its own check, so dismissing it once at
  // boot is a race — the first cut of this recording had it covering a third of
  // every frame, including the exact strip the working line appears in. Try
  // again at each beat instead.
  const dismissChrome = async (): Promise<void> => {
    for (const [name, button] of [
      ['Podium update', 'Hide'],
      ['Find repositories', 'Close'],
    ] as const) {
      const dialog = page.getByRole('dialog', { name })
      if (await dialog.isVisible().catch(() => false)) {
        await dialog
          .getByRole('button', { name: button })
          .click()
          .catch(() => {})
      }
    }
  }
  await dismissChrome()
  await beat()

  // The session as the operator finds it: its last turn ended with a question,
  // and the row says so.
  const row = page.getByRole('button', { name: /Stale verdict under a send/ }).first()
  await expect(row).toBeVisible({ timeout: 60_000 })
  await beat()
  await row.click()
  const chat = page.getByRole('tab', { name: 'Chat', exact: true })
  if (await chat.isVisible().catch(() => false)) await chat.click()
  await expect(page.locator('textarea').first()).toBeVisible({ timeout: 60_000 })
  await dismissChrome()
  await beat(1_800)

  // BEAT 1 — the send. Typed at a readable speed so the recording shows the
  // composer, then Enter, then the working line arriving with it rather than
  // fifteen seconds later.
  await dismissChrome()
  await page.locator('textarea').first().click()
  await page
    .locator('textarea')
    .first()
    .pressSequentially('Have a look at the three attachments and tell me what changed.', {
      delay: 28,
    })
  await beat(900)
  await page.locator('textarea').first().press('Enter')
  await expect(page.locator('[data-testid="feed-tail"]')).toHaveAttribute('data-tail', 'sending', {
    timeout: 5_000,
  })
  // Hold on the turning mark — this is the thing that used to be absent.
  await dismissChrome()
  await beat(4_000)

  // BEAT 2 — the drop. The veil is held open for a moment so the recording shows
  // the whole conversation offering itself as the target, not just the dock.
  await page.evaluate(() => {
    const feed = document.querySelector('.offer-lift-region')
    const dt = new DataTransfer()
    dt.items.add(
      new File(['%PDF-1.4 walkthrough'], 'design-notes.pdf', { type: 'application/pdf' }),
    )
    ;(window as unknown as { __pod1595dt?: DataTransfer }).__pod1595dt = dt
    feed?.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }),
    )
  })
  await expect(page.locator('[data-testid="composer-drop-target"]')).toBeVisible({ timeout: 5_000 })
  await beat(2_200)
  await page.evaluate(() => {
    const feed = document.querySelector('.offer-lift-region')
    const dt = (window as unknown as { __pod1595dt?: DataTransfer }).__pod1595dt
    feed?.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
    )
  })
  await expect(page.getByText('design-notes.pdf', { exact: false })).toBeVisible({
    timeout: 45_000,
  })
  await beat(3_000)
})
