import { expect, type Page, test } from '@playwright/test'
import { makeTrpc } from '../../../apps/web/src/app/trpc'
import { nativeAccountId, normalizeSettings } from '../../../packages/runtime/src/settings'
import { RELAY } from './_harness'

test.skip(
  ({ isMobile }) => isMobile,
  'desktop test (Settings nav button lives in the <aside> Sidebar)',
)
test.describe.configure({ timeout: 90_000 })

async function seedStaleCodexWorkLlm(): Promise<void> {
  const trpc = makeTrpc('http://localhost:8799')
  await trpc.settings.set.mutate(
    normalizeSettings({
      workLlm: {
        kind: 'api',
        provider: 'codex',
        model: 'gpt-5.5',
        harnessAgent: 'codex',
        harnessModel: 'auto',
      },
    }),
  )
}

async function openShell(page: Page): Promise<void> {
  await page.addInitScript(() => {
    ;(window as Window & { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__ = true
  })
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
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

function newSessionsSection(page: Page) {
  return page
    .getByRole('region', { name: 'Settings' })
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'New sessions' }) })
    .first()
}

test('new sessions allows effort with automatic model selection', async ({ page }) => {
  const trpc = makeTrpc('http://localhost:8799')
  await trpc.settings.set.mutate(
    normalizeSettings({
      roles: {
        coding: {
          accountId: nativeAccountId('codex'),
          model: 'auto',
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
  const section = newSessionsSection(page)
  await expect(section.getByRole('button', { name: 'Model' })).toContainText('Auto')
  const effort = section.getByRole('button', { name: 'Effort' })
  await expect(effort).toBeVisible()
  await expect(section.getByText('Model for subagents')).toHaveCount(0)
  await effort.click()
  await page.getByRole('menuitem', { name: 'Extra high' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 10_000 })

  const saved = await trpc.settings.get.query()
  expect(saved.roles.coding).toMatchObject({ model: 'auto', effort: 'xhigh' })
})

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

test('background LLM only offers executable API accounts', async ({ page }) => {
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
  const account = section.getByRole('combobox').first()
  await expect(account).toContainText('Codex (ChatGPT)')
  await account.click()
  await expect(page.getByRole('option', { name: /Codex \(ChatGPT\)/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /Anthropic API/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /OpenAI API/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /OpenRouter API/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /Claude Code/ })).toHaveCount(0)
  await expect(page.getByRole('option', { name: /^Grok/ })).toHaveCount(0)
})
