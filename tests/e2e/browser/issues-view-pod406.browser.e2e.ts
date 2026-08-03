import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

const HTTP = RELAY.replace(/^ws/, 'http')
const ARTIFACT = 'artifacts/pod406-issues-runtime.png'

async function rpc<T>(
  request: APIRequestContext,
  proc: string,
  input?: unknown,
  method: 'post' | 'get' = 'post',
): Promise<T> {
  const response =
    method === 'get'
      ? await request.get(
          `${HTTP}/trpc/${proc}${input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`,
        )
      : await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
  if (!response.ok()) throw new Error(`${proc} -> ${response.status()}: ${await response.text()}`)
  const body = (await response.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

async function openShell(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

test.setTimeout(120_000)
test('POD-406: real kanban drag, create-more property menu, context menu, and palette', async ({
  page,
  testInfo,
  request,
}) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop-only IssuesView flow')
  await page.setViewportSize({ width: 1440, height: 900 })
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos[0]
  if (!repoPath) throw new Error('harness registered no repo')

  let dragged: { id: string }

  await openShell(page)
  await page.getByTestId('topbar-nav-issues').click()
  const board = page.getByRole('region', { name: 'Tasks' })
  await expect(board).toBeVisible({ timeout: 15_000 })
  for (const stage of ['Proposed', 'Backlog', 'Planning', 'In Progress', 'Review', 'Done']) {
    await expect(board.getByRole('heading', { name: stage, exact: true })).toBeVisible()
  }

  dragged = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    title: `POD406 drag ${Date.now()}`,
    startNow: false,
  })
  await rpc(request, 'issues.update', { id: dragged.id, patch: { stage: 'backlog' } })

  const column = (stage: string) =>
    board
      .locator('div.w-\\[280px\\]')
      .filter({ has: page.getByRole('heading', { name: stage, exact: true }) })
      .first()
  const backlog = column('Backlog')
  const draggedCard = backlog.locator(`[data-issue-id="${dragged.id}"]`)
  await expect(draggedCard).toBeVisible({ timeout: 15_000 })
  const draggedSource = draggedCard.locator('..')
  await draggedSource.dragTo(column('In Progress'))
  await expect
    .poll(
      async () =>
        (
          await rpc<Array<{ id: string; stage: string }>>(
            request,
            'issues.list',
            { repoPath },
            'get',
          )
        ).find((issue) => issue.id === dragged.id)?.stage,
      { timeout: 15_000 },
    )
    .toBe('in_progress')
  await expect(column('In Progress').locator(`[data-issue-id="${dragged.id}"]`)).toBeVisible()

  // Real create-more flow and a real property-menu click (P2 → P1).
  await page.getByRole('button', { name: /New Task/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'New Task' })).toBeVisible()
  await dialog.getByRole('button', { name: /P2/ }).click()
  const propertyMenu = page.locator('[data-slot="dropdown-menu-content"]:visible')
  await propertyMenu.getByRole('menuitem').filter({ hasText: 'P1' }).click()
  await expect(dialog.getByRole('button', { name: /P1/ })).toBeVisible()
  await dialog.getByRole('switch', { name: 'Create more' }).click()
  await dialog.getByLabel('Title').fill(`POD406 inline one ${Date.now()}`)
  await dialog.getByRole('checkbox', { name: 'Start work now' }).uncheck()
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Title')).toHaveValue('')
  await expect(dialog.getByRole('button', { name: /P1/ })).toBeVisible()
  const createdTitle = `POD406 inline two ${Date.now()}`
  await dialog.getByRole('switch', { name: 'Create more' }).click()
  await dialog.getByLabel('Title').fill(createdTitle)
  await dialog.getByRole('checkbox', { name: 'Start work now' }).uncheck()
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })
  await expect(backlog.getByText(createdTitle, { exact: false })).toBeVisible({ timeout: 15_000 })

  // Real context-menu click: the same stage tree moves the dragged issue to Review.
  const reviewTarget = column('In Progress').locator(`[data-issue-id="${dragged.id}"]`)
  await reviewTarget.click({ button: 'right' })
  const contextMenu = page.locator('[role="menu"][aria-label="Task actions"]')
  await expect(contextMenu).toBeVisible()
  await contextMenu.getByRole('menuitem', { name: 'Set stage' }).hover()
  const stageMenu = page.locator('[role="menu"][aria-label="stage options"]')
  await expect(stageMenu).toBeVisible()
  await stageMenu.getByRole('menuitem').filter({ hasText: 'Review' }).click()
  await expect
    .poll(
      async () =>
        (
          await rpc<Array<{ id: string; stage: string }>>(
            request,
            'issues.list',
            { repoPath },
            'get',
          )
        ).find((issue) => issue.id === dragged.id)?.stage,
      { timeout: 15_000 },
    )
    .toBe('review')

  // Open the same issue, then real palette click on the same Set stage branch.
  await column('Review').locator(`[data-issue-id="${dragged.id}"]`).click()
  await expect(page.locator('[data-testid="issue-page"]')).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Control+k')
  const palette = page.locator('[aria-label="Command palette"]')
  await expect(palette).toBeVisible({ timeout: 10_000 })
  const paletteInput = palette.getByRole('combobox')
  await paletteInput.fill('Set stage Done')
  const paletteStage = palette
    .getByRole('option')
    .filter({ hasText: 'Set stage' })
    .filter({ hasText: 'Done' })
    .first()
  await expect(paletteStage).toBeVisible({ timeout: 10_000 })
  await page.screenshot({ path: ARTIFACT })
  await paletteStage.click()
  await expect(palette).toBeHidden({ timeout: 10_000 })
  await expect
    .poll(
      async () =>
        (
          await rpc<Array<{ id: string; stage: string }>>(
            request,
            'issues.list',
            { repoPath },
            'get',
          )
        ).find((issue) => issue.id === dragged.id)?.stage,
      { timeout: 15_000 },
    )
    .toBe('done')
})
