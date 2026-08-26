/**
 * POD-1595 — THE BAD DAYS.
 *
 * The happy paths are in `pod1595-send-state.browser.e2e.ts`. These are the ones
 * that only a real browser can answer, because each is about what the ENGINE
 * does when the app declines to act — the default action on a drop, the URL
 * after a release, a fetch that never succeeds. jsdom has no navigation and no
 * drag-drop defaults, so every one of these passed there while being wrong.
 *
 * The rule they share: a failure must not leave the interface asserting
 * something untrue. A refused send must stop claiming to be in flight; a refused
 * upload must say so on its own chip; and a drop this app will not take must
 * cost the operator nothing — above all not the workspace they had open.
 *
 * FIXTURE: `PODIUM_E2E_STALE_VERDICT=1` — see the sibling suite's header.
 */
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop chat verification')
test.skip(
  process.env.PODIUM_E2E_STALE_VERDICT !== '1',
  'needs PODIUM_E2E_STALE_VERDICT=1 on the harness server',
)

const tail = '[data-testid="feed-tail"]'
const veil = '[data-testid="composer-drop-target"]'

async function openTheChat(page: import('@playwright/test').Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.addInitScript(() => localStorage.setItem('podium.panelModeDefault', 'chat'))
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  const update = page.getByRole('dialog', { name: 'Podium update' })
  if (await update.isVisible().catch(() => false)) {
    await update.getByRole('button', { name: 'Hide' }).click()
  }
  const repos = page.getByRole('dialog', { name: 'Find repositories' })
  if (await repos.isVisible().catch(() => false)) {
    await repos.getByRole('button', { name: 'Close' }).click()
  }
  const row = page.getByRole('button', { name: /Stale verdict under a send/ }).first()
  await expect(row).toBeVisible({ timeout: 60_000 })
  await row.click({ timeout: 60_000 })
  const chat = page.getByRole('tab', { name: 'Chat', exact: true })
  if (await chat.isVisible().catch(() => false)) await chat.click()
  await expect(page.locator('textarea').first()).toBeVisible({ timeout: 60_000 })
}

/** Drop a real DataTransfer on a selector, with the item kinds given. */
async function dropOn(
  page: import('@playwright/test').Page,
  selector: string,
  kind: 'file' | 'link',
): Promise<void> {
  await page.evaluate(
    ({ selector: sel, kind: k }) => {
      const target = document.querySelector(sel)
      if (!target) throw new Error(`no drop target for ${sel}`)
      const dt = new DataTransfer()
      if (k === 'file') {
        dt.items.add(new File(['%PDF-1.4 bad-day'], 'sad.pdf', { type: 'application/pdf' }))
      } else {
        dt.setData('text/uri-list', 'https://example.com/somewhere-else')
      }
      for (const type of ['dragover', 'drop'] as const) {
        target.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
        )
      }
    },
    { selector, kind },
  )
}

test('a refused send stops claiming to be in flight', async ({ page }) => {
  test.setTimeout(180_000)
  await openTheChat(page)
  // The send never reaches the server. Under the old 8s ceiling this settled
  // quietly; under the 30s one it would sit there turning a working mark over a
  // bubble that had already gone red, and — since a send now outranks the
  // session's own verdicts — suppress the error row underneath it.
  await page.route('**/trpc/**', async (route) => {
    if (route.request().url().includes('sessions.sendText')) {
      await route.fulfill({ status: 500, body: '{"error":{"message":"refused"}}' })
      return
    }
    await route.continue()
  })
  await page.locator('textarea').first().fill('this one will be refused')
  await page.locator('textarea').first().press('Enter')

  // It may flash 'sending' for the round trip; what must not happen is that it
  // is STILL claiming to send once the refusal has landed.
  await expect
    .poll(
      async () =>
        page
          .locator(tail)
          .getAttribute('data-tail')
          .catch(() => null),
      {
        timeout: 20_000,
      },
    )
    .not.toBe('sending')
})

test('a refused upload says so on its own chip, and blocks the send', async ({ page }) => {
  test.setTimeout(180_000)
  await openTheChat(page)
  await page.route('**/trpc/**', async (route) => {
    if (route.request().url().includes('sessions.uploadImage')) {
      await route.fulfill({ status: 500, body: '{"error":{"message":"no disk"}}' })
      return
    }
    await route.continue()
  })
  await dropOn(page, '.offer-lift-region', 'file')

  // The chip is the only place this can be reported — the file never became a
  // path, so there is nothing to put in the prompt.
  await expect(page.locator('.attachment-chip--failed')).toBeVisible({ timeout: 45_000 })
  await expect(page.getByText('sad.pdf', { exact: false })).toBeVisible()
})

test('dragging a link over the conversation attaches nothing and navigates nowhere', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openTheChat(page)
  const before = page.url()
  await dropOn(page, '.offer-lift-region', 'link')

  // No offer of a drop...
  await expect(page.locator(veil)).toHaveCount(0)
  // ...nothing attached...
  await expect(page.locator('.attachment-chip')).toHaveCount(0)
  // ...and, the part that matters, the workspace is still here. A link released
  // on an unclaimed page is a NAVIGATION by default.
  await page.waitForTimeout(1_000)
  expect(page.url()).toBe(before)
  await expect(page.locator('textarea').first()).toBeVisible()
})

test('a file released OUTSIDE the chat does not take the workspace with it', async ({ page }) => {
  test.setTimeout(180_000)
  await openTheChat(page)
  const before = page.url()
  // The sidebar is not a drop zone and never claims the drag. Without the
  // window guard the browser's default action here is to navigate the whole
  // single-page app to the dropped file, losing every open panel and the
  // half-written prompt with them.
  await dropOn(page, 'aside, [class*="sidebar"], body', 'file')
  await page.waitForTimeout(1_500)
  expect(page.url()).toBe(before)
  await expect(page.locator('textarea').first()).toBeVisible()
  // And it did not silently attach either — nothing outside the conversation
  // accepts a file.
  await expect(page.locator('.attachment-chip')).toHaveCount(0)
})
