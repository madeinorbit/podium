import { expect, type Page, test } from '@playwright/test'
import { makeTrpc } from '../../../apps/web/src/app/trpc'
import { nativeAccountId } from '../../../packages/runtime/src/settings'
import { E2E_ACCOUNT_IDENTITY_ENV, E2E_LONG_IDENTITY_EMAIL } from '../account-identity-fixture'
import { RELAY } from './_harness'

test.skip(
  ({ isMobile }) => isMobile,
  'desktop test (the Settings nav button lives in the top bar; POD-318 moved it out of the <aside> Sidebar, and POD-420 repointed these locators)',
)
test.describe.configure({ timeout: 90_000 })

async function seedStaleCodexWorkLlm(): Promise<void> {
  const trpc = makeTrpc('http://localhost:8799')
  // Was a legacy workLlm blob write via settings.set; the blob write is gone
  // (POD-420 family + POD-1213) and workLlm migrates onto roles.background, so
  // seed the migrated shape through the contracted personal command.
  await trpc.settings.updatePersonal.mutate({
    values: {
      'roles.background.accountId': nativeAccountId('codex'),
      'roles.background.model': 'gpt-5.5',
    },
  })
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
    .getByRole('dialog', { name: 'Settings' })
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Background work LLM' }) })
    .first()
}

function superagentSection(page: Page) {
  return page
    .getByRole('dialog', { name: 'Settings' })
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Superagent' }) })
    .first()
}

function newSessionsSection(page: Page) {
  return page
    .getByRole('dialog', { name: 'Settings' })
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'New sessions' }) })
    .first()
}

function accountsSection(page: Page) {
  return page
    .getByRole('dialog', { name: 'Settings' })
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Accounts & Keys' }) })
    .first()
}

test('native account profile labels render when available', async ({ page }) => {
  test.skip(
    process.env[E2E_ACCOUNT_IDENTITY_ENV] !== '1',
    'requires the seeded long-identity fixture (run with PODIUM_E2E_ACCOUNT_IDENTITY=1)',
  )
  const trpc = makeTrpc('http://localhost:8799')
  const accounts = await trpc.accounts.list.query()
  // The seeded login arrives through the catalog under a fingerprinted id when
  // the host holds another login for the same harness — match the fixture
  // address itself, never host state.
  const rows = accounts.filter(
    (account) => account.status === 'connected' && account.identity === E2E_LONG_IDENTITY_EMAIL,
  )
  expect(rows.length).toBeGreaterThan(0)

  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)
  await page
    .getByRole('banner')
    .getByRole('button', { name: 'Settings', exact: true })
    .click({ timeout: 15_000 })
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Accounts', exact: true }).click()

  const section = accountsSection(page)
  // The address renders twice: the outer pill and the inner identity span.
  // Assert on the inner span itself, so a wrapping regression (nowrap) fails
  // the overflow assertion on the element that actually wraps.
  const value = section.locator('span').filter({ hasText: E2E_LONG_IDENTITY_EMAIL }).last()
  await expect(value).toBeVisible()
  // The badge renders the FULL identity with word-boundary wrapping
  // (break-words, never truncate — POD-452/POD-456): the ~99-char fixture
  // address wraps to multiple lines at this width with zero horizontal
  // overflow. Assert the design guarantee (fully rendered, never clipped),
  // not the line count.
  const layout = await value.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    whiteSpace: getComputedStyle(element).whiteSpace,
  }))
  // Overflow first: it is the design guarantee. whiteSpace pins the mechanism
  // (a nowrap "fix" must fail here too, not silently satisfy the pixels).
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1)
  expect(layout.whiteSpace).toBe('normal')
})

