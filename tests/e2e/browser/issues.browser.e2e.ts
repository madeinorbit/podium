import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * Runtime verification of the Issues board against the REAL Live UI on the harness
 * relay. Covers the browser-only flow that unit tests cannot: the Sidebar "Issues"
 * nav button switching the main view, the kanban rendering one column per lifecycle
 * stage, the New Issue dialog creating a worktree-less (startNow=false) issue that
 * lands in Backlog via the live `issuesChanged` broadcast (no manual refetch), and
 * the detail panel's Stage selector moving a card across columns.
 *
 * The committed _harness `openApp`/`gotoWorkspace` helpers enter a worktree
 * *workspace*; the Issues board is a top-level view reached from the desktop
 * Sidebar's app-tools row, so we drive the DOM directly (mirroring clickable-files)
 * and click the "Issues" nav button instead.
 *
 * Desktop-only: the "Issues" nav button lives in the <aside> Sidebar, which the
 * mobile layout (MobileApp) does not render.
 */
test.skip(
  ({ isMobile }) => isMobile,
  'desktop test (Issues nav button lives in the <aside> Sidebar)',
)

/** Open the Live UI app shell pointed at the harness relay, with the e2e test API
 *  enabled, and wait for the cold-start load to finish. */
async function openShell(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  // The desktop layout renders an <aside> sidebar; wait for it so the app-tools row
  // (which holds the Issues nav button) is mounted.
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

const STAGES = ['Backlog', 'Planning', 'In Progress', 'Review', 'Verifying', 'Done'] as const

test('issues board: renders the stage columns, creates a Backlog issue, and moves its stage', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  // ---- Navigate to the Issues board via the Sidebar nav button ----
  // The button is an icon button whose accessible name derives from title="Issues".
  // Target the app-tools icon button by its title attribute — the accessible-name
  // selector now collides with the "Issues" sidebar tab and any worktree named "…issues…".
  await page.locator('button[title="Issues"]').click({ timeout: 15_000 })

  // The board is a <section aria-label="Issues"> with a header and six stage columns.
  const board = page.getByRole('region', { name: 'Issues' })
  await expect(board).toBeVisible({ timeout: 10_000 })

  // ---- All six lifecycle stage columns render (one <h3> heading each) ----
  for (const stage of STAGES) {
    await expect(
      board.getByRole('heading', { name: stage, exact: true }),
      `column "${stage}" renders`,
    ).toBeVisible()
  }

  // ---- Open the New Issue dialog ----
  await page.getByRole('button', { name: 'New Issue', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'New Issue' })).toBeVisible({ timeout: 10_000 })

  // Fill the title with a unique marker so it can't collide with a sibling spec or a
  // re-run sharing the same relay state.
  const title = `E2E board issue ${Date.now()}`
  await dialog.getByLabel('Title').fill(title)

  // UNcheck "Start work now" → the create mutation skips the git worktree op (which
  // would need a clean parent branch in the harness repo) and leaves the issue in
  // Backlog. The checkbox defaults to checked.
  const startNow = dialog.getByRole('checkbox', { name: 'Start work now' })
  await expect(startNow).toBeChecked()
  await startNow.uncheck()
  await expect(startNow).not.toBeChecked()

  // The Create button is disabled until a repo is selected; the harness registers
  // THIS repo, but repos load async, so wait for it to enable before clicking.
  const createBtn = dialog.getByRole('button', { name: /^Create$/ })
  await expect(createBtn).toBeEnabled({ timeout: 15_000 })
  await createBtn.click()

  // The dialog closes on success...
  await expect(dialog).toBeHidden({ timeout: 15_000 })

  // ...and the new card appears under Backlog (live via the issuesChanged broadcast).
  // Scope to the actual column container (each is a fixed-width div.w-[280px]) rather
  // than any ancestor div with a matching heading, so "not in Backlog" is exact.
  const column = (name: string) =>
    board
      .locator('div.w-\\[280px\\]')
      .filter({ has: page.getByRole('heading', { name, exact: true }) })
      .first()
  const backlogColumn = column('Backlog')
  const card = backlogColumn.getByText(title, { exact: false })
  await expect(card, 'the new issue card appears under Backlog').toBeVisible({ timeout: 15_000 })

  // ---- Move the issue's stage via the issue page's Status PropertyMenu ----
  await card.click()
  // Opening a card now renders the full issue page in-view (data-testid="issue-page"),
  // not an overlay drawer. Its main column shows the title as an editable button.
  const issuePage = page.locator('[data-testid="issue-page"]')
  await expect(issuePage).toBeVisible({ timeout: 10_000 })
  await expect(issuePage.getByText(title, { exact: false })).toBeVisible({ timeout: 10_000 })

  // The Status row is a Linear-style PropertyMenu (Task 9) in the desktop aside —
  // scope to the aside so the mirrored mobile Details rows don't double-match. It
  // currently reads "Backlog".
  const statusTrigger = page.getByTestId('issue-aside').getByTestId('status-trigger')
  await expect(statusTrigger).toContainText('Backlog')

  // --- Menu behavior (deferred Task 7 runtime verification) ---
  // (a) opening the menu focuses its type-ahead filter input.
  await statusTrigger.click()
  const menu = page.locator('[data-slot="dropdown-menu-content"]')
  const filterInput = menu.locator('input').first()
  await expect(filterInput).toBeFocused({ timeout: 10_000 })
  // (b) typing filters the options — "Planning" survives, "Backlog" is filtered out.
  // (Option accessible names double up the StageGlyph aria-label, so match by text.)
  await filterInput.fill('Planning')
  await expect(menu.getByRole('menuitem').filter({ hasText: 'Planning' })).toBeVisible()
  await expect(menu.getByRole('menuitem').filter({ hasText: 'Backlog' })).toHaveCount(0)
  // (c) Escape closes the menu WITHOUT navigating Back — the issue page stays open.
  await filterInput.press('Escape')
  await expect(menu).toHaveCount(0, { timeout: 10_000 })
  await expect(issuePage).toBeVisible()

  // Now actually change the stage: reopen, filter, and click "Planning".
  await statusTrigger.click()
  await page.locator('[data-slot="dropdown-menu-content"] input').first().fill('Planning')
  await page
    .locator('[data-slot="dropdown-menu-content"]')
    .getByRole('menuitem')
    .filter({ hasText: 'Planning' })
    .click({ timeout: 10_000 })
  await expect(statusTrigger).toContainText('Planning', { timeout: 10_000 })

  // Return to the board via the header Back button (title="Back"), then assert the
  // card has left Backlog and now lives under Planning (live via the broadcast).
  await page.locator('button[title="Back"]').click({ timeout: 10_000 })

  const planningColumn = column('Planning')
  await expect(
    planningColumn.getByText(title, { exact: false }),
    'the card moved to Planning',
  ).toBeVisible({ timeout: 15_000 })
  await expect(
    backlogColumn.getByText(title, { exact: false }),
    'the card is no longer in Backlog',
  ).toHaveCount(0)
})

