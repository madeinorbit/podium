/**
 * POD-1595 — THE TWO THINGS A PERSON ACTUALLY SEES, IN A REAL BROWSER.
 *
 * Both were reported from use, and both had passed every unit test in the
 * repository while being broken on screen, because both are about what the DOM
 * does at the moment of an interaction rather than what a function returns:
 *
 *   1. the line under a freshly-sent prompt. It used to keep showing the
 *      PREVIOUS turn's verdict — for the report that filed this, an offer, but
 *      any attention verdict does it — so a send into a session that had asked
 *      something read as though nothing had happened;
 *   2. dropping a file. The handlers were mounted on the composer dock, a strip
 *      about seventy pixels tall, so releasing a file over the conversation —
 *      which is where a person aims — did nothing at all.
 *
 * FIXTURE — AND HOW TO RUN THIS. `PODIUM_E2E_STALE_VERDICT=1` on the harness
 * server (see serve-harness.ts) creates the session these specs drive: one whose
 * last turn ended with a QUESTION, so a verdict is already standing before
 * anything is sent. Without it there is nothing for a send to have to beat and
 * (1) cannot fail, so the specs SKIP rather than pass — a skip says "not run" in
 * the report, where a green tick would say "verified" about a fixture that was
 * never there.
 *
 *   bun scripts/browser-lane.ts --build-only
 *   PODIUM_E2E_STALE_VERDICT=1 bun scripts/browser-lane.ts \
 *     --suite pod1595-send-state --project=chromium-desktop
 */
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop chat verification')
test.skip(
  process.env.PODIUM_E2E_STALE_VERDICT !== '1',
  'needs PODIUM_E2E_STALE_VERDICT=1 on the harness server — without it no verdict is standing and the bug cannot reproduce',
)

const tail = '[data-testid="feed-tail"]'
const veil = '[data-testid="composer-drop-target"]'

async function openTheChat(page: import('@playwright/test').Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 })
  // Chat, not the terminal: this is a chat-surface spec, and the panel mode is
  // persisted, so pin it through the same channel a person would.
  await page.addInitScript(() => localStorage.setItem('podium.panelModeDefault', 'chat'))
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  // The harness runs on the edge channel, so it offers an update over the app
  // on first paint. Put it away rather than clicking through it.
  const update = page.getByRole('dialog', { name: 'Podium update' })
  if (await update.isVisible().catch(() => false)) {
    await update.getByRole('button', { name: 'Hide' }).click()
  }
  const repos = page.getByRole('dialog', { name: 'Find repositories' })
  if (await repos.isVisible().catch(() => false)) {
    await repos.getByRole('button', { name: 'Close' }).click()
  }
  // The app lands on the work list, and this harness has more than one piece of
  // work in it, so the fixture's row has to be opened by name.
  const row = page.getByRole('button', { name: /Stale verdict under a send/ }).first()
  await expect(row).toBeVisible({ timeout: 60_000 })
  // THE PRECONDITION, ASSERTED RATHER THAN ASSUMED. The fixture's verdict is
  // really standing on this session — without it the send below has nothing to
  // have to beat and the test would prove nothing. The work row is where it is
  // legible before the transcript is open; the tail cannot carry it yet, because
  // an empty transcript renders standby and no tail at all.
  await expect(row).toHaveAccessibleName(/needs answer/)
  await row.click({ timeout: 60_000 })
  const chat = page.getByRole('tab', { name: 'Chat', exact: true })
  if (await chat.isVisible().catch(() => false)) await chat.click()
  await expect(page.locator('textarea').first()).toBeVisible({ timeout: 60_000 })
}

test('the working line replaces the last turn’s verdict the moment you press send', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openTheChat(page)

  await page.locator('textarea').first().fill('here is a follow-up with attachments')
  await page.locator('textarea').first().press('Enter')

  // THE FIX, and the whole of the report that filed this. The send puts a tail
  // under the prompt either way — what changed is WHAT IT SAYS. Before, the
  // session's standing `needs answer` outranked the send and the row read
  // "Waiting for your answer" under a prompt that had just been sent, until the
  // daemon's first observation of the new turn arrived. Now the send outranks
  // the verdict it just answered, at once.
  await expect(page.locator(tail)).toHaveAttribute('data-tail', 'sending', { timeout: 5_000 })
  await expect(page.locator(tail)).not.toHaveAttribute('data-tail', 'waiting')
  // And it is the working mark that is turning, not a still dot.
  await expect(page.locator(`${tail} .feed-tail-mark`)).toBeVisible()

  // It must NOT fall back to the answered question, and must not vanish into a
  // gap: past the 8s ceiling the old build used, the row is still the send's.
  await page.waitForTimeout(9_000)
  const state = await page.locator(tail).getAttribute('data-tail')
  expect(['sending', 'working']).toContain(state)
})

test('a file dropped on the transcript attaches, and is attached exactly once', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openTheChat(page)

  // Build a real DataTransfer in the page and drop it on the TRANSCRIPT — the
  // part of the surface that did nothing before, as far from the dock as a
  // person can aim.
  const dropOnFeed = async (): Promise<void> => {
    await page.evaluate(() => {
      const feed =
        document.querySelector('[data-testid="feed-tail-slot"]') ??
        document.querySelector('.offer-lift-region')
      if (!feed) throw new Error('no transcript to drop on')
      const dt = new DataTransfer()
      dt.items.add(new File(['%PDF-1.4 e2e'], 'pod1595.pdf', { type: 'application/pdf' }))
      feed.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }),
      )
      feed.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
      )
    })
  }

  // The target is offered over the transcript, not only over the dock.
  await page.evaluate(() => {
    const feed =
      document.querySelector('[data-testid="feed-tail-slot"]') ??
      document.querySelector('.offer-lift-region')
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'probe.pdf', { type: 'application/pdf' }))
    feed?.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }),
    )
  })
  await expect(page.locator(veil)).toBeVisible({ timeout: 5_000 })

  await dropOnFeed()

  // The chip is the proof the bytes reached the session's workspace: it only
  // leaves `uploading` when the upload mutation resolves with a path.
  const chip = page.getByText('pod1595.pdf', { exact: false })
  await expect(chip).toBeVisible({ timeout: 45_000 })
  // EXACTLY ONE. Handlers mounted on both the dock and the surface would attach
  // the same file twice, and nothing on screen would say so.
  await expect(page.getByText('pod1595.pdf', { exact: false })).toHaveCount(1)
  // And the target goes away with the drag that ended.
  await expect(page.locator(veil)).toHaveCount(0)
})
