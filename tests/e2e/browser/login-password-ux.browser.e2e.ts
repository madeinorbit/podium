import { expect, type Locator, type Page, test } from '@playwright/test'
import { makeTrpc } from '../../../apps/web/src/app/trpc'
import { RELAY } from './_harness'

test.skip(
  ({ isMobile }) => isMobile,
  'desktop test (Settings nav button lives in the <aside> Sidebar)',
)

async function seedSettings(): Promise<void> {
  const trpc = makeTrpc('http://localhost:8799')
  await trpc.settings.set.mutate({
    workLlm: {
      kind: 'api',
      provider: 'codex',
      model: 'gpt-5.5',
      harnessAgent: 'codex',
      harnessModel: 'auto',
    },
  } as never)
}

async function openShell(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 20_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15_000 })
}

async function openLoginPasswordSection(page: Page): Promise<Locator> {
  await page.locator('aside').getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('region', { name: 'Settings' })
  await expect(settings).toBeVisible({ timeout: 10_000 })
  await settings.getByRole('button', { name: 'Security' }).click()
  return settings
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Login password' }) })
    .first()
}

async function disableLoginBestEffort(section: Locator, currentPassword: string): Promise<void> {
  const finalDisable = section.getByRole('button', { name: 'Disable login', exact: true })
  if (!(await finalDisable.isVisible().catch(() => false))) {
    const trigger = section.getByRole('button', { name: /disable login/i })
    if (await trigger.isVisible().catch(() => false)) await trigger.click()
  }

  const current = section.getByPlaceholder(/current password to disable login/i)
  if (await current.isVisible().catch(() => false)) await current.fill(currentPassword)

  const ack = section.getByRole('checkbox', {
    name: /I understand that anyone who can reach this server/i,
  })
  if ((await ack.isVisible().catch(() => false)) && !(await ack.isChecked().catch(() => false))) {
    await ack.click()
  }

  if (await finalDisable.isEnabled().catch(() => false)) await finalDisable.click()
  await section
    .getByText(/Login disabled/i)
    .waitFor({ timeout: 5_000 })
    .catch(() => {})
}

test('login password disable acknowledgement is scoped to the disable flow', async ({ page }) => {
  await seedSettings()
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  const section = await openLoginPasswordSection(page)
  await expect(section.getByRole('button', { name: /set password/i })).toBeVisible({
    timeout: 10_000,
  })

  let passwordEnabled = false
  try {
    await section.getByPlaceholder(/^Password$/i).fill('oldpw')
    await section.getByPlaceholder(/confirm password/i).fill('oldpw')
    await section.getByRole('button', { name: /set password/i }).click()
    passwordEnabled = true
    await expect(section.getByRole('button', { name: /change password/i })).toBeVisible({
      timeout: 10_000,
    })

    await expect(
      section.getByText(/I understand that anyone who can reach this server/i),
    ).toHaveCount(0)

    await section.getByRole('button', { name: /disable login/i }).click()
    await expect(
      section.getByText(/I understand that anyone who can reach this server/i),
    ).toBeVisible()

    const finalDisable = section.getByRole('button', { name: 'Disable login', exact: true })
    await section.getByPlaceholder(/current password to disable login/i).fill('oldpw')
    await expect(finalDisable).toBeDisabled()
    await section.getByText(/I understand that anyone who can reach this server/i).click()
    await expect(finalDisable).toBeEnabled()
    await finalDisable.click()
    passwordEnabled = false

    await expect(section.getByText(/Login disabled/i)).toBeVisible({ timeout: 10_000 })
  } finally {
    if (passwordEnabled) await disableLoginBestEffort(section, 'oldpw')
  }
})
