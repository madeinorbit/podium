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

  // One harness repo → one group header (CollapsibleSection button, aria-label
  // "Collapse <repoName>") wrapping every row.
  const groupHeader = aside.getByRole('button', {
    name: new RegExp(`^(Collapse|Expand) ${repoName}$`, 'i'),
  })
  await expect(groupHeader).toBeVisible({ timeout: 10_000 })
  await expect(aside.getByTestId('unified-issue-row')).toHaveCount(flatRows)

  // ---- Collapse hides the group's rows (count badge appears); expand restores ----
  await groupHeader.click()
  await expect(aside.getByTestId('unified-issue-row')).toHaveCount(0)
  await expect(groupHeader).toContainText(`· ${flatRows}`)
  await groupHeader.click()
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
