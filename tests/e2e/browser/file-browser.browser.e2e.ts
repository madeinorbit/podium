import { expect, test } from '@playwright/test'
import { openApp } from './_harness'

/**
 * Runtime verification of the worktree FILE BROWSER against the REAL Live UI on the
 * harness relay (serve-harness registers THIS repo, so its main worktree shows in the
 * sidebar and browsing it lists the real repo tree through the daemon sandbox). No
 * session is needed — the browser is keyed by the worktree {root}, not a session.
 */
test.skip(({ isMobile }) => isMobile, 'desktop test (hover-revealed sidebar button)')

const SHOT = process.env.PODIUM_SHOT_DIR

async function maybeShot(page: import('@playwright/test').Page, name: string): Promise<void> {
  if (SHOT) await page.screenshot({ path: `${SHOT}/${name}` })
}

test('worktree file browser: hover→browse→navigate→Up→open a file in the deck', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openApp(page)

  // The "Browse files" button lives in a worktree row (group/wt), display:none until the
  // row is hovered. Hover the row, then open the browser.
  const browseBtn = page.locator('aside [aria-label="Browse files"]').first()
  const row = browseBtn.locator('xpath=..')
  await row.hover()
  await browseBtn.waitFor({ state: 'visible', timeout: 10_000 })
  await browseBtn.click()

  // Modal opens: "Files — <branch>" title + the real repo tree.
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await expect(dialog.getByText(/^Files —/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'apps', exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(dialog.getByRole('button', { name: 'package.json', exact: true })).toBeVisible()
  await maybeShot(page, 'fb-1-modal-list.png')

  // Up is disabled at the root (UI containment; the daemon also enforces isInside).
  const upBtn = dialog.getByRole('button', { name: 'Up', exact: true })
  await expect(upBtn).toBeDisabled()

  // Navigate INTO a directory → lists that dir; Up becomes enabled.
  await dialog.getByRole('button', { name: 'apps', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'web', exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(upBtn).toBeEnabled()
  await maybeShot(page, 'fb-2-navigated-apps.png')

  // Up → back to repo root (apps visible again, Up disabled).
  await upBtn.click()
  await expect(dialog.getByRole('button', { name: 'apps', exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(upBtn).toBeDisabled()

  // Click a file → modal closes and the file opens as a tab/panel in the deck.
  await dialog.getByRole('button', { name: 'package.json', exact: true }).click()
  await expect(dialog).toBeHidden({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: 'package.json' }).first()).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.cm-content')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.cm-content')).toContainText('@podium', { timeout: 10_000 })
  await maybeShot(page, 'fb-3-file-open-in-deck.png')
})
