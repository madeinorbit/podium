import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * Runtime verification of the super agent intake path against the ONE
 * overarching chat (issue #42): the engraved column's chat is the product's
 * front door — the first message fires `superagent.sendTurn` on the global
 * thread (which creates the headless session server-side) and renders an
 * optimistic user bubble.
 *
 * History: this spec covered the concierge + button's per-repo intake THREAD
 * (issue #65). The #40 shell relayout dropped the + button mount and #42's
 * one-chat design retired per-repo thread binding outright — repo/issue
 * context now rides the per-turn focus payload; concierge/btw history access
 * is #55.
 *
 * The harness has no LLM backend configured, so we do NOT require a model
 * reply — the assertions stop at: column open, mutation fired, optimistic
 * bubble rendered.
 */
test.skip(({ isMobile }) => isMobile, 'desktop test (the engraved column is desktop chrome)')

async function openShell(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

test('super agent chat: the first message fires sendTurn on the global thread', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  // ---- The engraved column opens by default with the overarching chat ----
  await expect(page.locator('[data-superagent-mode="open"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('super-bar')).toContainText('Super agent')
  await expect(page.getByTestId('super-bar')).toContainText('OVERARCHING · KNOWS THIS ISSUE')

  // ---- Type a message → superagent.sendTurn fires on the global thread ----
  const text = `E2E intake ${Date.now()}`
  const input = page.locator('[data-superagent-composer] textarea')
  await expect(input).toBeVisible({ timeout: 10_000 })

  const turnCall = page.waitForRequest(
    (req) => req.url().includes('superagent.sendTurn') && req.method() === 'POST',
    { timeout: 20_000 },
  )
  await input.fill(text)
  // Submit via the send button: the fresh-thread composer sends on Enter, but
  // the embedded ChatView (a prior run's global session) treats Enter as a
  // newline — the button works for both.
  await page.locator('[data-superagent-composer] button[title*="Send"]').click()

  // The mutation fired (headless session creation happens server-side inside it)...
  const req = await turnCall
  expect(req.postData(), 'the mutation carries the typed text').toContain(text)

  // ...and the optimistic user bubble rendered the message (no LLM backend in
  // the harness, so we do not await a model reply).
  await expect(page.getByText(text, { exact: false }).first()).toBeVisible({ timeout: 10_000 })
})
