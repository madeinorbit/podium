import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * Runtime verification of the work sidebar's ALWAYS-ON project grouping (#41):
 * rows bucket under mono project section labels (repo name + trailing
 * hairline, keyed by stable repoId with repoPath fallback). The old
 * "Group: repo / none" select is gone — grouping is not optional.
 */
test.skip(({ isMobile }) => isMobile, 'desktop test (the grouped list lives in the <aside>)')

async function openShell(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

test('work rows group under always-on project section labels', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)
  const aside = page.locator('aside').first()

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
  await page.getByRole('menuitem', { name: /zz-podium-e2e-repo/ }).click({ timeout: 10_000 })
  await expect
    .poll(async () => aside.getByTestId('unified-issue-row').count(), { timeout: 30_000 })
    .toBeGreaterThan(1)
  const flatRows = await aside.getByTestId('unified-issue-row').count()

  // The harness repo's name shows in the spawn button: `New <Agent> in <Repo>`.
  const repoName = (await splitMain.textContent())?.match(/ in (.+)$/)?.[1]?.trim() ?? ''
  expect(repoName).not.toBe('')

  // Two repos → two always-on project group labels wrapping every row; the
  // labels read the repo names (mono 8.5px, uppercased by CSS).
  const labels = aside.getByTestId('project-group-label')
  await expect(labels).toHaveCount(2, { timeout: 10_000 })
  await expect(aside.getByTestId('project-group-label').filter({ hasText: repoName })).toHaveCount(
    1,
  )
  await expect(
    aside.getByTestId('project-group-label').filter({ hasText: /zz-podium-e2e-repo/ }),
  ).toHaveCount(1)
  await expect(aside.getByTestId('unified-issue-row')).toHaveCount(flatRows)

  // Every row lives INSIDE a project group container.
  const grouped = await aside
    .locator('[data-testid="project-group"] [data-testid="unified-issue-row"]')
    .count()
  expect(grouped).toBe(flatRows)

  // The retired grouping toggle must be gone — grouping is always on.
  await expect(aside.getByRole('combobox', { name: 'Group work list' })).toHaveCount(0)

  if (process.env.SIDEBAR_SHOT) {
    await aside.screenshot({ path: process.env.SIDEBAR_SHOT })
  }
})
