import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * Runtime verification of the hierarchical issue tracker view (#85) against the
 * REAL Live UI on the harness relay: sub-issues are hidden at the top level by
 * default (board and list), the parent grows an Epic badge + n/m progress
 * fraction, a list-row chevron expands the nested children, the Flatten toggle
 * restores the old flat view, and the sidebar Issues tab nests children under
 * their parent's chevron.
 *
 * Desktop-only: the "Issues" nav button lives in the <aside> Sidebar, which the
 * mobile layout (MobileApp) does not render.
 */
test.skip(
  ({ isMobile }) => isMobile,
  'desktop test (Issues nav button lives in the <aside> Sidebar)',
)

/** Open the Live UI app shell pointed at the harness relay with the e2e API. */
async function openShell(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

/** Create a worktree-less Backlog issue via the composer and wait for its card. */
async function createBacklogIssue(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New Issue', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'New Issue' })).toBeVisible({ timeout: 10_000 })
  await dialog.getByLabel('Title').fill(title)
  const startNow = dialog.getByRole('checkbox', { name: 'Start work now' })
  await expect(startNow).toBeChecked()
  await startNow.uncheck()
  const createBtn = dialog.getByRole('button', { name: /^Create$/ })
  await expect(createBtn).toBeEnabled({ timeout: 15_000 })
  await createBtn.click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })
}

test('issues hierarchy: nested children, epic badge + fraction, flatten toggle, sidebar nesting', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  await page.locator('button[title="Issues"]').click({ timeout: 15_000 })
  const board = page.getByRole('region', { name: 'Issues' })
  await expect(board).toBeVisible({ timeout: 10_000 })

  // ---- Seed a parent + child: create the parent, then add a sub-issue inline ----
  const stamp = Date.now()
  const parentTitle = `E2E hier parent ${stamp}`
  const childTitle = `E2E hier child ${stamp}`
  await createBacklogIssue(page, parentTitle)

  const backlogColumn = board
    .locator('div.w-\\[280px\\]')
    .filter({ has: page.getByRole('heading', { name: 'Backlog', exact: true }) })
    .first()
  const parentCard = backlogColumn.getByText(parentTitle, { exact: false })
  await expect(parentCard).toBeVisible({ timeout: 15_000 })

  await parentCard.click()
  const issuePage = page.locator('[data-testid="issue-page"]')
  await expect(issuePage).toBeVisible({ timeout: 10_000 })
  const subIssues = issuePage.getByTestId('sub-issues')
  await subIssues.getByRole('button', { name: /Add sub-issue/ }).click({ timeout: 10_000 })
  const input = subIssues.getByLabel('Sub-issue title')
  await input.fill(childTitle)
  await input.press('Enter')
  await expect(
    subIssues.getByRole('button', { name: new RegExp(childTitle) }),
    'the child row appears on the parent page',
  ).toBeVisible({ timeout: 15_000 })
  await page.locator('button[title="Back"]').click({ timeout: 10_000 })
  await expect(board).toBeVisible({ timeout: 10_000 })

  // ---- Board (default = nested): child hidden, parent shows Epic badge + 0/1 ----
  await expect(
    board.getByText(childTitle, { exact: false }),
    'the child card is hidden at the top level of the board',
  ).toHaveCount(0, { timeout: 15_000 })
  const parentCardBox = backlogColumn
    .locator('[data-issue-id]')
    .filter({ hasText: parentTitle })
    .first()
  await expect(
    parentCardBox.getByText('Epic', { exact: true }),
    'the parent card grows an Epic badge',
  ).toBeVisible({ timeout: 15_000 })
  await expect(
    parentCardBox.getByText('0/1', { exact: true }),
    'the parent card rolls its children up as a 0/1 fraction',
  ).toBeVisible()

  // ---- Flatten toggle: the child surfaces at the top level, then hides again ----
  const flattenBtn = board.getByRole('button', { name: 'Flatten', exact: true })
  await flattenBtn.click()
  await expect(
    backlogColumn.getByText(childTitle, { exact: false }),
    'flatten shows the child as a top-level Backlog card',
  ).toBeVisible({ timeout: 15_000 })
  await flattenBtn.click()
  await expect(
    board.getByText(childTitle, { exact: false }),
    'un-flattening hides the child again',
  ).toHaveCount(0, { timeout: 15_000 })

  // ---- List layout: chevron expands the nested (indented) child row ----
  await board.getByRole('button', { name: 'Display', exact: true }).click({ timeout: 10_000 })
  const menu = page.locator('[data-slot="dropdown-menu-content"]')
  await menu.getByRole('menuitemradio').filter({ hasText: 'List' }).click({ timeout: 10_000 })
  const list = page.locator('[data-testid="issues-list"]')
  await expect(list).toBeVisible({ timeout: 10_000 })
  // Radio items keep the Base UI menu (and its pointer-intercepting backdrop)
  // open — close it before clicking rows underneath.
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0, { timeout: 10_000 })

  const parentRow = list.locator('[data-issue-id]').filter({ hasText: parentTitle }).first()
  await expect(parentRow).toBeVisible({ timeout: 10_000 })
  await expect(parentRow.getByText('Epic', { exact: true }), 'list row Epic badge').toBeVisible()
  await expect(list.getByText(childTitle, { exact: false })).toHaveCount(0)

  await parentRow.locator(`[aria-label="Expand ${parentTitle}"]`).click({ timeout: 10_000 })
  const childRow = list.locator('[data-issue-id]').filter({ hasText: childTitle }).first()
  await expect(childRow, 'expanding the parent reveals the nested child row').toBeVisible({
    timeout: 10_000,
  })
  // The child row is indented relative to its parent.
  const parentPad = await parentRow.evaluate((el) => getComputedStyle(el).paddingLeft)
  const childPad = await childRow.evaluate((el) => getComputedStyle(el).paddingLeft)
  expect(Number.parseFloat(childPad), 'child row is indented').toBeGreaterThan(
    Number.parseFloat(parentPad),
  )

  // Collapse hides it again.
  await parentRow.locator(`[aria-label="Collapse ${parentTitle}"]`).click({ timeout: 10_000 })
  await expect(list.getByText(childTitle, { exact: false })).toHaveCount(0, { timeout: 10_000 })

  // Restore the Board layout for sibling specs sharing localStorage defaults.
  await board.getByRole('button', { name: 'Display', exact: true }).click({ timeout: 10_000 })
  await menu.getByRole('menuitemradio').filter({ hasText: 'Board' }).click({ timeout: 10_000 })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0, { timeout: 10_000 })

  // ---- Sidebar Issues tab: child nests under the parent's chevron ----
  const aside = page.locator('aside').first()
  await aside.locator('button').filter({ hasText: /^Issues$/ }).click({ timeout: 10_000 })
  const parentBlock = aside.getByRole('button', { name: new RegExp(parentTitle) }).first()
  await expect(parentBlock, 'the parent shows in the sidebar Issues tab').toBeVisible({
    timeout: 15_000,
  })
  // The child is NOT a top-level row (only reachable via the parent's chevron).
  await expect(aside.getByText(childTitle, { exact: false })).toHaveCount(0)
  await aside.locator(`[aria-label="Expand ${parentTitle}"]`).click({ timeout: 10_000 })
  await expect(
    aside.getByText(childTitle, { exact: false }),
    'expanding the parent block reveals the nested child',
  ).toBeVisible({ timeout: 10_000 })
})