test('issues composer: set a property pill, Create more keeps the dialog open for two issues', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  await page.locator('button[title="Issues"]').click({ timeout: 15_000 })
  const board = page.getByRole('region', { name: 'Issues' })
  await expect(board).toBeVisible({ timeout: 10_000 })

  const backlogColumn = board
    .locator('div.w-\\[280px\\]')
    .filter({ has: page.getByRole('heading', { name: 'Backlog', exact: true }) })
    .first()

  // ---- Open the Linear-style composer ----
  await page.getByRole('button', { name: 'New Issue', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'New Issue' })).toBeVisible({ timeout: 10_000 })

  // Keep the issues worktree-less so no git op runs (harness parity).
  const startNow = dialog.getByRole('checkbox', { name: 'Start work now' })
  await expect(startNow).toBeChecked()
  await startNow.uncheck()

  // ---- Set a property via a pill: bump priority P2 → P1 ----
  const priorityPill = dialog.locator('button.rounded-full').filter({ hasText: 'P2' })
  await priorityPill.click({ timeout: 10_000 })
  const menu = page.locator('[data-slot="dropdown-menu-content"]')
  await menu.locator('input').first().fill('P1')
  await menu.getByRole('menuitem').filter({ hasText: 'P1' }).click({ timeout: 10_000 })
  // The pill now reflects the choice, and the menu closed.
  await expect(dialog.locator('button.rounded-full').filter({ hasText: 'P1' })).toBeVisible()

  // ---- Toggle "Create more" ON ----
  await dialog.getByRole('switch', { name: 'Create more' }).click({ timeout: 10_000 })

  // ---- Create the first issue: dialog STAYS open, title clears, property kept ----
  const stamp = Date.now()
  const title1 = `E2E composer one ${stamp}`
  await dialog.getByLabel('Title').fill(title1)
  const createBtn = dialog.getByRole('button', { name: /^Create$/ })
  await expect(createBtn).toBeEnabled({ timeout: 15_000 })
  await createBtn.click()

  // Dialog is still open (Create more), the title reset, and the P1 pill persisted.
  await expect(dialog.getByRole('heading', { name: 'New Issue' })).toBeVisible({ timeout: 10_000 })
  await expect(dialog.getByLabel('Title')).toHaveValue('', { timeout: 10_000 })
  await expect(dialog.locator('button.rounded-full').filter({ hasText: 'P1' })).toBeVisible()

  // ---- Create the second issue with Create more OFF → the OFF path closes ----
  await dialog.getByRole('switch', { name: 'Create more' }).click({ timeout: 10_000 })
  const title2 = `E2E composer two ${stamp}`
  await dialog.getByLabel('Title').fill(title2)
  await expect(createBtn).toBeEnabled({ timeout: 15_000 })
  await createBtn.click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })

  // Both issues landed on the board under Backlog (live via the broadcast).
  await expect(
    backlogColumn.getByText(title1, { exact: false }),
    'the first composed issue appears under Backlog',
  ).toBeVisible({ timeout: 15_000 })
  await expect(
    backlogColumn.getByText(title2, { exact: false }),
    'the second composed issue appears under Backlog',
  ).toBeVisible({ timeout: 15_000 })
})

