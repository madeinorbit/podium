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
    timeout: 20_000,
  })
  // The desktop layout renders an <aside> sidebar; wait for it so the app-tools row
  // (which holds the Issues nav button) is mounted.
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15_000 })
}

const STAGES = ['Backlog', 'Planning', 'In Progress', 'Review', 'Verifying', 'Done'] as const

test('issues board: renders the stage columns, creates a Backlog issue, and moves its stage', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  // ---- Navigate to the Issues board via the Sidebar nav button ----
  // The button is an icon button whose accessible name derives from title="Issues".
  await page.getByRole('button', { name: 'Issues' }).click({ timeout: 15_000 })

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
  await page.getByRole('button', { name: 'New Issue' }).click()
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

  // ---- Move the issue's stage via the detail panel's Stage selector ----
  await card.click()
  // The detail drawer header shows "#<seq> <title>".
  await expect(
    page.getByRole('heading', { name: new RegExp(`#\\d+\\s+${escapeRe(title)}`) }),
  ).toBeVisible({
    timeout: 10_000,
  })

  // The Stage selector is a Base UI <Select> (combobox trigger + option list). It
  // currently reads "Backlog"; switch it to "Planning".
  const stageTrigger = page.getByRole('combobox').filter({ hasText: 'Backlog' }).first()
  await stageTrigger.click()
  await page.getByRole('option', { name: 'Planning', exact: true }).click({ timeout: 10_000 })

  // Close the drawer so the board is unobstructed, then assert the card has left
  // Backlog and now lives under Planning (live via the issueUpdated broadcast).
  await page.getByRole('button', { name: 'Close' }).click({ timeout: 10_000 })

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

test('issues board: flag an issue for human, badge appears live, then resolve', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  await page.getByRole('button', { name: 'Issues' }).click({ timeout: 15_000 })
  const board = page.getByRole('region', { name: 'Issues' })
  await expect(board).toBeVisible({ timeout: 10_000 })

  // ---- Create a Backlog issue (startNow=false → no worktree op) ----
  await page.getByRole('button', { name: 'New Issue' }).click()
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

  // No needs-human badge yet.
  await expect(backlogColumn.getByText('needs human', { exact: false })).toHaveCount(0)

  // ---- Open the drawer and flag for human with a question ----
  await card.click()
  await expect(
    page.getByRole('heading', { name: new RegExp(`#\\d+\\s+${escapeRe(title)}`) }),
  ).toBeVisible({ timeout: 10_000 })

  const question = 'Which API key should we use?'
  await page.getByLabel('Question for human').fill(question)
  await page.getByRole('button', { name: 'Flag for human' }).click()

  // The drawer now shows the question prominently (the banner replaces the flag control).
  await expect(page.getByText(question, { exact: false })).toBeVisible({ timeout: 10_000 })
  // ...and the card grows a needs-human badge live via the issuesChanged broadcast.
  await expect(
    backlogColumn.getByText('needs human', { exact: false }),
    'the card shows the needs-human badge',
  ).toBeVisible({ timeout: 15_000 })

  // ---- Resolve → the flag clears and the badge disappears ----
  await page.getByRole('button', { name: 'Resolve' }).click({ timeout: 10_000 })
  await expect(
    backlogColumn.getByText('needs human', { exact: false }),
    'the needs-human badge disappears after resolve',
  ).toHaveCount(0, { timeout: 15_000 })
  // The flag-for-human control is back (banner gone).
  await expect(page.getByRole('button', { name: 'Flag for human' })).toBeVisible({
    timeout: 10_000,
  })
})

/** Escape a string for safe interpolation into a RegExp (the title contains digits
 *  and spaces, which are RegExp-safe, but guard against future markers). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
