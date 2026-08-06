import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(
  () => process.env.PODIUM_E2E_NATIVE_LOGIN !== '1',
  'requires the isolated native-login fixture',
)
test.describe.configure({ timeout: 90_000 })

test('Settings launches the selected machine native login PTY', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('podium.panelModeDefault', 'native')
    ;(window as Window & { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__ = true
  })
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'))

  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Accounts', exact: true }).click()
  await settings.getByRole('button', { name: 'Log in' }).nth(1).click()

  await expect(page.getByText('codex login', { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible()
  await page.waitForFunction(
    () =>
      (window as Window & { __podium?: { screenText(): string } }).__podium
        ?.screenText()
        .includes('Native Codex login ready'),
    undefined,
    { timeout: 20_000 },
  )
  await page.screenshot({
    path: '../../docs/evidence/pod-449-native-login.png',
    fullPage: true,
  })
})
