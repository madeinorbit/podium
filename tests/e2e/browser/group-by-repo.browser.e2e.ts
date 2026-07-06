import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * Runtime verification of the unified sidebar's "Group: repo" option (#113):
 * the WORK-header select flips the flat list into per-repo collapsible groups
 * (keyed by stable repoId with repoPath fallback), the group header carries the
 * repo name + row count, collapse hides the rows, and "Group: none" restores
 * the flat list unchanged.
 */
test.skip(({ isMobile }) => isMobile, 'desktop test (the toggle lives in the <aside> Sidebar)')

async function openShell(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

/** Rows inside the CollapsibleSection that `header` belongs to (its section div). */
function countRowsUnder(
  _aside: ReturnType<Page['locator']>,
  header: ReturnType<Page['locator']>,
): Promise<number> {
  return header
    .locator('xpath=ancestor::div[contains(@class,"min-w-0")][1]')
    .getByTestId('unified-issue-row')
    .count()
}

test('unified WORK list groups by repo and back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)
  const aside = page.locator('aside').first()

  await aside.getByRole('button', { name: 'unified', exact: true }).click()

  // Seed a WORK row: spawn an agent (creates a draft issue in the harness repo).
  const splitMain = aside.getByRole('button', { name: /^New .+ in .+/ })
  await expect(splitMain).toBeEnabled({ timeout: 20_000 })
  await splitMain.click()
  await expect
    .poll(async () => aside.getByTestId('unified-issue-row').count(), { timeout: 30_000 })
    .toBeGreaterThan(0)

  // Spawn a second agent into the harness's OTHER repo (zz-podium-e2e-repo-*)
  // via the two-level agent→repo menu, so grouping has two distinct repos.
  await aside.getByRole('button', { name: 'Choose agent and repo' }).click()
  await page.getByRole('menuitem', { name: 'New Claude', exact: true }).hover()
  await page
    .getByRole('menuitem', { name: /zz-podium-e2e-repo/ })
    .click({ timeout: 10_000 })
  await expect
    .poll(async () => aside.getByTestId('unified-issue-row').count(), { timeout: 30_000 })
    .toBeGreaterThan(1)
  const flatRows = await aside.getByTestId('unified-issue-row').count()

  // The harness repo's name shows in the spawn button: `New <Agent> in <Repo>`.
  const repoName = (await splitMain.textContent())?.match(/ in (.+)$/)?.[1]?.trim() ?? ''
  expect(repoName).not.toBe('')

  // ---- Flip the WORK-header select to "Group: repo" ----
  const groupSelect = aside.getByRole('combobox', { name: 'Group work list' })
  await expect(groupSelect).toContainText('Group: none')
  await groupSelect.click()
  await page.getByRole('option', { name: 'Group: repo' }).click()
  await expect(groupSelect).toContainText('Group: repo')

  // Two repos → two group headers (CollapsibleSection buttons, aria-label
  // "Collapse <repoName>"), together wrapping every row.
  const groupHeader = aside.getByRole('button', {
    name: new RegExp(`^(Collapse|Expand) ${repoName}$`, 'i'),
  })
  const zzHeader = aside.getByRole('button', {
    name: /^(Collapse|Expand) zz-podium-e2e-repo/i,
  })
  await expect(groupHeader).toBeVisible({ timeout: 10_000 })
  await expect(zzHeader).toBeVisible({ timeout: 10_000 })
  await expect(aside.getByTestId('unified-issue-row')).toHaveCount(flatRows)

  // ---- Collapsing ONE group hides only its rows; expand restores ----
  const zzRows = flatRows - (await countRowsUnder(aside, groupHeader))
  await zzHeader.click()
  await expect(aside.getByTestId('unified-issue-row')).toHaveCount(flatRows - zzRows)
  await zzHeader.click()
  await expect(aside.getByTestId('unified-issue-row')).toHaveCount(flatRows)

  if (process.env.SIDEBAR_SHOT) {
    await aside.screenshot({ path: process.env.SIDEBAR_SHOT })
  }

  // ---- Setting persists via server settings AND flips back cleanly ----
  await groupSelect.click()
  await page.getByRole('option', { name: 'Group: none' }).click()
  await expect(groupSelect).toContainText('Group: none')
  await expect(aside.getByTestId('unified-issue-row')).toHaveCount(flatRows)
})
