import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
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

const HTTP = (process.env.PODIUM_RELAY ?? 'ws://localhost:8799')
  .replace('ws://', 'http://')
  .replace('wss://', 'https://')

async function rpc<T>(request: APIRequestContext, proc: string, input?: unknown): Promise<T> {
  const res = await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
  if (!res.ok()) throw new Error(`${proc} → ${res.status()}: ${await res.text()}`)
  const body = (await res.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

test('super agent chat: the first message fires sendTurn on the global thread', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })

  // Seed one quiet no-colour question and one explicitly-coloured review card.
  const repos = await request.get(`${HTTP}/trpc/repos.list`)
  const repoBody = (await repos.json()) as { result?: { data?: string[] } }
  const repoPath = repoBody.result?.data?.[0]
  if (!repoPath) throw new Error('harness registered no repo')
  const stamp = Date.now().toString(36)
  const quiet = await rpc<{ id: string; seq: number }>(request, 'issues.create', {
    repoPath,
    title: `Quiet fallback ${stamp}`,
    startNow: false,
  })
  await rpc(request, 'issues.setNeedsHuman', {
    id: quiet.id,
    question: `Does this neutral recede? ${stamp}`,
  })
  const colored = await rpc<{ id: string; seq: number }>(request, 'issues.create', {
    repoPath,
    title: `Colored review ${stamp}`,
    startNow: false,
  })
  await rpc(request, 'issues.update', {
    id: colored.id,
    patch: { color: 'violet', stage: 'review' },
  })

  await openShell(page)

  // ---- The engraved column opens by default with the overarching chat ----
  await expect(page.locator('[data-superagent-mode="open"]')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('super-bar')).toContainText('Super agent')
  await expect(page.getByTestId('super-bar')).toContainText('OVERARCHING · KNOWS THIS ISSUE')

  // ---- Tray polish: larger hierarchy, spacious geometry, quiet fallback ----
  const quietCard = page.locator(
    `[data-testid="tray-card-question"][data-issue-seq="${quiet.seq}"]`,
  )
  const coloredCard = page.locator(
    `[data-testid="tray-card-review"][data-issue-seq="${colored.seq}"]`,
  )
  await expect(quietCard).toBeVisible({ timeout: 20_000 })
  await expect(coloredCard).toBeVisible({ timeout: 20_000 })
  await expect(quietCard).toHaveAttribute('data-issue-colored', 'false')
  await expect(coloredCard).toHaveAttribute('data-issue-colored', 'true')
  expect(
    await quietCard.evaluate((el) => getComputedStyle(el).getPropertyValue('--issue').trim()),
  ).toBe('rgb(86, 89, 101)')
  expect(
    await coloredCard.evaluate((el) => getComputedStyle(el).getPropertyValue('--issue').trim()),
  ).toBe('rgb(139, 92, 246)')
  await expect(quietCard.getByTestId('tray-title')).toHaveCSS('font-size', '12px')
  await expect(quietCard.getByTestId('tray-copy')).toHaveCSS('font-size', '12.5px')
  await expect(coloredCard.getByTestId('tray-headline')).toHaveCSS('font-size', '14px')
  await expect(coloredCard.getByTestId('tray-state-line')).toHaveCSS('font-size', '10.5px')
  const quietPadding = await quietCard.evaluate((el) => {
    const style = getComputedStyle(el)
    return {
      inline: Number.parseFloat(style.paddingInlineStart),
      block: Number.parseFloat(style.paddingBlockStart),
    }
  })
  expect(quietPadding.inline).toBeGreaterThanOrEqual(14)
  expect(quietPadding.block).toBeGreaterThanOrEqual(12)
  const quietActionHeights = await quietCard
    .getByRole('button')
    .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height))
  expect(quietActionHeights.every((height) => height >= 24)).toBe(true)
  const mainActionHeights = await quietCard
    .getByRole('button', { name: /Reply|resolve/ })
    .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height))
  expect(mainActionHeights.every((height) => height >= 28)).toBe(true)

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

  // The super-agent column now uses the same Flat Field hierarchy as other
  // chats: an engraved user surface, not the retired compact accent bar.
  const userTurn = page.locator('.chat-compact .transcript-you').last()
  await expect(userTurn).toBeVisible()
  await expect(page.getByText('No transcript yet', { exact: false })).toHaveCount(0)
  await expect(input).toHaveAttribute('placeholder', 'Working — stop to interject…')
  await expect(userTurn.locator('.chat-md')).toHaveCSS('font-size', '13px')
  await expect(userTurn).toHaveCSS('border-radius', '9px')
  expect(await userTurn.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none')
  await page.screenshot({ path: 'test-results/superagent-polish-wide.png', fullPage: false })

  // Narrow desktop: cards keep their padding and wrap controls without
  // horizontal clipping; the composer remains usable.
  await page.setViewportSize({ width: 820, height: 760 })
  await expect(quietCard).toBeVisible()
  const overflow = await quietCard.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
  const cardBox = await quietCard.boundingBox()
  if (!cardBox) throw new Error('quiet tray card not measurable')
  const actionBoxes = await quietCard.getByRole('button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect()
      return { left: rect.left, right: rect.right }
    }),
  )
  expect(
    actionBoxes.every((box) => box.left >= cardBox.x && box.right <= cardBox.x + cardBox.width),
  ).toBe(true)
  await expect(input).toBeVisible()
  await page.screenshot({ path: 'test-results/superagent-polish-narrow.png', fullPage: false })
})