test('new sessions allows effort with automatic model selection', async ({ page }) => {
  const trpc = makeTrpc('http://localhost:8799')
  // settings.set (whole-blob write) is retired; seed through updatePersonal.
  await trpc.settings.updatePersonal.mutate({
    values: {
      'roles.coding.accountId': nativeAccountId('codex'),
      'roles.coding.model': 'auto',
      'roles.coding.effort': 'auto',
    },
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  await page
    .getByRole('banner')
    .getByRole('button', { name: 'Settings', exact: true })
    .click({ timeout: 15_000 })
  const section = newSessionsSection(page)
  await expect(section.getByRole('button', { name: 'Model' }).first()).toContainText('Auto')
  const effort = section.getByRole('button', { name: 'Effort' })
  await expect(effort).toBeVisible()
  await expect(section.getByText('Model for subagents')).toBeVisible()
  await expect(
    section.getByText(
      'Applied when the selected harness supports a native subagent-model override.',
    ),
  ).toBeVisible()
  await effort.click()
  await page.getByRole('menuitem', { name: 'Extra high' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved(?:\s*✓|\.)/)).toBeVisible({ timeout: 10_000 })

  const saved = await trpc.settings.get.query()
  expect(saved.roles.coding).toMatchObject({ model: 'auto', effort: 'xhigh' })
})

test('new sessions exposes and persists both Grok implementation models', async ({ page }) => {
  const trpc = makeTrpc('http://localhost:8799')
  await trpc.settings.updatePersonal.mutate({
    values: {
      'roles.coding.accountId': nativeAccountId('grok'),
      'roles.coding.model': 'auto',
      'roles.coding.effort': 'auto',
    },
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  await page
    .getByRole('banner')
    .getByRole('button', { name: 'Settings', exact: true })
    .click({ timeout: 15_000 })
  const section = newSessionsSection(page)
  // Two Model buttons now (the role picker plus "Model for subagents"); the
  // role picker is first, as in the effort test above.
  const model = section.getByRole('button', { name: 'Model' }).first()
  await model.click()

  await expect(page.getByRole('menuitem', { name: /^(grok-4\.5|Grok 4\.5)$/ })).toBeVisible()
  const composer = page.getByRole('menuitem', {
    name: /^(grok-composer-2\.5-fast|Composer 2\.5 Fast)$/,
  })
  await expect(composer).toBeVisible()
  await composer.click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved(?:\s*✓|\.)/)).toBeVisible({ timeout: 10_000 })

  const saved = await trpc.settings.get.query()
  expect(saved.roles.coding).toMatchObject({
    accountId: nativeAccountId('grok'),
    model: 'grok-composer-2.5-fast',
  })
})

test('superagent uses shared Codex model and effort dropdowns', async ({ page }) => {
  const trpc = makeTrpc('http://localhost:8799')
  await trpc.settings.updatePersonal.mutate({
    values: {
      'roles.coding.accountId': nativeAccountId('grok'),
      'roles.superagent.accountId': nativeAccountId('codex'),
      'roles.superagent.model': 'gpt-5.5',
      'roles.superagent.effort': 'auto',
    },
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  await page
    .getByRole('banner')
    .getByRole('button', { name: 'Settings', exact: true })
    .click({ timeout: 15_000 })
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible({ timeout: 10_000 })
  await settings.getByRole('button', { name: 'Superagent' }).click()

  const section = superagentSection(page)
  const model = section.getByRole('button', { name: 'Model' })
  await expect(model).toContainText('GPT-5.5')
  await model.click()
  await page.getByRole('menuitem', { name: 'GPT-5.4', exact: true }).click()

  const effort = section.getByRole('button', { name: 'Effort' })
  await effort.click()
  await page.getByRole('menuitem', { name: 'Extra high' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved(?:\s*✓|\.)/)).toBeVisible({ timeout: 10_000 })

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
    .getByRole('banner')
    .getByRole('button', { name: 'Settings', exact: true })
    .click({ timeout: 15_000 })
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible({ timeout: 10_000 })
  await settings.getByRole('button', { name: 'Background LLM' }).click()

  const section = backgroundWorkSection(page)
  const account = section.getByRole('combobox').first()
  // POD-4475: one descriptor label per harness ('Codex' + identity/machine
  // suffixes) instead of 'Codex (ChatGPT)'.
  await expect(account).toContainText(/^Codex/)
  await account.click()
  // Every connected Codex login adds its own suffixed option next to the base
  // descriptor one (the POD-4730 long-identity fixture does so deterministically),
  // so assert at least one Codex option rather than exactly one.
  await expect(page.getByRole('option', { name: /^Codex/ }).first()).toBeVisible()
  await expect(page.getByRole('option', { name: /Anthropic API/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /OpenAI API/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /OpenRouter API/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /Claude Code/ })).toHaveCount(0)
  await expect(page.getByRole('option', { name: /^Grok/ })).toHaveCount(0)
})

test('idle-session convergence target round-trips and renders', async ({ page }) => {
  const trpc = makeTrpc('http://localhost:8799')
  // hibernation is an instance-preference tier leaf (POD-1213), not personal.
  await trpc.settings.updateInstance.mutate({ values: { 'hibernation.maxIdleSessions': null } })
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Hibernation', exact: true }).click()
  const input = settings.getByRole('spinbutton', { name: 'Maximum idle sessions' })
  await expect(input).toHaveValue('')
  await expect(
    settings.getByText(/convergence target for eligible idle live sessions/),
  ).toBeVisible()
  await input.fill('12')
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(/Saved(?:\s*✓|\.)/)).toBeVisible()
  expect((await trpc.settings.get.query()).hibernation.maxIdleSessions).toBe(12)
  await settings.screenshot({ path: '/tmp/POD-957-idle-cap-settings.png' })
})