test('issues composer: selected agent persists to deferred issue start dropdown', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  await page.locator('button[title="Issues"]').click({ timeout: 15_000 })
  const board = page.getByRole('region', { name: 'Issues' })
  await expect(board).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'New Issue', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'New Issue' })).toBeVisible({ timeout: 10_000 })

  const repoPill = dialog.getByRole('button', { name: 'podium' })
  await expect(repoPill.locator('svg')).toHaveCount(1)
  await repoPill.click({ timeout: 10_000 })
  const menu = page.locator('[data-slot="dropdown-menu-content"]:visible')
  await expect(menu.getByRole('menuitem').first()).toBeVisible({ timeout: 10_000 })
  await expect(menu.getByRole('menuitem', { name: 'New', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')

  const branchPill = dialog.locator('button.rounded-full').filter({ hasText: '(default)' }).first()
  await expect(branchPill.locator('svg')).toHaveCount(1)
  await expect(branchPill).toContainText('(default)', { timeout: 10_000 })
  await branchPill.click({ timeout: 10_000 })
  await expect(menu.getByRole('menuitem', { name: 'New', exact: true })).toBeVisible({
    timeout: 10_000,
  })
  await expect(menu.getByRole('menuitem').filter({ hasText: '(default)' })).toBeVisible()
  await page.keyboard.press('Escape')

  await expect(dialog.getByRole('button', { name: 'Claude Code (default)' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Claude Code (default)' }).click({ timeout: 10_000 })
  await expect(menu.getByRole('menuitem', { name: 'Claude Code', exact: true })).toHaveCount(0)
  await menu.locator('input').first().fill('Cursor')
  await menu.getByRole('menuitem').filter({ hasText: 'Cursor' }).click({ timeout: 10_000 })
  await expect(dialog.getByRole('button', { name: 'Cursor' })).toBeVisible()

  const title = `E2E agent default ${Date.now()}`
  await dialog.getByLabel('Title').fill(title)
  const startNow = dialog.getByRole('checkbox', { name: 'Start work now' })
  await expect(startNow).toBeChecked()
  await startNow.uncheck()
  await expect(startNow).not.toBeChecked()
  const createBtn = dialog.getByRole('button', { name: /^Create$/ })
  await expect(createBtn).toBeEnabled({ timeout: 15_000 })
  await createBtn.click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })

  const backlogColumn = board
    .locator('div.w-\\[280px\\]')
    .filter({ has: page.getByRole('heading', { name: 'Backlog', exact: true }) })
    .first()
  const card = backlogColumn.getByText(title, { exact: false })
  await expect(card, 'the deferred issue appears under Backlog').toBeVisible({ timeout: 15_000 })

  await card.click()
  const issuePage = page.locator('[data-testid="issue-page"]')
  await expect(issuePage).toBeVisible({ timeout: 10_000 })
  await expect(issuePage.getByText(title, { exact: false })).toBeVisible({ timeout: 10_000 })

  await page.getByTestId('issue-aside').getByTitle('Choose start agent').click({ timeout: 10_000 })
  const startMenu = page.locator('[data-slot="dropdown-menu-content"]')
  await expect(
    startMenu.getByRole('menuitem', { name: 'Start with Cursor (default)' }),
  ).toBeVisible()
  await expect(startMenu.getByRole('menuitem', { name: 'Start with Cursor', exact: true })).toHaveCount(0)
  await expect(startMenu.getByRole('menuitem', { name: 'Start with Codex' })).toBeVisible()
})

test('issues board: flag an issue for human, badge appears live, then resolve', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  // Target the app-tools icon button by its title attribute — the accessible-name
  // selector now collides with the "Issues" sidebar tab and any worktree named "…issues…".
  await page.locator('button[title="Issues"]').click({ timeout: 15_000 })
  const board = page.getByRole('region', { name: 'Issues' })
  await expect(board).toBeVisible({ timeout: 10_000 })

  // ---- Create a Backlog issue (startNow=false → no worktree op) ----
  await page.getByRole('button', { name: 'New Issue', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'New Issue' })).toBeVisible({ timeout: 10_000 })
  const title = `E2E needs-human ${Date.now()}`
  await dialog.getByLabel('Title').fill(title)
  const startNow = dialog.getByRole('checkbox', { name: 'Start work now' })
  await expect(startNow).toBeChecked()
  await startNow.uncheck()
  const createBtn = dialog.getByRole('button', { name: /^Create$/ })
  await expect(createBtn).toBeEnabled({ timeout: 15_000 })
  await createBtn.click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })

  const backlogColumn = board
    .locator('div.w-\\[280px\\]')
    .filter({ has: page.getByRole('heading', { name: 'Backlog', exact: true }) })
    .first()
  const card = backlogColumn.getByText(title, { exact: false })
  await expect(card, 'the new issue card appears under Backlog').toBeVisible({ timeout: 15_000 })

  // No needs-human indicator yet. The Linear card shows this as an icon with
  // aria-label="Needs human" (the old "needs human" text badge is gone).
  const needsHuman = backlogColumn.locator('[aria-label="Needs human"]')
  await expect(needsHuman).toHaveCount(0)

  // ---- Open the issue page and flag for human via the overflow menu ----
  await card.click()
  const issuePage = page.locator('[data-testid="issue-page"]')
  await expect(issuePage).toBeVisible({ timeout: 10_000 })
  await expect(issuePage.getByText(title, { exact: false })).toBeVisible({ timeout: 10_000 })

  // "Flag for human…" moved to the header overflow (…) menu and asks for the question
  // via window.prompt — answer the prompt in the dialog handler.
  const question = 'Which API key should we use?'
  page.once('dialog', (d) => void d.accept(question))
  await page.locator('button[title="More actions"]').click({ timeout: 10_000 })
  await page.getByRole('menuitem', { name: /Flag for human/ }).click({ timeout: 10_000 })

  // The page now shows the needs-human banner with the question prominently.
  await expect(page.getByText(question, { exact: false })).toBeVisible({ timeout: 10_000 })

  // Return to the board (the issue page REPLACES it in-view, so the card is only in
  // the DOM once we're back) — the card now grows a needs-human icon live.
  await page.locator('button[title="Back"]').click({ timeout: 10_000 })
  await expect(
    backlogColumn.locator('[aria-label="Needs human"]'),
    'the card shows the needs-human indicator',
  ).toBeVisible({ timeout: 15_000 })

  // ---- Reopen the page and Resolve → the flag clears ----
  await card.click()
  await expect(issuePage).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(question, { exact: false })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Resolve' }).click({ timeout: 10_000 })
  // The banner (with its question) is gone from the page.
  await expect(page.getByText(question, { exact: false })).toBeHidden({ timeout: 10_000 })

  // Back on the board, the card's needs-human indicator has disappeared.
  await page.locator('button[title="Back"]').click({ timeout: 10_000 })
  await expect(
    backlogColumn.locator('[aria-label="Needs human"]'),
    'the needs-human indicator disappears after resolve',
  ).toHaveCount(0, { timeout: 15_000 })
})

