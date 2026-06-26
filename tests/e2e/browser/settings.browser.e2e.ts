import { expect, type Page, test } from '@playwright/test'
import { makeTrpc } from '../../../apps/web/src/trpc'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop test (Settings nav button lives in the <aside> Sidebar)')

async function seedStaleCodexWorkLlm(): Promise<void> {
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

function backgroundWorkSection(page: Page) {
  return page
    .getByRole('region', { name: 'Settings' })
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Background work LLM' }) })
    .first()
}

test('background LLM run target: stale Codex API setting can be saved as harness', async ({
  page,
}) => {
  await seedStaleCodexWorkLlm()
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  await page
    .locator('aside')
    .getByRole('button', { name: 'Settings', exact: true })
    .click({ timeout: 15_000 })
  const settings = page.getByRole('region', { name: 'Settings' })
  await expect(settings).toBeVisible({ timeout: 10_000 })
  await settings.getByRole('button', { name: 'Background LLM' }).click()

  const section = backgroundWorkSection(page)
  const runOn = section.getByRole('combobox').first()
  await expect(runOn).toContainText('Provider backend (API key or local login)')

  await runOn.click()
  await page.getByRole('option', { name: 'Agent CLI harness' }).click({ timeout: 10_000 })
  await expect(runOn).toContainText('Agent CLI harness')
  await expect(section.getByRole('combobox').nth(1)).toContainText('Claude Code')

  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 10_000 })

  await openShell(page)
  await page
    .locator('aside')
    .getByRole('button', { name: 'Settings', exact: true })
    .click({ timeout: 15_000 })
  const reopenedSettings = page.getByRole('region', { name: 'Settings' })
  await expect(reopenedSettings).toBeVisible({ timeout: 10_000 })
  await reopenedSettings.getByRole('button', { name: 'Background LLM' }).click()

  const reopenedSection = backgroundWorkSection(page)
  await expect(reopenedSection.getByRole('combobox').first()).toContainText('Agent CLI harness')
  await expect(reopenedSection.getByRole('combobox').nth(1)).toContainText('Claude Code')
})
