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
        ? [{ id: 'machine-a', version: '0.4.1', state: 'current', online: true, busy: false }]
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
    await expect(dialog.getByRole('button', { name: /update Podium/i })).toBeVisible()
  }
  await page.screenshot({
    path: new URL(`../../../docs/design/update-dialog/${screenshotName}`, import.meta.url).pathname,
  })
}

test('server-only update does not offer reload', async ({ page }) => {
  await capture(page, '0.4.1', fleet({ total: 0, behind: 0 }), 'available-server-only.png', true)
})

test('machine-only update starts from the shared action', async ({ page }) => {
  await capture(page, VERSION, fleet({ total: 1, behind: 1 }), 'no-restart-needed.png', false)

  let convergeCalls = 0
  await page.route('**/trpc/updates.converge*', async (route) => {
    convergeCalls += 1
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          result: {
            data: {
              state: 'in-progress',
              version: VERSION,
              done: 0,
              total: 1,
              fleet: {
                total: 1,
                behind: 1,
                converging: 1,
                failed: 0,
                targetVersion: VERSION,
                machines: [
                  {
                    id: 'machine-a',
                    version: '0.4.1',
                    state: 'granted',
                    online: true,
                    busy: false,
                  },
                ],
              },
              grantedMachineIds: ['machine-a'],
            },
          },
        },
      ]),
    })
  })

  const dialog = page.getByTestId('update-dialog')
  await dialog.getByRole('button', { name: 'Update Podium' }).click()
  await expect(dialog).toContainText(`Podium ${VERSION} is being applied`)
  await expect(dialog).toContainText('0 of 1 places are ready.')
  expect(convergeCalls).toBe(1)
})

test('failed update explains recovery, dismisses, and retries', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('podium.panelModeDefault', 'native'))
  await page.route('**/version', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ appVersion: '0.4.1', target }),
    })
  })
  let convergeCalls = 0
  await page.route('**/trpc/updates.fleet*', async (route) => {
    const retryRunning = convergeCalls >= 3
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          result: {
            data: {
              total: 0,
              behind: 0,
              converging: retryRunning ? 1 : 0,
              failed: 0,
              targetVersion: VERSION,
              machines: [],
            },
          },
        },
      ]),
    })
  })
  await page.route('**/trpc/updates.converge*', async (route) => {
    convergeCalls += 1
    if (convergeCalls <= 2) {
      await route.abort('internetdisconnected')
      return
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          result: {
            data: {
              state: 'in-progress',
              version: VERSION,
              done: 0,
              total: 1,
              fleet: {
                total: 0,
                behind: 0,
                converging: 1,
                failed: 0,
                targetVersion: VERSION,
                machines: [],
              },
            },
          },
        },
      ]),
    })
  })

  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })

  const dialog = page.getByTestId('update-dialog')
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Update Podium' }).click()
  await expect(dialog).toContainText('Podium could not reach the update source.')
  await expect(dialog).toContainText("Check this server's internet connection")
  await expect(dialog).not.toContainText('Failed to fetch')
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Dismiss' })).toBeVisible()
  await page.screenshot({
    path: new URL('../../../docs/design/update-dialog/failed-recovery.png', import.meta.url)
      .pathname,
  })

  await dialog.getByRole('button', { name: 'Dismiss' }).click()
  await expect(dialog).toHaveCount(0)

  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Update Podium' }).click()
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Try again' }).click()
  await expect(dialog).toContainText(`Podium ${VERSION} is being applied`)
  expect(convergeCalls).toBe(3)
})