test('issue page: add a comment and it appears in the activity feed', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  await page.locator('button[title="Issues"]').click({ timeout: 15_000 })
  const board = page.getByRole('region', { name: 'Issues' })
  await expect(board).toBeVisible({ timeout: 10_000 })

  // ---- Create a Backlog issue (startNow=false → no worktree op) ----
  await page.getByRole('button', { name: 'New Issue', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'New Issue' })).toBeVisible({ timeout: 10_000 })
  const title = `E2E comment ${Date.now()}`
  await dialog.getByLabel('Title').fill(title)
  const startNow = dialog.getByRole('checkbox', { name: 'Start work now' })
  await expect(startNow).toBeChecked()
  await startNow.uncheck()
  const createBtn = dialog.getByRole('button', { name: /^Create$/ })
  await expect(createBtn).toBeEnabled({ timeout: 15_000 })
  await createBtn.click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })

  const backlogColumn = board
    .locator('div.w-\\[280px\\]')
    .filter({ has: page.getByRole('heading', { name: 'Backlog', exact: true }) })
    .first()
  const card = backlogColumn.getByText(title, { exact: false })
  await expect(card, 'the new issue card appears under Backlog').toBeVisible({ timeout: 15_000 })

  // ---- Open the issue page and post a comment ----
  await card.click()
  const issuePage = page.locator('[data-testid="issue-page"]')
  await expect(issuePage).toBeVisible({ timeout: 10_000 })

  const body = `Hello from e2e ${Date.now()}`
  await issuePage.getByLabel('Add a comment').fill(body)
  await issuePage.getByRole('button', { name: 'Post', exact: true }).click({ timeout: 10_000 })

  // The comment lands in the activity feed live (via the issuesChanged broadcast)
  // and the compose box clears.
  await expect(issuePage.getByText(body, { exact: false })).toBeVisible({ timeout: 15_000 })
  await expect(issuePage.getByLabel('Add a comment')).toHaveValue('')
})

