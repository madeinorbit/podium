import { expect, type Page, test } from '@playwright/test'
import { makeTrpc } from '../../../apps/web/src/app/trpc'
import { nativeAccountId } from '../../../packages/runtime/src/settings'
import { E2E_LONG_IDENTITY_EMAIL } from '../account-identity-fixture'
import { RELAY } from './_harness'

type Trpc = ReturnType<typeof makeTrpc>
type Values = Readonly<Record<string, unknown>>
type Change = { entity: string; id: string; op: string; value?: Record<string, unknown> }
interface SyncApi {
  sync: {
    submit: { mutate(input: unknown): Promise<{ outcome: string }> }
    changesSince: {
      query(input: { cursor: number | null }): Promise<{ kind: string; changes?: Change[] }>
    }
  }
}
const sync = (trpc: Trpc) => (trpc as unknown as SyncApi).sync

/** The newest value of every record this member can see, from the whole log
 *  (POD-6673, POD-6677): the preference records reach an app on the feed, and
 *  there is no settings read over HTTP any more. */
async function records(trpc: Trpc): Promise<Change[]> {
  const delta = await sync(trpc).changesSince.query({ cursor: 0 })
  if (delta.kind !== 'delta')
    throw new Error(`expected the whole log as a delta, got ${delta.kind}`)
  const latest = new Map<string, Change>()
  for (const change of delta.changes ?? []) latest.set(`${change.entity}\n${change.id}`, change)
  return [...latest.values()].filter((change) => change.op === 'upsert')
}

/** My personal settings record: the one `userPreferences` row I can see. */
async function myPreferences(trpc: Trpc): Promise<Change> {
  const mine = (await records(trpc)).filter((change) => change.entity === 'userPreferences')
  const [only] = mine
  if (mine.length !== 1 || only === undefined) {
    throw new Error(`expected my one settings record, saw ${mine.length}`)
  }
  return only
}

/** The instance settings record, flat by leaf path. */
async function instancePreferences(trpc: Trpc): Promise<Record<string, unknown>> {
  const record = (await records(trpc)).find((change) => change.entity === 'instancePreferences')
  if (!record?.value) throw new Error('the instance settings record is not on the log')
  return record.value
}

/** A record edit on sync.submit, as the outbox drain sends it: `null` resets a leaf. */
async function edit(trpc: Trpc, command: string, id: string, values: Values): Promise<void> {
  const patch: Record<string, unknown> = {}
  const unset: string[] = []
  for (const [path, value] of Object.entries(values)) {
    if (value === null && command === 'records.userPreferences.edit') unset.push(path)
    else patch[path] = value
  }
  const reply = await sync(trpc).submit.mutate({
    mutationId: crypto.randomUUID(),
    command,
    version: 1,
    input: { id, patch, ...(unset.length > 0 ? { unset } : {}) },
  })
  if (reply.outcome !== 'applied') throw new Error(`${command} refused: ${JSON.stringify(reply)}`)
}

/** Seed my personal settings (the `userPreferences` record). */
async function setMyPreferences(trpc: Trpc, values: Values): Promise<void> {
  await edit(trpc, 'records.userPreferences.edit', (await myPreferences(trpc)).id, values)
}

test.skip(
  ({ isMobile }) => isMobile,
  'desktop test (the Settings nav button lives in the top bar; POD-318 moved it out of the <aside> Sidebar, and POD-420 repointed these locators)',
)
test.describe.configure({ timeout: 90_000 })

async function seedStaleCodexWorkLlm(): Promise<void> {
  const trpc = makeTrpc('http://localhost:8799')
  // workLlm migrated onto roles.background; seed that shape on my settings record.
  await setMyPreferences(trpc, {
    'roles.background.accountId': nativeAccountId('codex'),
    'roles.background.model': 'gpt-5.5',
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
  const trpc = makeTrpc('http://localhost:8799')
  const accounts = await trpc.accounts.list.query()
  // The harness always seeds the long-identity login (POD-4730) — match that
  // address itself, never host state. A missing seed is a harness failure, so
  // fail loudly instead of skipping.
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
  await setMyPreferences(trpc, {
    'roles.coding.accountId': nativeAccountId('codex'),
    'roles.coding.model': 'auto',
    'roles.coding.effort': 'auto',
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

  await expect
    .poll(async () => (await myPreferences(trpc)).value)
    .toMatchObject({ 'roles.coding.model': 'auto', 'roles.coding.effort': 'xhigh' })
})

test('new sessions exposes and persists both Grok implementation models', async ({ page }) => {
  const trpc = makeTrpc('http://localhost:8799')
  await setMyPreferences(trpc, {
    'roles.coding.accountId': nativeAccountId('grok'),
    'roles.coding.model': 'auto',
    'roles.coding.effort': 'auto',
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

  await expect
    .poll(async () => (await myPreferences(trpc)).value)
    .toMatchObject({
      'roles.coding.accountId': nativeAccountId('grok'),
      'roles.coding.model': 'grok-composer-2.5-fast',
    })
})

test('superagent uses shared Codex model and effort dropdowns', async ({ page }) => {
  const trpc = makeTrpc('http://localhost:8799')
  await setMyPreferences(trpc, {
    'roles.coding.accountId': nativeAccountId('grok'),
    'roles.superagent.accountId': nativeAccountId('codex'),
    'roles.superagent.model': 'gpt-5.5',
    'roles.superagent.effort': 'auto',
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

  // The record holds the leaves I chose; `harness` resolves from the account.
  await expect
    .poll(async () => (await myPreferences(trpc)).value)
    .toMatchObject({
      'roles.superagent.accountId': nativeAccountId('codex'),
      'roles.superagent.model': 'gpt-5.4',
      'roles.superagent.effort': 'xhigh',
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
  // hibernation is an instance leaf: the `instancePreferences` record (POD-6677).
  // A null here is the value "no cap", not a reset.
  await edit(trpc, 'records.instancePreferences.edit', 'instance', {
    'hibernation.maxIdleSessions': null,
  })
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
  await expect
    .poll(async () => (await instancePreferences(trpc))['hibernation.maxIdleSessions'])
    .toBe(12)
  await settings.screenshot({ path: '/tmp/POD-957-idle-cap-settings.png' })
})
