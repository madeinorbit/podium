import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop test (Workflows navigation lives in the sidebar)')

async function openShell(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  const repoDialog = page.getByRole('dialog', { name: 'Find repositories' })
  if (await repoDialog.isVisible().catch(() => false)) {
    await repoDialog.getByRole('button', { name: 'Close' }).click()
  }
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

test('workflow library: creates, revises, publishes, and persists a workflow', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openShell(page)

  await page
    .locator('aside')
    .first()
    .getByRole('button', { name: 'Workflows', exact: true })
    .click({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible({
    timeout: 15_000,
  })

  await page.getByRole('button', { name: 'New workflow' }).click()
  const name = `Browser workflow ${Date.now()}`
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Description').fill('Created through the real workflow UI')
  await page.getByLabel('Instructions (Markdown)').fill('Research first, then implement.')
  await page.getByLabel('Ordered steps (JSON)').fill(
    JSON.stringify([
      {
        id: 'research',
        title: 'Research',
        instructions: 'Inspect the system.',
        completionGuidance: 'Unknowns resolved.',
      },
    ]),
  )
  await page.getByRole('button', { name: 'Create revision 1' }).click()

  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('revision 1 · candidate', { exact: true })).toBeVisible()

  await page
    .getByLabel('Instructions (Markdown)')
    .fill('Research first, then implement and review.')
  await page.getByRole('button', { name: 'Create revision', exact: true }).click()
  await expect(page.getByText('Created a new immutable revision.')).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByText('revision 2 · candidate', { exact: true })).toBeVisible()
  await expect(page.getByText(/^v1 · wfr_/)).toBeVisible()
  await expect(page.getByText(/^v2 · wfr_/)).toBeVisible()

  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByText('Published this revision.')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('revision 2 · published', { exact: true })).toBeVisible()

  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('revision 2 · published', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Execution profiles', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Execution profiles' })).toBeVisible()
  const profileName = `Browser profile ${Date.now()}`
  await page.getByLabel('Name').fill(profileName)
  await page.getByLabel('Account ID').fill('native:grok')
  await page.getByLabel('Harness').selectOption('grok')
  await page.getByLabel('Model').fill('grok-4.5')
  await page.getByLabel('Effort').fill('medium')
  await page.getByRole('button', { name: 'Save profile' }).click()
  await expect(page.getByText('Saved the execution profile.')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(profileName, { exact: true })).toBeVisible()
  await expect(page.getByText('grok · grok-4.5 · medium', { exact: true })).toBeVisible()

  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.getByRole('button', { name: 'Execution profiles', exact: true }).click()
  await expect(page.getByText(profileName, { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('account native:grok', { exact: true })).toBeVisible()
})