test('issue page: add a sub-issue inline and the child row appears with a 0/1 count', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  await page.locator('button[title="Issues"]').click({ timeout: 15_000 })
  const board = page.getByRole('region', { name: 'Issues' })
  await expect(board).toBeVisible({ timeout: 10_000 })

  // ---- Create a parent Backlog issue (startNow=false → no worktree op) ----
  await page.getByRole('button', { name: 'New Issue', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'New Issue' })).toBeVisible({ timeout: 10_000 })
  const parentTitle = `E2E parent ${Date.now()}`
  await dialog.getByLabel('Title').fill(parentTitle)
  const startNow = dialog.getByRole('checkbox', { name: 'Start work now' })
  await expect(startNow).toBeChecked()
  await startNow.uncheck()
  const createBtn = dialog.getByRole('button', { name: /^Create$/ })
  await expect(createBtn).toBeEnabled({ timeout: 15_000 })
  await createBtn.click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })

  const backlogColumn = board
    .locator('div.w-\\[280px\\]')
    .filter({ has: page.getByRole('heading', { name: 'Backlog', exact: true }) })
    .first()
  const card = backlogColumn.getByText(parentTitle, { exact: false })
  await expect(card, 'the parent issue card appears under Backlog').toBeVisible({ timeout: 15_000 })

  // ---- Open the parent's issue page and add a sub-issue inline ----
  await card.click()
  const issuePage = page.locator('[data-testid="issue-page"]')
  await expect(issuePage).toBeVisible({ timeout: 10_000 })

  const subIssues = issuePage.getByTestId('sub-issues')
  await expect(subIssues.getByRole('heading', { name: 'Sub-issues' })).toBeVisible()

  // Reveal the inline input, type a child title, press Enter to create it.
  await subIssues.getByRole('button', { name: /Add sub-issue/ }).click({ timeout: 10_000 })
  const childTitle = `E2E child ${Date.now()}`
  const input = subIssues.getByLabel('Sub-issue title')
  await expect(input).toBeFocused({ timeout: 10_000 })
  await input.fill(childTitle)
  await input.press('Enter')

  // The child row appears live (via the issuesChanged broadcast), the input clears
  // but stays open for rapid entry, and the section header shows the 0/1 count.
  await expect(
    subIssues.getByRole('button', { name: new RegExp(childTitle) }),
    'the child row appears in the sub-issues section',
  ).toBeVisible({ timeout: 15_000 })
  await expect(input, 'the input clears but stays open for rapid entry').toHaveValue('')
  await expect(subIssues.getByText('0/1', { exact: true })).toBeVisible({ timeout: 15_000 })
})

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

