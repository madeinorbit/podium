import { expect, test, type Page } from '@playwright/test'
import { RELAY } from './_harness'

const VERSION = '0.4.2'
const target = { version: VERSION, critical: false, artifacts: {} }

function fleet(data: { total: number; behind: number }) {
  return {
    ...data,
    converging: 0,
    failed: 0,
    targetVersion: VERSION,
    machines:
      data.behind > 0
        ? [{ id: 'machine-a', version: VERSION, state: 'current', online: true, busy: false }]
        : [],
  }
}

async function capture(
  page: Page,
  appVersion: string,
  fleetState: ReturnType<typeof fleet>,
  screenshotName: string,
  expectServer: boolean,
): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('podium.panelModeDefault', 'native'))
  await page.route('**/version', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ appVersion, target }),
    })
  })
  await page.route('**/trpc/updates.fleet*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ result: { data: fleetState } }]),
    })
  })

  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })

  const dialog = page.getByTestId('update-dialog')
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  const text = await dialog.innerText()
  expect(text).not.toMatch(/\b(headless|bundle|daemon|artifact|tarball)\b/i)
  expect(text).not.toContain('—')
  expect(dialog.getByRole('button', { name: 'Reload' })).toHaveCount(0)
  if (expectServer) {
    await expect(dialog).toContainText('Your server')
  } else {
    await expect(dialog).toContainText('No restart needed. Your sessions keep running.')
    await expect(dialog).not.toContainText('Your server')
    await expect(dialog.getByRole('button', { name: /update server/i })).toHaveCount(0)
  }
  await page.screenshot({
    path: new URL(`../../../docs/design/update-dialog/${screenshotName}`, import.meta.url).pathname,
  })
}

test('server-only update does not offer reload', async ({ page }) => {
  await capture(page, '0.4.1', fleet({ total: 0, behind: 0 }), 'available-server-only.png', true)
})

test('machine-only update does not offer reload', async ({ page }) => {
  await capture(page, VERSION, fleet({ total: 1, behind: 1 }), 'no-restart-needed.png', false)
})
