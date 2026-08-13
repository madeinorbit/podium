import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

const HTTP = RELAY.replace(/^ws/, 'http')
const ARTIFACT = 'artifacts/pod853-windowed-keyboard-drag.png'

async function rpc<T>(
  request: APIRequestContext,
  procedure: string,
  input?: unknown,
  method: 'post' | 'get' = 'post',
): Promise<T> {
  const response =
    method === 'get'
      ? await request.get(
          `${HTTP}/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
        )
      : await request.post(`${HTTP}/trpc/${procedure}`, { data: input ?? {} })
  if (!response.ok()) {
    throw new Error(`${procedure} -> ${response.status()}: ${await response.text()}`)
  }
  const body = (await response.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

async function openTasks(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.getByTestId('topbar-nav-issues').click()
  await expect(page.getByRole('region', { name: 'Tasks' })).toBeVisible({ timeout: 15_000 })
}

test.setTimeout(120_000)
test('windowed Kanban keeps keyboard focus and pointer drag routing across its mount boundary', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'desktop pointer boundary')
  await page.setViewportSize({ width: 1440, height: 900 })
  const repoPath = (await rpc<string[]>(request, 'repos.list', undefined, 'get'))[0]
  if (!repoPath) throw new Error('harness registered no repo')

  const stamp = Date.now()
  const created = await Promise.all(
    Array.from({ length: 48 }, (_, index) =>
      rpc<{ id: string }>(request, 'issues.create', {
        repoPath,
        title: `Window boundary ${stamp} ${index}`,
        startNow: false,
      }),
    ),
  )
  await Promise.all(
    created.map((issue) =>
      rpc(request, 'issues.update', { id: issue.id, patch: { stage: 'backlog' } }),
    ),
  )
  await openTasks(page)

  const board = page.getByRole('region', { name: 'Tasks' })
  const backlog = board.locator('[data-kanban-column="backlog"]')
  const first = backlog.locator('[data-issue-id]').first()
  await expect(first).toBeVisible({ timeout: 15_000 })
  await first.hover()
  await backlog
    .getByRole('button', { name: /^Select / })
    .first()
    .click()
  await expect(page.getByText('1 selected')).toBeVisible()
  for (let step = 0; step < 25; step++) await page.keyboard.press('j')
  await expect(page.getByText('1 selected')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText('1 selected')).toHaveCount(0)

  const source = backlog.locator('[data-issue-id].ring-2')
  const target = board.locator('[data-kanban-column="in_progress"]')
  await expect(source).toBeVisible({ timeout: 15_000 })
  expect(
    await backlog.getByTestId('column-scroll').evaluate((node) => node.scrollTop),
  ).toBeGreaterThan(0)
  expect(await backlog.locator('[data-issue-id]').count()).toBeLessThanOrEqual(36)
  const sourceId = await source.getAttribute('data-issue-id')
  if (!sourceId) throw new Error('keyboard-focused drag source has no issue id')
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('drag source or target has no browser geometry')

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 100, { steps: 12 })
  await expect(page.locator('body > .will-change-transform')).toBeVisible()
  await expect(target.getByTestId('kanban-drop-line')).toBeVisible()
  await page.screenshot({ path: ARTIFACT })
  await page.mouse.up()

  await expect(page.locator('body > .will-change-transform')).toHaveCount(0)
  await expect(page.locator('[data-testid="issue-page"]')).toHaveCount(0)
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
        ).find((candidate) => candidate.id === sourceId)?.stage,
      { timeout: 15_000 },
    )
    .toBe('in_progress')
})