test('issues keyboard: j / j / Enter opens the second issue in board order', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)
  await page.locator('button[title="Issues"]').click({ timeout: 15_000 })
  const board = page.getByRole('region', { name: 'Issues' })
  await expect(board).toBeVisible({ timeout: 10_000 })

  // Guarantee at least two focusable cards on the board.
  const stamp = Date.now()
  await createBacklogIssue(page, `E2E keynav one ${stamp}`)
  await createBacklogIssue(page, `E2E keynav two ${stamp}`)

  const cards = board.locator('[data-issue-id]')
  await expect.poll(async () => cards.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)

  // Blur any focused control so the window key handler is active (guard skips inputs).
  await board.getByRole('heading', { name: 'Issues', exact: true }).click()

  // First `j` focuses the first card, the second `j` the second (ring-2 class).
  await page.keyboard.press('j')
  await expect(cards.nth(0)).toHaveClass(/ring-2/, { timeout: 10_000 })
  await page.keyboard.press('j')
  await expect(cards.nth(1)).toHaveClass(/ring-2/, { timeout: 10_000 })

  // Modifier-guard regression check: a modifier chord (Cmd/Ctrl+P) must be ignored
  // by the board key handler — it must NOT open any anchored property menu/dialog.
  await page.keyboard.press('Meta+p')
  await page.keyboard.press('Control+p')
  await expect(
    page.locator('[role="menu"], [role="dialog"]'),
    'a modifier chord opens no menu/dialog',
  ).toHaveCount(0)

  // The second card's title — Enter should open THIS issue's page.
  const secondTitle = (await cards.nth(1).locator('.line-clamp-2').first().textContent())?.trim()
  expect(secondTitle && secondTitle.length > 0).toBeTruthy()

  await page.keyboard.press('Enter')
  const issuePage = page.locator('[data-testid="issue-page"]')
  await expect(issuePage).toBeVisible({ timeout: 10_000 })
  await expect(
    issuePage.getByText(secondTitle as string, { exact: false }),
    'Enter opened the second (focused) issue',
  ).toBeVisible({ timeout: 10_000 })
})

