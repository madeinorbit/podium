import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * THROWAWAY verification spec for issue #49: command palette (Ctrl+K) and the
 * issue right-click context menu. Mirrors issues.browser.e2e.ts conventions
 * (harness relay, worktree-less Backlog issues so no git ops run).
 */
test.skip(({ isMobile }) => isMobile, 'desktop-only verification')

const SHOT = '/home/user/src/other/podium/.worktrees/issue-49-command-palette/.e2e-verify'

async function openShell(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

async function gotoIssues(page: Page) {
  await page.locator('button[title="Issues"]').click({ timeout: 15_000 })
  const board = page.getByRole('region', { name: 'Issues' })
  await expect(board).toBeVisible({ timeout: 10_000 })
  return board
}

async function createBacklogIssue(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New Issue', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'New Issue' })).toBeVisible({ timeout: 10_000 })
  await dialog.getByLabel('Title').fill(title)
  const startNow = dialog.getByRole('checkbox', { name: 'Start work now' })
  await startNow.uncheck()
  const createBtn = dialog.getByRole('button', { name: /^Create$/ })
  await expect(createBtn).toBeEnabled({ timeout: 15_000 })
  await createBtn.click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })
}

test('command palette: open, search, arrow, enter-to-issue, fallback row, two-stage escape', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  // Seed a uniquely-named issue to search for.
  const board = await gotoIssues(page)
  const title = `Palette target ${Date.now()}`
  await createBacklogIssue(page, title)
  await expect(board.getByText(title, { exact: false })).toBeVisible({ timeout: 15_000 })

  // ---- Ctrl+K opens the palette with the input focused ----
  await page.keyboard.press('Control+k')
  const palette = page.locator('[aria-label="Command palette"]')
  await expect(palette).toBeVisible({ timeout: 10_000 })
  const input = palette.getByRole('combobox')
  await expect(input).toBeFocused()
  await page.screenshot({ path: `${SHOT}/palette-01-open.png` })

  // ---- Typing a query yields grouped results including the seeded issue ----
  await input.fill('Palette target')
  const issueOption = palette.getByRole('option').filter({ hasText: title }).first()
  await expect(issueOption).toBeVisible({ timeout: 10_000 })
  await expect(palette.getByText('Navigate', { exact: true })).toBeVisible()
  await page.screenshot({ path: `${SHOT}/palette-02-results.png` })

  // ---- ArrowDown moves the highlight ----
  const selectedIds = async () =>
    palette.locator('[role="option"][aria-selected="true"]').getAttribute('id')
  const first = await selectedIds()
  await input.press('ArrowDown')
  const second = await selectedIds()
  expect(first).not.toBe(second)
  await page.screenshot({ path: `${SHOT}/palette-03-arrowdown.png` })

  // ---- Enter on the issue result navigates to the issue page ----
  // Re-typing resets the highlight to the top result; the seeded issue's exact
  // title should be the best match. Click-free: press Enter on the highlighted row.
  await input.fill('')
  await input.fill(title)
  await expect(palette.getByRole('option').filter({ hasText: title }).first()).toBeVisible({
    timeout: 10_000,
  })
  const topSelected = palette.locator('[role="option"][aria-selected="true"]').first()
  await expect(topSelected).toContainText('Palette target')
  await input.press('Enter')
  await expect(palette).toBeHidden({ timeout: 10_000 })
  const issuePage = page.locator('[data-testid="issue-page"]')
  await expect(issuePage).toBeVisible({ timeout: 15_000 })
  await expect(issuePage.getByText(title, { exact: false })).toBeVisible({ timeout: 10_000 })
  await page.screenshot({ path: `${SHOT}/palette-04-enter-opened-issue.png` })

  // ---- Fallback row on gibberish, highlighted when nothing else matches ----
  await page.keyboard.press('Control+k')
  await expect(palette).toBeVisible({ timeout: 10_000 })
  await palette.getByRole('combobox').fill('zzqxjv gibberish 42')
  const fallback = palette.getByRole('option').filter({ hasText: 'New agent' }).first()
  await expect(fallback).toBeVisible({ timeout: 10_000 })
  await expect(fallback).toContainText('zzqxjv gibberish 42')
  await expect(fallback).toHaveAttribute('aria-selected', 'true')
  // It should be the ONLY row.
  await expect(palette.getByRole('option')).toHaveCount(1)
  await page.screenshot({ path: `${SHOT}/palette-05-fallback.png` })

  // ---- Two-stage Escape: clears query first, closes second ----
  await palette.getByRole('combobox').press('Escape')
  await expect(palette).toBeVisible()
  await expect(palette.getByRole('combobox')).toHaveValue('')
  await palette.getByRole('combobox').press('Escape')
  await expect(palette).toBeHidden({ timeout: 10_000 })
  await page.screenshot({ path: `${SHOT}/palette-06-closed.png` })

  expect(errors, `console/page errors: ${errors.join('\n')}`).toEqual([])
})

test('issue context menu: right-click, stage flyout updates the card, escape/outside dismiss', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)
  const board = await gotoIssues(page)

  const title = `CtxMenu target ${Date.now()}`
  await createBacklogIssue(page, title)

  const column = (name: string) =>
    board
      .locator('div.w-\\[280px\\]')
      .filter({ has: page.getByRole('heading', { name, exact: true }) })
      .first()
  const card = column('Backlog')
    .locator('[data-issue-id]')
    .filter({ hasText: title })
    .first()
  await expect(card).toBeVisible({ timeout: 15_000 })

  // ---- Right-click opens the menu at the cursor ----
  await card.click({ button: 'right' })
  const menu = page.locator('[role="menu"][aria-label="Issue actions"]')
  await expect(menu).toBeVisible({ timeout: 10_000 })
  await expect(menu.getByRole('menuitem', { name: 'Open' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Set stage' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Set priority' })).toBeVisible()
  await page.screenshot({ path: `${SHOT}/ctxmenu-01-open.png` })

  // ---- Hover "Set stage" → flyout; click a stage → card moves ----
  await menu.getByRole('menuitem', { name: 'Set stage' }).hover()
  const flyout = page.locator('[role="menu"][aria-label="stage options"]')
  await expect(flyout).toBeVisible({ timeout: 10_000 })
  await page.screenshot({ path: `${SHOT}/ctxmenu-02-stage-flyout.png` })
  await flyout.getByRole('menuitem').filter({ hasText: 'In Progress' }).click()
  await expect(menu).toHaveCount(0, { timeout: 10_000 })
  await expect(
    column('In Progress').locator('[data-issue-id]').filter({ hasText: title }),
    'the card moved to In Progress',
  ).toBeVisible({ timeout: 15_000 })
  await expect(column('Backlog').locator('[data-issue-id]').filter({ hasText: title })).toHaveCount(
    0,
  )
  await page.screenshot({ path: `${SHOT}/ctxmenu-03-stage-updated.png` })

  // ---- Escape dismisses ----
  const movedCard = column('In Progress').locator('[data-issue-id]').filter({ hasText: title }).first()
  await movedCard.click({ button: 'right' })
  await expect(menu).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0, { timeout: 10_000 })

  // ---- Outside click dismisses ----
  await movedCard.click({ button: 'right' })
  await expect(menu).toBeVisible({ timeout: 10_000 })
  await page.mouse.click(30, 500)
  await expect(menu).toHaveCount(0, { timeout: 10_000 })
  await page.screenshot({ path: `${SHOT}/ctxmenu-04-dismissed.png` })

  expect(errors, `console/page errors: ${errors.join('\n')}`).toEqual([])
})
