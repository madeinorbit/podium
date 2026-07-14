import { expect, test } from '@playwright/test'
import { openApp } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop shell interaction coverage')

test('desktop shell controls, collapse, dock switching, and widths persist', async ({ page }) => {
  await openApp(page)

  const header = page.getByTestId('desktop-topbar')
  await expect(header).toBeVisible()
  expect(Math.round((await header.boundingBox())?.height ?? 0)).toBe(44)
  await expect(page.locator('.desktop-shell > .desktop-shell-row')).toBeVisible()
  await expect(page.locator('.desktop-shell > :text("agents active")')).toHaveCount(0)

  await page.getByRole('button', { name: 'Issues', exact: true }).click()
  await expect(page).toHaveURL(/\/issues/)
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  await expect(page).toHaveURL(/\/$|\/?\?/)

  // Handoff v2 desktop header (#63): text nav + host chips only — the
  // issue-context dropdown, “+” and superagent toggle are mobile-header anatomy.
  for (const name of ['Specs', 'Automations']) {
    await expect(header.getByRole('button', { name, exact: true })).toBeVisible()
  }
  await expect(header.getByRole('button', { name: 'Issue context' })).toHaveCount(0)
  await expect(header.getByRole('button', { name: 'New agent' })).toHaveCount(0)
  await expect(header.getByRole('button', { name: 'Superagent', exact: true })).toHaveCount(0)

  await expect(page.locator('[data-resizable-column="podium:sidebar:width"]')).toHaveAttribute(
    'data-width',
    '262',
  )
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await expect(page.getByRole('complementary', { name: 'Collapsed work sidebar' })).toBeVisible()

  await page.getByTitle('Fold the tray and superagent column').click()
  await expect(
    page.getByRole('complementary', { name: 'Folded tray and superagent' }),
  ).toBeVisible()

  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  await expect(page.getByRole('complementary', { name: 'Collapsed work sidebar' })).toBeVisible()
  await expect(
    page.getByRole('complementary', { name: 'Folded tray and superagent' }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  await expect(page.locator('[data-resizable-column="podium:sidebar:width"]')).toHaveAttribute(
    'data-width',
    '262',
  )
  await page.getByRole('button', { name: 'Expand superagent' }).click()
  await expect(page.locator('[data-superagent-mode="open"]')).toBeVisible()

  // Collapsing folds the column IN PLACE — the folded bar has no close
  // control, the rail has no superagent cell, and the column never fully
  // closes (#65). The header carries no superagent toggle (#67), so the fold
  // affordance is the engraved column's own control.
  await page.getByTitle('Fold the tray and superagent column').click()
  const folded = page.getByRole('complementary', { name: 'Folded tray and superagent' })
  await expect(folded).toBeVisible()
  expect(Math.round((await folded.boundingBox())?.width ?? 0)).toBe(44)
  await expect(folded.getByRole('button', { name: 'Close tray and superagent' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open superagent' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Expand tray and superagent' }).click()
  await expect(page.locator('[data-superagent-mode="open"]')).toBeVisible()

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(page.locator('[data-right-dock-panel="files"]')).toBeVisible()
  await page.getByRole('button', { name: 'Git', exact: true }).click()
  await expect(page.locator('[data-right-dock-panel="git"]')).toBeVisible()
  await expect(page.locator('[data-right-dock-panel="files"]')).toHaveCount(0)

  const dock = page.locator('[data-resizable-column="podium:rightdock:width"]')
  await expect(dock).toHaveAttribute('data-width', '340')
  const resizeDock = page.getByRole('separator', { name: 'Resize right dock' })
  const dockHandle = await resizeDock.boundingBox()
  if (!dockHandle) throw new Error('dock resize handle not measurable')
  await page.mouse.move(dockHandle.x + dockHandle.width / 2, dockHandle.y + 200)
  await page.mouse.down()
  await page.mouse.move(dockHandle.x + dockHandle.width / 2 - 120, dockHandle.y + 200, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => dock.getAttribute('data-width').then(Number)).toBeGreaterThan(340)
  const resizedDockWidth = Number(await dock.getAttribute('data-width'))

  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  await expect(page.locator('[data-right-dock-panel="git"]')).toBeVisible()
  await expect(page.locator('[data-resizable-column="podium:rightdock:width"]')).toHaveAttribute(
    'data-width',
    String(resizedDockWidth),
  )
  expect(Math.round((await page.getByTestId('right-rail').boundingBox())?.width ?? 0)).toBe(44)

  // Designed right-side issue borders (#65): the rail and the open dock wear
  // the same issue-tinted hairline (35% coloured / 30% slate — never none),
  // and the rail's issue cell is the bordered ID-square language, not a bare
  // text cell.
  const railBorder = await page
    .getByTestId('right-rail')
    .evaluate((el) => getComputedStyle(el).borderLeftColor)
  const dockBorder = await page
    .locator('.right-dock-shell')
    .evaluate((el) => getComputedStyle(el).borderLeftColor)
  expect(dockBorder).toBe(railBorder)
  expect(railBorder).not.toBe('rgba(0, 0, 0, 0)')
  const issueCell = page
    .getByTestId('right-rail')
    .locator('[data-testid="issue-id-square"], [aria-label="Issue"]')
  await expect(issueCell).toBeVisible()
  const cellBorder = await issueCell.evaluate((el) => getComputedStyle(el).borderStyle)
  expect(['solid', 'dashed']).toContain(cellBorder)
  const cellWidth = await issueCell.evaluate((el) => getComputedStyle(el).borderLeftWidth)
  expect(cellWidth).toBe('1px')
})