test('issues keyboard: x / x selects two issues, bulk stage change moves both', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)
  await page.locator('button[title="Issues"]').click({ timeout: 15_000 })
  const board = page.getByRole('region', { name: 'Issues' })
  await expect(board).toBeVisible({ timeout: 10_000 })

  const stamp = Date.now()
  await createBacklogIssue(page, `E2E bulk one ${stamp}`)
  await createBacklogIssue(page, `E2E bulk two ${stamp}`)

  const cards = board.locator('[data-issue-id]')
  await expect.poll(async () => cards.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)

  // Capture the two ids that j/j will focus (board/nav order = DOM order).
  const id0 = await cards.nth(0).getAttribute('data-issue-id')
  const id1 = await cards.nth(1).getAttribute('data-issue-id')
  expect(id0 && id1 && id0 !== id1).toBeTruthy()

  await board.getByRole('heading', { name: 'Issues', exact: true }).click()

  // Focus + select the first two cards: j x j x.
  await page.keyboard.press('j')
  await page.keyboard.press('x')
  await page.keyboard.press('j')
  await page.keyboard.press('x')

  // The bulk bar appears with the count.
  const bulkBar = page.getByText('2 selected')
  await expect(bulkBar, 'the bulk bar shows two selected').toBeVisible({ timeout: 10_000 })

  // Bulk stage change → Done via the bar's Stage PropertyMenu.
  await page.getByRole('button', { name: 'Stage', exact: true }).click({ timeout: 10_000 })
  const menu = page.locator('[data-slot="dropdown-menu-content"]')
  await menu.locator('input').first().fill('Done')
  await menu.getByRole('menuitem').filter({ hasText: 'Done' }).click({ timeout: 10_000 })

  // Both selected issues now live under the Done column (live via the broadcast).
  const doneColumn = board
    .locator('div.w-\\[280px\\]')
    .filter({ has: page.getByRole('heading', { name: 'Done', exact: true }) })
    .first()
  await expect(
    doneColumn.locator(`[data-issue-id="${id0}"]`),
    'the first selected issue moved to Done',
  ).toBeVisible({ timeout: 15_000 })
  await expect(
    doneColumn.locator(`[data-issue-id="${id1}"]`),
    'the second selected issue moved to Done',
  ).toBeVisible({ timeout: 15_000 })
})

test('issues display: the Display menu opens (no crash), switches to List, and back to Board', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)
  await page.locator('button[title="Issues"]').click({ timeout: 15_000 })
  const board = page.getByRole('region', { name: 'Issues' })
  await expect(board).toBeVisible({ timeout: 10_000 })

  // Guarantee at least one row so the List view has a stage group to render (the
  // list only emits a <section> for stages that have members).
  await createBacklogIssue(page, `E2E display ${Date.now()}`)

  // ---- Open the Display menu ----
  // Regression check for the Menu.GroupLabel-outside-Group crash: before the fix,
  // clicking Display threw Base UI error #31 and the app error boundary replaced the
  // whole UI, so the menu never opened. Assert the "List" layout radio is visible.
  await board.getByRole('button', { name: 'Display', exact: true }).click({ timeout: 10_000 })
  const menu = page.locator('[data-slot="dropdown-menu-content"]')
  const listRadio = menu.getByRole('menuitemradio').filter({ hasText: 'List' })
  await expect(listRadio, 'the Display menu opened without crashing').toBeVisible({
    timeout: 10_000,
  })

  // ---- Switch to the List layout ----
  await listRadio.click({ timeout: 10_000 })
  const list = page.locator('[data-testid="issues-list"]')
  await expect(list, 'the List view renders').toBeVisible({ timeout: 10_000 })
  // Rows are grouped under sticky stage headers; Backlog must contain at least one row.
  const backlogGroup = list.locator('section[aria-label="Backlog"]')
  await expect(backlogGroup, 'the List view groups rows by stage').toBeVisible({ timeout: 10_000 })
  await expect(
    backlogGroup.locator('[data-issue-id]').first(),
    'the Backlog group has a row',
  ).toBeVisible({ timeout: 10_000 })

  // ---- Switch back to the Board layout via the Display menu ----
  // The reopened menu animates in and its radio item can transiently re-mount, so
  // clicking once mid-animation sometimes no-ops. Poll: (re)open, click Board, and
  // stop once the layout actually switched back (the list is unmounted).
  const displayBtn = board.getByRole('button', { name: 'Display', exact: true })
  await expect(async () => {
    if ((await menu.count()) === 0) await displayBtn.click({ timeout: 5_000 })
    const boardRadio = menu.getByRole('menuitemradio').filter({ hasText: 'Board' })
    await expect(boardRadio).toBeVisible({ timeout: 5_000 })
    await boardRadio.click({ timeout: 5_000 })
    await expect(list).toHaveCount(0, { timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  // The six stage columns return.
  for (const stage of STAGES) {
    await expect(
      board.getByRole('heading', { name: stage, exact: true }),
      `column "${stage}" returns on Board`,
    ).toBeVisible({ timeout: 10_000 })
  }
})
