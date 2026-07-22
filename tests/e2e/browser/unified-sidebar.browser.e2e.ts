import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * Runtime verification of the unified sidebar — now THE sidebar (the classic
 * layout and its temporary switcher were removed) — against the REAL Live UI
 * on the harness relay: the `New <Agent> in <Repo>` split button with its
 * two-level agent→repo menu, the spawn-with-draft-issue flow producing a draft
 * row live from the broadcasts, and the widened New Issue dialog opened from
 * the sidebar `+`.
 *
 * Desktop-only: the <aside> Sidebar is not rendered by the mobile layout.
 */
test.skip(({ isMobile }) => isMobile, 'desktop test (the <aside> Sidebar is desktop-only)')
test.setTimeout(120_000)

const HTTP = RELAY.replace(/^ws/, 'http')

async function rpc<T>(
  request: APIRequestContext,
  proc: string,
  input?: unknown,
  method: 'post' | 'get' = 'post',
): Promise<T> {
  const response =
    method === 'post'
      ? await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
      : await request.get(`${HTTP}/trpc/${proc}`)
  if (!response.ok()) throw new Error(`${proc} → ${response.status()}: ${await response.text()}`)
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

test('unified sidebar: split-button spawn creates a draft row, wider + dialog', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)
  const aside = page.locator('aside').first()

  // Unified is THE sidebar now: no layout switcher, no classic Superagent row —
  // and since the shell relayout (#40) + sidebar redesign (#41) the app nav
  // lives in the top bar, NOT the sidebar: the aside is the work list only.
  await expect(aside.getByRole('button', { name: 'unified', exact: true })).toHaveCount(0)
  await expect(aside.getByRole('button', { name: 'classic', exact: true })).toHaveCount(0)
  await expect(aside.getByRole('button', { name: /Superagent/ })).toHaveCount(0)
  await expect(aside.getByRole('button', { name: /Command center/ })).toHaveCount(0)
  await expect(aside.getByRole('button', { name: 'Issues', exact: true })).toHaveCount(0)

  // ---- The button renders `New <Agent> in <Repo>` once repos load ----
  const splitMain = aside.getByRole('button', { name: /^New .+ in .+/ })
  await expect(splitMain).toBeVisible({ timeout: 20_000 })
  await expect(splitMain).toBeEnabled({ timeout: 20_000 })

  // ---- Two-level menu: agents at level 1, repos revealed on the submenu ----
  await aside.getByRole('button', { name: 'Choose agent and repo' }).click()
  const agentItem = page.getByRole('menuitem', { name: 'New Claude', exact: true })
  await expect(agentItem).toBeVisible({ timeout: 10_000 })

  // The menu is anchored to the WHOLE bordered button: it opens directly under
  // it, left-aligned, at the button's width.
  const buttonBox = await aside.getByTestId('new-agent-button').boundingBox()
  const menuBox = await page.locator('[data-slot="dropdown-menu-content"]').first().boundingBox()
  expect(buttonBox).not.toBeNull()
  expect(menuBox).not.toBeNull()
  if (buttonBox && menuBox) {
    expect(Math.abs(menuBox.x - buttonBox.x)).toBeLessThan(2)
    expect(menuBox.y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height)
    expect(menuBox.y).toBeLessThan(buttonBox.y + buttonBox.height + 12)
    expect(Math.abs(menuBox.width - buttonBox.width)).toBeLessThan(3)
  }

  await agentItem.hover()
  // The harness registers one repo; its name appears in the submenu.
  const repoItems = page.getByRole('menuitem')
  await expect.poll(async () => repoItems.count(), { timeout: 10_000 }).toBeGreaterThan(1)
  await page.keyboard.press('Escape')

  // ---- Main click spawns agent + draft issue; a draft row appears live ----
  const rowsBefore = await aside.getByTestId('unified-issue-row').count()
  await splitMain.click()
  await expect
    .poll(async () => aside.getByTestId('unified-issue-row').count(), { timeout: 30_000 })
    .toBeGreaterThan(rowsBefore)

  // Spawn a SECOND agent into the same repo's primary worktree: its worktree row
  // now has 2 sessions → expandable, child rows with right-aligned smaller dots.
  await splitMain.click()
  await page.waitForTimeout(3_000)
  if (process.env.SIDEBAR_SHOT) {
    await aside.screenshot({ path: process.env.SIDEBAR_SHOT })
  }

  // ---- "New issue…" (inside the agent/repo menu) opens the widened dialog ----
  await aside.getByRole('button', { name: 'Choose agent and repo' }).click()
  await page.getByRole('menuitem', { name: /New issue/ }).click({ timeout: 10_000 })
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'New Issue' })).toBeVisible({
    timeout: 10_000,
  })
  const box = await dialog.boundingBox()
  expect(box, 'dialog has a bounding box').not.toBeNull()
  // max-w-2xl = 672px; the old max-w-md was 448px. Assert we're clearly wider.
  expect(box?.width ?? 0).toBeGreaterThan(600)
  await page.keyboard.press('Escape')
})

