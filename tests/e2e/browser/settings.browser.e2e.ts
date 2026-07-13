import { expect, type Page, test } from '@playwright/test'
import { makeTrpc } from '../../../apps/web/src/app/trpc'
import { nativeAccountId, normalizeSettings } from '../../../packages/runtime/src/settings'
import { RELAY } from './_harness'

test.skip(
  ({ isMobile }) => isMobile,
  'desktop test (Settings nav button lives in the <aside> Sidebar)',
)

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

function superagentSection(page: Page) {
  return page
    .getByRole('region', { name: 'Settings' })
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Superagent' }) })
    .first()
}

test('superagent uses shared Codex model and effort dropdowns', async ({ page }) => {
  const trpc = makeTrpc('http://localhost:8799')
  await trpc.settings.set.mutate(
    normalizeSettings({
      roles: {
        coding: { accountId: nativeAccountId('grok') },
        superagent: {
          accountId: nativeAccountId('codex'),
          model: 'gpt-5.5',
          effort: 'auto',
        },
      },
    }),
  )
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  await page
    .locator('aside')
    .getByRole('button', { name: 'Settings', exact: true })
    .click({ timeout: 15_000 })
  const settings = page.getByRole('region', { name: 'Settings' })
  await expect(settings).toBeVisible({ timeout: 10_000 })
  await settings.getByRole('button', { name: 'Superagent' }).click()

  const section = superagentSection(page)
  const model = section.getByRole('button', { name: 'Model' })
  await expect(model).toContainText('GPT-5.5')
  await model.click()
  await page.getByRole('menuitem', { name: 'GPT-5.4' }).click()

  const effort = section.getByRole('button', { name: 'Effort' })
  await effort.click()
  await page.getByRole('menuitem', { name: 'Extra high' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 10_000 })

  const saved = await trpc.settings.get.query()
  expect(saved.roles.superagent).toMatchObject({
    accountId: nativeAccountId('codex'),
    harness: 'codex',
    model: 'gpt-5.4',
    effort: 'xhigh',
  })
})

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
