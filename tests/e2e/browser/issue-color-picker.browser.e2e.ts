import { expect, test } from '@playwright/test'
import { openApp } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop verification targets the sidebar ID square')

test('issue ID-square picker persists a palette slot and clears it again', async ({ page }) => {
  await openApp(page)

  const aside = page.locator('aside').first()
  await aside.getByRole('button', { name: 'Issues', exact: true }).click({ timeout: 15_000 })

  // Create and start a normal issue through the real UI. The harness agent is
  // deterministic keyecho, but the issue/worktree/session path is production:
  // its live session makes the issue a unified-sidebar work row.
  const title = `E2E colour picker ${Date.now()}`
  await page.getByRole('button', { name: 'New Issue', exact: true }).click()
  const composer = page.getByRole('dialog')
  await expect(composer.getByRole('heading', { name: 'New Issue' })).toBeVisible({
    timeout: 10_000,
  })
  await composer.getByLabel('Title').fill(title)
  await expect(composer.getByRole('checkbox', { name: 'Start work now' })).toBeChecked()
  const create = composer.getByRole('button', { name: /^Create$/ })
  await expect(create).toBeEnabled({ timeout: 15_000 })
  await create.click()
  await expect(composer).toBeHidden({ timeout: 30_000 })

  const row = aside.getByTestId('unified-issue-row').filter({ hasText: title }).first()
  const square = row.getByRole('button', { name: /Set colour for issue #/ })
  await expect(square).toBeVisible({ timeout: 30_000 })
  await expect(square).toHaveAttribute('data-color', 'none')

  // Real hit-tested clicks: square → popover → canonical swatch.
  await square.click()
  const picker = page.getByRole('dialog', { name: /Issue colour for #/ })
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('button', { name: 'Violet' })).toBeVisible()
  await picker.getByRole('button', { name: 'Violet' }).click()
  await expect(square).toHaveAttribute('data-color', 'violet')
  await expect(square).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 })

  // Reload from the isolated harness database: violet must come back from the
  // migrated SQLite row through IssueWire, not from component-local optimism.
  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  const persistedRow = page
    .locator('aside')
    .first()
    .getByTestId('unified-issue-row')
    .filter({ hasText: title })
    .first()
  const persistedSquare = persistedRow.getByRole('button', { name: /Set colour for issue #/ })
  await expect(persistedSquare).toHaveAttribute('data-color', 'violet', { timeout: 15_000 })

  // Clear through the actual footer action and prove NULL/absence also survives
  // a reload (neutral slate is a flow fallback, never a stored palette slot).
  await persistedSquare.click()
  await page
    .getByRole('dialog', { name: /Issue colour for #/ })
    .getByRole('button', {
      name: 'No colour',
    })
    .click()
  await expect(persistedSquare).toHaveAttribute('data-color', 'none')
  await expect(persistedSquare).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 })

  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  const clearedSquare = page
    .locator('aside')
    .first()
    .getByTestId('unified-issue-row')
    .filter({ hasText: title })
    .first()
    .getByRole('button', { name: /Set colour for issue #/ })
  await expect(clearedSquare).toHaveAttribute('data-color', 'none', { timeout: 15_000 })
})
