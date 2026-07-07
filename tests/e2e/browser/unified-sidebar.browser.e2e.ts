import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * Runtime verification of the unified sidebar (issue-as-workspace) against the
 * REAL Live UI on the harness relay: the temporary Classic|Unified switcher, the
 * `New <Agent> in <Repo>` split button with its two-level agent→repo menu, the
 * spawn-with-draft-issue flow producing a draft row live from the broadcasts,
 * and the widened New Issue dialog opened from the sidebar `+`.
 *
 * Desktop-only: the switcher lives in the <aside> Sidebar, which the mobile
 * layout (MobileApp) does not render.
 */
test.skip(({ isMobile }) => isMobile, 'desktop test (the switcher lives in the <aside> Sidebar)')

async function openShell(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

test('unified sidebar: switcher, split-button spawn creates a draft row, wider + dialog', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)
  const aside = page.locator('aside').first()

  // ---- Classic is the default; flip the temporary switcher to Unified ----
  const unifiedToggle = aside.getByRole('button', { name: 'unified', exact: true })
  await expect(unifiedToggle).toBeVisible({ timeout: 10_000 })
  await unifiedToggle.click()
  await expect(unifiedToggle).toHaveAttribute('aria-pressed', 'true')

  // Unified layout drops the Command center AND Superagent rows — the New-agent
  // button (wearing the classic style) is the one top row.
  await expect(aside.getByRole('button', { name: /Command center/ })).toHaveCount(0)
  await expect(aside.getByRole('button', { name: /Superagent/ })).toHaveCount(0)

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

  // ---- `+` opens the (widened) New Issue dialog ----
  await aside.getByRole('button', { name: 'New issue', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'New Issue' })).toBeVisible({
    timeout: 10_000,
  })
  const box = await dialog.boundingBox()
  expect(box, 'dialog has a bounding box').not.toBeNull()
  // max-w-2xl = 672px; the old max-w-md was 448px. Assert we're clearly wider.
  expect(box?.width ?? 0).toBeGreaterThan(600)
  await page.keyboard.press('Escape')

  // ---- Classic still renders (switch back) ----
  const classicToggle = aside.getByRole('button', { name: 'classic', exact: true })
  await classicToggle.click()
  await expect(aside.getByRole('button', { name: /Command center/ })).toBeVisible({
    timeout: 10_000,
  })
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
