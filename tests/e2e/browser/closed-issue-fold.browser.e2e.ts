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

  if (process.env.CLOSED_FOLD_SHOT) {
    await aside.screenshot({ path: process.env.CLOSED_FOLD_SHOT })
  }
})
