import { basename } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop verification: the sidebar is desktop-only')
test.setTimeout(120_000)

const HTTP = RELAY.replace(/^ws/, 'http')
const PORT = Number(process.env.PORT ?? 8799)

interface WireIssue {
  id: string
  title: string
  archived: boolean
  unread?: boolean
  readAt?: string | null
  closedReason?: string | null
}

async function rpc<T>(
  request: APIRequestContext,
  proc: string,
  input?: unknown,
  method: 'post' | 'get' = 'post',
): Promise<T> {
  const response =
    method === 'get'
      ? await request.get(
          `${HTTP}/trpc/${proc}${input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`,
        )
      : await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
  if (!response.ok()) throw new Error(`${proc} -> ${response.status()}: ${await response.text()}`)
  const body = (await response.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

async function createIssue(
  request: APIRequestContext,
  repoPath: string,
  title: string,
  startNow = false,
): Promise<string> {
  const issue = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    title,
    startNow,
  })
  return issue.id
}

async function closeIssue(request: APIRequestContext, id: string, read: boolean): Promise<void> {
  await rpc(request, 'issues.close', { id, reason: 'done' })
  await rpc(request, read ? 'issues.markRead' : 'issues.markUnread', { id })
}

async function openSidebar(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

test('closed rows fold locally after their result is read and focus moves away', async ({
  page,
  request,
}) => {
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos.find((repo) => basename(repo) === `zz-podium-e2e-repo-${PORT}`) ?? repos[0]
  if (!repoPath) throw new Error('harness registered no repo')

  const suffix = Date.now()
  const alphaTitle = `Closed fold alpha ${suffix}`
  const betaTitle = `Closed fold beta ${suffix}`
  const handoffTitle = `Closed fold handoff ${suffix}`
  const focusTitle = `Closed fold focus ${suffix}`

  const alpha = await createIssue(request, repoPath, alphaTitle)
  const beta = await createIssue(request, repoPath, betaTitle)
  const handoff = await createIssue(request, repoPath, handoffTitle)
  await closeIssue(request, alpha, true)
  await closeIssue(request, beta, true)
  await closeIssue(request, handoff, false)
  await createIssue(request, repoPath, focusTitle, true)

  await expect
    .poll(async () => {
      const issues = await rpc<WireIssue[]>(request, 'issues.list', { repoPath }, 'get')
      return issues
        .filter((issue) => [alpha, beta, handoff].includes(issue.id))
        .map((issue) => ({ id: issue.id, closed: issue.closedReason, unread: issue.unread }))
    })
    .toEqual(
      expect.arrayContaining([
        { id: alpha, closed: 'done', unread: false },
        { id: beta, closed: 'done', unread: false },
        { id: handoff, closed: 'done', unread: true },
      ]),
    )

  await openSidebar(page)
  const aside = page.locator('aside').first()
  const project = aside.getByTestId('project-group').filter({ hasText: focusTitle }).first()
  const fold = project.getByRole('button', { name: /^Closed · \d+$/ })
  const handoffRow = aside
    .getByTestId('unified-issue-row')
    .filter({ hasText: handoffTitle })
    .first()

  await expect(fold).toBeVisible({ timeout: 30_000 })
  const initialCount = Number((await fold.textContent())?.match(/\d+/)?.[0])
  expect(initialCount).toBeGreaterThanOrEqual(2)
  await expect(fold).toHaveAttribute('aria-expanded', 'false')
  await expect(aside.getByText(alphaTitle)).toHaveCount(0)
  await expect(aside.getByText(betaTitle)).toHaveCount(0)
  await expect(handoffRow).toBeVisible()
  await expect(handoffRow.getByRole('img', { name: 'Unread update' })).toBeVisible()

  await fold.click()
  await expect(fold).toHaveAttribute('aria-expanded', 'true')
  await expect(aside.getByText(alphaTitle)).toBeVisible()
  await expect(aside.getByText(betaTitle)).toBeVisible()

  const closedRows = project.getByTestId('closed-fold-rows')
  const settledRow = closedRows
    .getByTestId('unified-issue-row')
    .filter({ hasText: alphaTitle })
    .first()
  const orderBeforeSelection = await closedRows
    .getByTestId('unified-issue-row')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-issue-row')))
  await settledRow.locator('button.flex-1').first().click()
  await expect(settledRow).toBeVisible()
  await expect(settledRow.locator(':scope > [data-selected="true"]')).toBeVisible()
  await expect
    .poll(() =>
      closedRows
        .getByTestId('unified-issue-row')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-issue-row'))),
    )
    .toEqual(orderBeforeSelection)

  await fold.click()

  await handoffRow.locator('button.flex-1').first().click()
  await expect(handoffRow).toBeVisible()
  await expect(handoffRow.getByRole('img', { name: 'Unread update' })).toHaveCount(0)
  await expect(fold).toHaveText(`Closed · ${initialCount}`)

  const focusRow = aside.getByTestId('unified-issue-row').filter({ hasText: focusTitle }).first()
  await expect(focusRow).toBeVisible()
  await focusRow.locator('button.flex-1').first().click()

  const grownFold = project.getByRole('button', { name: `Closed · ${initialCount + 1}` })
  await expect(grownFold).toBeVisible()
  await expect(aside.getByText(handoffTitle)).toHaveCount(0)
  await grownFold.click()
  await expect(aside.getByText(handoffTitle)).toBeVisible()

  const closed = (await rpc<WireIssue[]>(request, 'issues.list', { repoPath }, 'get')).filter(
    (issue) => [alpha, beta, handoff].includes(issue.id),
  )
  expect(closed.every((issue) => issue.archived === false)).toBe(true)

  // Closed rows expose one quiet removal action on hover/focus. Drive the real
  // button and verify the server mutation removes only that issue from the
  // sidebar; closing and archiving remain separate lifecycle transitions.
  const betaFoldRow = closedRows
    .getByTestId('closed-fold-row')
    .filter({ hasText: betaTitle })
    .first()
  const archiveButton = betaFoldRow.getByTestId('closed-issue-archive')
  await betaFoldRow.hover()
  await expect(archiveButton).toBeVisible()
  if (process.env.CLOSED_FOLD_SHOT) {
    await aside.screenshot({ path: process.env.CLOSED_FOLD_SHOT })
  }
  await archiveButton.click()
  await expect
    .poll(async () => {
      const issues = await rpc<WireIssue[]>(request, 'issues.list', { repoPath }, 'get')
      return issues.find((issue) => issue.id === beta)?.archived
    })
    .toBe(true)
  await expect(aside.getByText(betaTitle)).toHaveCount(0)
})

test('sidebar rows make room, depart, then enter Closed', async ({ page, request }) => {
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos.find((repo) => basename(repo) === `zz-podium-e2e-repo-${PORT}`) ?? repos[0]
  if (!repoPath) throw new Error('harness registered no repo')

  const suffix = Date.now()
  const siblingTitle = `Motion sibling ${suffix}`
  const movingTitle = `Motion handoff ${suffix}`
  const anchorTitle = `Motion closed anchor ${suffix}`
  await createIssue(request, repoPath, siblingTitle, true)
  const moving = await createIssue(request, repoPath, movingTitle)
  const anchor = await createIssue(request, repoPath, anchorTitle)
  await closeIssue(request, anchor, true)

  await openSidebar(page)
  const aside = page.locator('aside').first()
  const project = aside.getByTestId('project-group').filter({ hasText: siblingTitle }).first()
  const fold = project.getByRole('button', { name: /^Closed · \d+$/ })
  await expect(fold).toBeVisible({ timeout: 30_000 })
  await fold.click()

  const siblingRow = project
    .getByTestId('unified-issue-row')
    .filter({ hasText: siblingTitle })
    .first()
  const siblingBefore = await siblingRow.boundingBox()
  if (!siblingBefore) throw new Error('motion sibling was not measurable')

  const arrivalTitle = `Motion arrival ${suffix}`
  await createIssue(request, repoPath, arrivalTitle, true)
  const arrival = project
    .locator('[data-transition-phase]')
    .filter({ hasText: arrivalTitle })
    .first()
  await expect(arrival).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(120)
  const arrivalOpacity = await arrival.evaluate((element) =>
    Number(getComputedStyle(element.firstElementChild as Element).opacity),
  )
  expect(arrivalOpacity).toBeLessThan(0.95)
  if (process.env.SIDEBAR_MOTION_ARRIVAL_SHOT) {
    await aside.screenshot({ path: process.env.SIDEBAR_MOTION_ARRIVAL_SHOT })
  }
  await expect(arrival).toHaveAttribute('data-transition-phase', 'stable', {
    timeout: 5_000,
  })
  const siblingAfter = await siblingRow.boundingBox()
  if (!siblingAfter) throw new Error('motion sibling disappeared after arrival')
  expect(siblingAfter.y).toBeGreaterThan(siblingBefore.y + 20)

  await rpc(request, 'issues.close', { id: moving, reason: 'done' })
  await rpc(request, 'issues.markRead', { id: moving })
  const departure = project
    .locator('[data-transition-phase="exiting"]')
    .filter({ hasText: movingTitle })
    .first()
  await expect(departure).toBeVisible({ timeout: 10_000 })
  await expect(project.getByTestId('closed-fold-rows').getByText(movingTitle)).toHaveCount(0)
  if (process.env.SIDEBAR_MOTION_DEPARTURE_SHOT)
    await aside.screenshot({ path: process.env.SIDEBAR_MOTION_DEPARTURE_SHOT })
  await page.waitForTimeout(350)
  await expect(departure).toHaveCount(1)
  await expect(project.getByTestId('closed-fold-rows').getByText(movingTitle)).toHaveCount(0)

  const closedArrival = project
    .getByTestId('closed-fold-rows')
    .locator('[data-transition-phase="entering"]')
    .filter({ hasText: movingTitle })
    .first()
  await expect(closedArrival).toBeVisible({ timeout: 5_000 })
  await expect(departure).toHaveCount(0)
})

test('snoozed issues fold, re-arrive, and expose no drag target', async ({ page, request }) => {
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos.find((repo) => basename(repo) === `zz-podium-e2e-repo-${PORT}`) ?? repos[0]
  if (!repoPath) throw new Error('harness registered no repo')

  const suffix = Date.now()
  const snoozedTitle = `Snoozed fold ${suffix}`
  const returnedTitle = `Returned defer ${suffix}`
  const snoozed = await createIssue(request, repoPath, snoozedTitle)
  const returned = await createIssue(request, repoPath, returnedTitle)
  for (const id of [snoozed, returned]) {
    await rpc(request, 'issues.update', { id, patch: { stage: 'planning' } })
    await rpc(request, 'issues.defer', {
      id,
      until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
  }
  await rpc(request, 'issues.undefer', { id: returned })

  await openSidebar(page)
  const aside = page.locator('aside').first()
  const project = aside.getByTestId('project-group').filter({ hasText: returnedTitle }).first()
  const fold = project.getByRole('button', { name: /^Snoozed · \d+$/ })

  await expect(fold).toBeVisible({ timeout: 30_000 })
  await expect(fold).toHaveAttribute('aria-expanded', 'false')
  await expect(aside.getByText(snoozedTitle)).toHaveCount(0)

  const returnedRow = project.getByTestId('unified-issue-row').filter({ hasText: returnedTitle })
  await expect(returnedRow).toBeVisible()
  await expect(returnedRow.getByText('Unsnoozed')).toBeVisible()
  await expect(returnedRow.getByTestId('row-grip')).toHaveCount(1)
  expect(await returnedRow.evaluate((row) => row.parentElement?.dataset.dragKey)).toBe(returned)

  await fold.click()
  const foldedRow = project.getByTestId('snoozed-fold-row').filter({ hasText: snoozedTitle })
  await expect(foldedRow).toBeVisible()
  await expect(foldedRow.getByTestId('row-grip')).toHaveCount(0)
  await expect(foldedRow.locator('[data-drag-key]')).toHaveCount(0)
  expect(
    await foldedRow.evaluate((row) =>
      row
        .getAnimations({ subtree: true })
        .some(
          (animation) =>
            animation instanceof CSSAnimation && animation.animationName === 'podium-arrive-h',
        ),
    ),
  ).toBe(true)
  if (process.env.SNOOZED_FOLD_SHOT) await aside.screenshot({ path: process.env.SNOOZED_FOLD_SHOT })

  await foldedRow.evaluate((row) => {
    for (const animation of row.getAnimations({ subtree: true })) animation.finish()
  })
  await fold.click()
  await fold.click()
  const returnedFoldRow = project.getByTestId('snoozed-fold-row').filter({ hasText: snoozedTitle })
  await expect(returnedFoldRow).toBeVisible()
  expect(
    await returnedFoldRow.evaluate((row) =>
      row
        .getAnimations({ subtree: true })
        .some(
          (animation) =>
            animation instanceof CSSAnimation && animation.animationName === 'podium-arrive-h',
        ),
    ),
  ).toBe(true)
})
