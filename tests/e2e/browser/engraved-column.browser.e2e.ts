import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * Runtime verification of the engraved column's CONTENT contract (issue #42)
 * against the REAL Live UI on the harness relay:
 *
 *   - Tray filtering: ONLY human-actionable items (needs-human questions,
 *     human-audience review-stage issues) — never working/status rows — scoped
 *     to the selected issue's subtree, widening to all issues unscoped.
 *   - Empty tray: the quiet "Nothing waiting on you" line.
 *   - Super agent: single overarching chat, event feed rows (click = select
 *     that issue), CTX badge, Discuss ↓ prefills the composer.
 *   - Collapse: each section folds to its bar (amber count pill / no composer),
 *     persisted across reload; whole-column fold to the 44px bar keeps the
 *     count pill + expands landing on the clicked half.
 *   - Resize: the tray/chat split handle drags and persists.
 *
 * Desktop-only: the engraved column lives in the desktop shell.
 */
test.skip(({ isMobile }) => isMobile, 'desktop engraved column')

const HTTP = (process.env.PODIUM_RELAY ?? 'ws://localhost:8799')
  .replace('ws://', 'http://')
  .replace('wss://', 'https://')

async function rpc<T>(
  request: APIRequestContext,
  proc: string,
  input?: unknown,
  method: 'post' | 'get' = 'post',
): Promise<T> {
  const res =
    method === 'post'
      ? await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
      : await request.get(`${HTTP}/trpc/${proc}`)
  if (!res.ok()) throw new Error(`${proc} → ${res.status()}: ${await res.text()}`)
  const body = (await res.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

interface SeededIssue {
  id: string
  seq: number
}

async function openShell(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

test('tray filtering, scope, collapse states, resize, fold/reopen, and persistence', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1440, height: 900 })

  // ---- Seed real issues over the server's HTTP tRPC surface ----
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos[0]
  if (!repoPath) throw new Error('harness registered no repo')
  const stamp = Date.now().toString(36)
  const create = (title: string, parentId?: string) =>
    rpc<SeededIssue>(request, 'issues.create', {
      repoPath,
      title,
      startNow: false,
      ...(parentId ? { parentId } : {}),
    })
  const parent = await create(`Engraved parent epic ${stamp}`)
  const reviewChild = await create(`Refresh-timer fix ${stamp}`, parent.id)
  await rpc(request, 'issues.update', { id: reviewChild.id, patch: { stage: 'review' } })
  const questionChild = await create(`Mobile session path ${stamp}`, parent.id)
  await rpc(request, 'issues.setNeedsHuman', {
    id: questionChild.id,
    question: `Ship behind a flag? ${stamp}`,
  })
  const workingChild = await create(`Working child ${stamp}`, parent.id)
  await rpc(request, 'issues.update', { id: workingChild.id, patch: { stage: 'in_progress' } })
  const outsider = await create(`Outsider issue ${stamp}`)
  await rpc(request, 'issues.setNeedsHuman', {
    id: outsider.id,
    question: `Outside question? ${stamp}`,
  })

  await openShell(page)

  // ---- Structure: Tray bar above Super agent bar inside the engraved column ----
  const column = page.locator('[data-superagent-mode="open"]')
  await expect(column).toBeVisible({ timeout: 20_000 })
  const trayBar = page.getByTestId('tray-bar')
  const superBar = page.getByTestId('super-bar')
  await expect(trayBar).toBeVisible()
  await expect(superBar).toBeVisible()
  await expect(trayBar, 'no issue selected → unscoped').toContainText('ALL ISSUES')

  // ---- Tray filtering: ONLY human-actionable items, never working rows ----
  await expect(
    page.locator(`[data-testid="tray-card-question"][data-issue-seq="${questionChild.seq}"]`),
    'the subtree question card renders',
  ).toBeVisible({ timeout: 20_000 })
  await expect(
    page.locator(`[data-testid="tray-card-review"][data-issue-seq="${reviewChild.seq}"]`),
    'the review card renders with its action row',
  ).toBeVisible()
  await expect(
    page.locator(`[data-testid="tray-card-question"][data-issue-seq="${outsider.seq}"]`),
    'unscoped: the outsider question shows too',
  ).toBeVisible()
  await expect(
    page.locator(`[data-testid^="tray-card-"][data-issue-seq="${workingChild.seq}"]`),
    'a working issue NEVER lands in the tray',
  ).toHaveCount(0)
  const reviewCard = page.locator(`[data-testid="tray-card-review"]`).first()
  await expect(reviewCard.getByRole('button', { name: /Done — merge/ })).toBeVisible()
  await expect(reviewCard.getByRole('button', { name: 'Send back' })).toBeVisible()

  // ---- Event feed: rows render; clicking the parent's row selects it (scope) ----
  const feed = page.getByTestId('super-event-feed')
  await expect(feed).toBeVisible({ timeout: 20_000 })
  await feed
    .getByRole('button')
    .filter({ hasText: `Engraved parent epic ${stamp}` })
    .last()
    .click()
  await expect(trayBar, 'selected issue → ISSUE SCOPE').toContainText('ISSUE SCOPE', {
    timeout: 10_000,
  })
  await expect(
    page.locator(`[data-testid="tray-card-question"][data-issue-seq="${outsider.seq}"]`),
    'scoped: the outsider question leaves the tray',
  ).toHaveCount(0)
  await expect(
    page.locator(`[data-testid="tray-card-question"][data-issue-seq="${questionChild.seq}"]`),
  ).toBeVisible()
  await page.screenshot({ path: 'test-results/engraved-column-scoped-tray.png', fullPage: false })

  // ---- CTX badge rides the composer while an issue is selected ----
  await expect(page.getByTestId('ctx-badge')).toBeVisible()
  await expect(page.getByTestId('ctx-badge')).toContainText(`#${parent.seq} context`)

  // ---- Discuss ↓ prefills + focuses the chat composer ----
  await reviewCard.getByRole('button', { name: 'Discuss ↓' }).click()
  const composer = page.locator('[data-superagent-composer] textarea')
  await expect(composer).toHaveValue(new RegExp(`Re #${reviewChild.seq}`))
  await expect(composer).toBeFocused()

  // ---- Resize: drag the tray/chat split handle and the tray height clamps ----
  const splitter = page.getByRole('separator', { name: 'Resize tray', exact: true })
  await expect(splitter).toBeVisible()
  const trayCards = page.getByTestId('tray-cards')
  const before = (await trayCards.boundingBox())?.height ?? 0
  const handle = await splitter.boundingBox()
  if (!handle) throw new Error('tray split handle not measurable')
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2, handle.y - 60, { steps: 6 })
  await page.mouse.up()
  await expect
    .poll(async () => (await trayCards.boundingBox())?.height ?? 0, {
      message: 'dragging the handle up shrinks the tray body',
    })
    .toBeLessThan(before)

  // ---- Tray collapses to its bar with the amber count pill; persists reload ----
  await trayBar.getByRole('button', { name: 'Collapse Tray' }).click()
  await expect(page.getByTestId('tray-cards')).toHaveCount(0)
  await expect(trayBar.getByTestId('tray-count-pill')).toHaveText('2')
  await page.screenshot({ path: 'test-results/engraved-column-tray-collapsed.png' })

  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  await expect(page.getByTestId('tray-bar')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('tray-cards'), 'tray collapse persists').toHaveCount(0)
  await expect(page.getByTestId('tray-bar').getByTestId('tray-count-pill')).toHaveText('2', {
    timeout: 20_000,
  })
  await page.getByTestId('tray-bar').getByRole('button', { name: 'Expand Tray' }).click()
  await expect(page.getByTestId('tray-cards')).toBeVisible()

  // ---- Super agent collapses to its bar: the composer goes with it (3b) ----
  await page.getByTestId('super-bar').getByRole('button', { name: 'Collapse Super agent' }).click()
  await expect(page.locator('[data-superagent-composer]')).toHaveCount(0)
  await expect(page.getByTestId('super-bar')).toBeVisible()
  await page.screenshot({ path: 'test-results/engraved-column-super-collapsed.png' })
  await page.getByTestId('super-bar').getByRole('button', { name: 'Expand Super agent' }).click()
  await expect(page.locator('[data-superagent-composer]')).toBeVisible()

  // ---- Whole-column fold (3d): 44px bar keeps the count pill; expand lands on
  //      the clicked half ----
  await page.getByTitle('Fold the tray and superagent column').click()
  const folded = page.getByRole('complementary', { name: 'Folded tray and superagent' })
  await expect(folded).toBeVisible()
  await expect(folded.getByTestId('folded-tray-count')).toHaveText('2')
  await page.screenshot({ path: 'test-results/engraved-column-folded-bar.png' })

  // Land on the tray half: collapse the tray first so the landing is observable.
  await folded.getByTitle('Expand tray', { exact: true }).click()
  await expect(page.locator('[data-superagent-mode="open"]')).toBeVisible()
  await expect(
    page.getByTestId('tray-cards'),
    'expanding via ▤ lands with the tray open',
  ).toBeVisible()

  // Fold again, land on the superagent half.
  await page.getByTitle('Fold the tray and superagent column').click()
  await expect(folded).toBeVisible()
  await folded.getByTitle('Expand superagent', { exact: true }).click()
  await expect(page.locator('[data-superagent-mode="open"]')).toBeVisible()
  await expect(
    page.locator('[data-superagent-composer]'),
    'expanding via ✦ lands with the chat open',
  ).toBeVisible()

  // ---- Empty tray: scope to the working child (no human-actionable items) ----
  const feed2 = page.getByTestId('super-event-feed')
  await feed2
    .getByRole('button')
    .filter({ hasText: `Working child ${stamp}` })
    .last()
    .click()
  await expect(page.getByTestId('tray-empty')).toContainText('Nothing waiting on you', {
    timeout: 10_000,
  })
  await page.screenshot({ path: 'test-results/engraved-column-empty-tray.png' })
})
