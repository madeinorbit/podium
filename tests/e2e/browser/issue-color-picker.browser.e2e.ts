import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { harnessEnv } from '../harness-env'
import { openApp } from './_harness'

const HOOKS_DIR = join(harnessEnv(Number(process.env.PORT ?? 8799)).stateDir, 'hooks')

async function hookSettingsFiles(): Promise<Set<string>> {
  return new Set(await readdir(HOOKS_DIR).catch(() => []))
}

async function workingHookUrl(existingFiles: Set<string>): Promise<string | undefined> {
  const files = await hookSettingsFiles()
  const settingsFile = [...files].find((file) => !existingFiles.has(file))
  if (!settingsFile) return undefined
  const settings = await readFile(join(HOOKS_DIR, settingsFile), 'utf8')
  return settings.match(/"url":\s*"([^"]+\/hooks\/[^"]+)"/)?.[1]
}

test.skip(({ isMobile }) => isMobile, 'desktop verification targets the sidebar ID square')

test('ID square state language and picker persist a colour and clear it again', async ({
  page,
}) => {
  await openApp(page)

  await page.getByRole('button', { name: 'Issues', exact: true }).click({ timeout: 15_000 })

  // Start real work so the issue has the current #39-owned sidebar call site.
  // Queued issue placement belongs to #41 and stays covered by IdSquare's unit test.
  const title = `E2E colour picker ${Date.now()}`
  await page.getByRole('button', { name: 'New Issue', exact: true }).click()
  const composer = page.getByRole('dialog')
  await expect(composer.getByRole('heading', { name: 'New Issue' })).toBeVisible({
    timeout: 10_000,
  })
  await composer.getByLabel('Title').fill(title)
  const existingHookSettings = await hookSettingsFiles()
  await expect(composer.getByRole('checkbox', { name: 'Start work now' })).toBeChecked()
  const create = composer.getByRole('button', { name: /^Create$/ })
  await expect(create).toBeEnabled({ timeout: 15_000 })
  await create.click()
  await expect(composer).toBeHidden({ timeout: 30_000 })

  // The deterministic keyecho agent does not emit genuine model activity. Drive
  // its real per-session hook endpoint instead, after snapshotting existing
  // sessions so repeat runs cannot accidentally target another sidebar row.
  let hookUrl: string | undefined
  await expect
    .poll(async () => {
      hookUrl = await workingHookUrl(existingHookSettings)
      return hookUrl
    })
    .toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\//)
  const workingResponse = await fetch(hookUrl as string, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'e2e working state' }),
  })
  expect(workingResponse.ok).toBe(true)

  const row = page.getByTestId('unified-issue-row').filter({ hasText: title }).first()
  const square = row.getByRole('button', { name: /Set colour for issue #/ })
  await expect(square).toBeVisible({ timeout: 30_000 })
  await expect(square).toHaveAttribute('data-color', 'none')
  await expect(square).toHaveAttribute('data-state', 'working')
  await expect(square).toHaveAttribute('data-spinner', 'true')
  await expect(square.locator('.spb')).toBeVisible()
  await expect(square).toHaveCSS('width', '26px')
  await expect(square).toHaveCSS('height', '26px')
  await expect(square).toHaveCSS('border-radius', '7px')
  await expect(square).toHaveCSS('border-style', 'solid')
  await expect(square).toHaveCSS('opacity', '1')

  // Real hit-tested clicks: square → white-ring popover trigger → canonical
  // swatch. The working spinner remains mounted throughout the colour change.
  await square.click()
  const picker = page.getByRole('dialog', { name: /Issue colour for #/ })
  await expect(picker).toBeVisible()
  await expect(square).toHaveCSS('box-shadow', /rgb\(243, 243, 248\)/)
  await expect(picker.getByRole('button', { name: 'Violet' })).toBeVisible()
  await picker.getByRole('button', { name: 'Violet' }).click()
  await expect(square).toHaveAttribute('data-color', 'violet')
  await expect(square).toHaveCSS('background-color', 'rgb(139, 92, 246)')
  await expect(square).toHaveCSS('border-style', 'solid')
  await expect(square).toHaveCSS('opacity', '1')
  await expect(square.locator('.spb')).toBeVisible()
  await expect(square).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 })

  // Reload from the isolated harness database: violet must come back from the
  // migrated SQLite row through IssueWire, not from component-local optimism.
  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  const persistedRow = page.getByTestId('unified-issue-row').filter({ hasText: title }).first()
  const persistedSquare = persistedRow.getByRole('button', { name: /Set colour for issue #/ })
  await expect(persistedSquare).toHaveAttribute('data-color', 'violet', { timeout: 15_000 })
  await expect(persistedSquare).toHaveCSS('background-color', 'rgb(139, 92, 246)')

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
    .getByTestId('unified-issue-row')
    .filter({ hasText: title })
    .first()
    .getByRole('button', { name: /Set colour for issue #/ })
  await expect(clearedSquare).toHaveAttribute('data-color', 'none', { timeout: 15_000 })
  await expect(clearedSquare).toHaveAttribute('data-state', 'working')
  await expect(clearedSquare).toHaveAttribute('data-spinner', 'true')
  await expect(clearedSquare).toHaveCSS('border-style', 'solid')
  await expect(clearedSquare).toHaveCSS('opacity', '1')
  await expect(clearedSquare.locator('.spb')).toBeVisible()
})
