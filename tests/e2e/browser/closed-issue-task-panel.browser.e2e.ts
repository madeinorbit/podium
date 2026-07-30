import { basename } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop verification: the right dock is desktop-only')
test.setTimeout(120_000)

const HTTP = RELAY.replace(/^ws/, 'http')
const PORT = Number(process.env.PORT ?? 8799)

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

async function openSidebar(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

test('selecting a sessionless closed issue updates the Task dock', async ({ page, request }) => {
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos.find((repo) => basename(repo) === `zz-podium-e2e-repo-${PORT}`) ?? repos[0]
  if (!repoPath) throw new Error('harness registered no repo')

  const suffix = Date.now()
  const activeTitle = `Task dock active ${suffix}`
  const closedTitle = `Task dock closed ${suffix}`
  await rpc(request, 'issues.create', { repoPath, title: activeTitle, startNow: true })
  const closed = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    title: closedTitle,
    startNow: false,
  })
  await rpc(request, 'issues.close', { id: closed.id, reason: 'done' })
  await rpc(request, 'issues.markRead', { id: closed.id })

  await openSidebar(page)
  const aside = page.locator('aside').first()
  const project = aside.getByTestId('project-group').filter({ hasText: activeTitle }).first()
  const activeRow = project
    .getByTestId('unified-issue-row')
    .filter({ hasText: activeTitle })
    .first()
  await expect(activeRow).toBeVisible({ timeout: 30_000 })
  await activeRow.locator('button.flex-1').first().click()

  const rail = page.getByTestId('right-rail')
  const taskButton = rail.locator('button').first()
  if ((await taskButton.getAttribute('aria-pressed')) !== 'true') await taskButton.click()
  const taskDock = page.locator('[data-right-dock-panel="issue"]')
  await expect(taskDock).toContainText(activeTitle, { timeout: 30_000 })

  const fold = project.getByRole('button', { name: /^Closed · \d+$/ })
  await expect(fold).toBeVisible({ timeout: 30_000 })
  if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click()
  const closedRow = project
    .getByTestId('closed-fold-rows')
    .getByTestId('unified-issue-row')
    .filter({ hasText: closedTitle })
    .first()
  await expect(closedRow).toBeVisible()
  await closedRow.locator('button.flex-1').first().click()

  await expect(taskDock).toContainText(closedTitle)
  await expect(taskDock).not.toContainText(activeTitle)
})