test('sidebar width is draggable via the right-edge handle and persists', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)
  const aside = page.locator('aside').first()
  const handle = page.getByRole('separator', { name: 'Resize sidebar' })
  await expect(handle).toBeVisible({ timeout: 10_000 })

  const before = (await aside.boundingBox())?.width ?? 0
  const hb = await handle.boundingBox()
  expect(hb).not.toBeNull()
  if (!hb) return
  const y = hb.y + 200
  await page.mouse.move(hb.x + hb.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(hb.x + hb.width / 2 + 120, y, { steps: 8 })
  await page.mouse.up()

  const after = (await aside.boundingBox())?.width ?? 0
  expect(after).toBeGreaterThan(before + 80)

  // Width persists to localStorage and survives a reload.
  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  const reloaded = (await page.locator('aside').first().boundingBox())?.width ?? 0
  expect(Math.abs(reloaded - after)).toBeLessThan(3)
})

test('nested fleets fold cleanly and unattached main sessions never become sidebar rows', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos[0]
  if (!repoPath) throw new Error('harness registered no repo')

  const stamp = Date.now().toString(36)
  const parentTitle = `Fleet hierarchy ${stamp}`
  const childTitle = `Fleet child ${stamp}`
  const parent = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    title: parentTitle,
    startNow: true,
  })
  await rpc(request, 'issues.update', { id: parent.id, patch: { color: 'pink' } })
  await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    title: childTitle,
    parentId: parent.id,
    startNow: true,
  })

  await expect
    .poll(
      async () =>
        (
          await rpc<Array<{ sessionId: string; cwd: string; issueId?: string }>>(
            request,
            'sessions.list',
            undefined,
            'get',
          )
        ).some((session) => session.issueId === parent.id),
      { timeout: 30_000 },
    )
    .toBe(true)
  const parentSession = (
    await rpc<Array<{ sessionId: string; cwd: string; issueId?: string }>>(
      request,
      'sessions.list',
      undefined,
      'get',
    )
  ).find((session) => session.issueId === parent.id)
  if (!parentSession) throw new Error('parent session did not materialize')
  await rpc(request, 'sessions.create', {
    agentKind: 'claude-code',
    cwd: parentSession.cwd,
    issueId: parent.id,
    title: `Fleet peer ${stamp}`,
  })
  await rpc(request, 'sessions.create', {
    agentKind: 'claude-code',
    cwd: repoPath,
    title: `Abandoned session sentinel ${stamp}`,
  })

  await openShell(page)
  const aside = page.locator('aside').first()
  const parentRow = aside.getByTestId('unified-issue-row').filter({ hasText: parentTitle }).first()
  await expect(parentRow).toBeVisible({ timeout: 30_000 })
  const parentSurface = parentRow.locator(':scope > [data-phase]')
  const parentFleet = parentSurface.getByTestId('issue-fleet-summary')
  const tree = parentRow.getByTestId('started-by-children')
  await expect(tree).toBeVisible()
  await expect(tree.locator(':scope > [data-drag-key]')).toContainText(childTitle)
  await expect(parentRow.getByTestId('agent-roster-band')).toBeVisible()
  await expect(parentFleet).toHaveAttribute('aria-label', '2 agents')

  const geometry = await parentRow.evaluate((row) => {
    const surface = row.querySelector<HTMLElement>('[data-phase]')
    const grip = row.querySelector<HTMLElement>('[data-testid="row-grip"]')
    const square = row.querySelector<HTMLElement>('[data-testid="issue-id-square"]')
    const guide = row.querySelector<HTMLElement>('.tree-guide')
    const child = row.querySelector<HTMLElement>('[data-drag-key]')
    if (!surface || !grip || !square || !guide || !child) return null
    const rect = (el: HTMLElement) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    return {
      surface: rect(surface),
      grip: rect(grip),
      square: rect(square),
      guide: rect(guide),
      child: rect(child),
      treeGuide: getComputedStyle(guide).backgroundColor,
    }
  })
  expect(geometry).not.toBeNull()
  if (geometry) {
    expect(geometry.grip.x + geometry.grip.width).toBeLessThanOrEqual(geometry.square.x)
    expect(geometry.child.x).toBeGreaterThan(geometry.surface.x)
    expect(geometry.guide.x).toBeLessThan(geometry.child.x)
    expect(geometry.treeGuide).not.toBe('rgba(0, 0, 0, 0)')
  }

  await parentRow.getByRole('button', { name: `Collapse ${parentTitle}` }).click()
  await expect(parentRow.getByTestId('agent-roster-band')).toHaveCount(0)
  await expect(parentRow.getByTestId('started-by-children')).toHaveCount(0)
  await expect(parentFleet).toBeVisible()

  await parentRow.getByRole('button', { name: `Expand ${parentTitle}` }).click()
  await expect(parentRow.getByTestId('agent-roster-band')).toBeVisible()
  await expect(parentRow.getByTestId('started-by-children')).toBeVisible()

  await expect(aside.getByText(`Abandoned session sentinel ${stamp}`)).toHaveCount(0)
  await expect(aside.getByTestId('unified-worktree-row')).toHaveCount(0)
  await aside.screenshot({ path: 'test-results/sidebar-fleet-hierarchy.png' })
})
