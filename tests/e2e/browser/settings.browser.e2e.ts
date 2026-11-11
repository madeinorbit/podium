import { expect, type Page, test } from '@playwright/test'
import { makeTrpc } from '../../../apps/web/src/app/trpc'
import { nativeAccountId } from '../../../packages/runtime/src/settings'
import { E2E_LONG_IDENTITY_EMAIL } from '../account-identity-fixture'
import { deferUpdateOffers, RELAY } from './_harness'

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
test.beforeEach(async ({ page }) => deferUpdateOffers(page))

async function seedStaleCodexWorkLlm(): Promise<void> {
  const trpc = makeTrpc('http://localhost:8799')
  for (const provider of ['anthropic', 'openai', 'openrouter'] as const) {
    await trpc.accounts.connect.mutate({
      provider,
      kind: 'api-key',
      credential: `sk-browser-fixture-${provider}`,
    })
  }
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

async function openAgents(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Agents', exact: true }).click()
  return settings
}

function section(page: Page, name: string) {
  return page
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('heading', { name, exact: true })
    .locator('xpath=ancestor::section[1]')
}

function backgroundWorkSection(page: Page) {
  return section(page, 'Background model')
}

function superagentSection(page: Page) {
  return section(page, 'Superagent')
}

function newSessionsSection(page: Page) {
  return section(page, 'New sessions')
}

function accountsSection(page: Page) {
  return section(page, 'Logins on your machines')
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
  await settings.getByRole('button', { name: 'AI accounts', exact: true }).click()

  const section = accountsSection(page)
  const value = section.getByText(E2E_LONG_IDENTITY_EMAIL, { exact: true })
  await expect(value).toBeVisible()
  // The full identity fits the row without clipping, even for the long fixture.
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

  await openAgents(page)
  const section = newSessionsSection(page)
  await expect(section.getByRole('button', { name: 'Model', exact: true })).toContainText('Auto')
  const effort = section.locator('fieldset[aria-label="Effort"]')
  await expect(effort).toBeVisible()
  await expect(section.getByText('Subagent model', { exact: true })).toHaveCount(0)
  await effort.getByRole('button', { name: 'Extra high', exact: true }).click()
  await expect(page.getByText('Saved', { exact: true }).last()).toBeVisible({ timeout: 10_000 })

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

  await openAgents(page)
  const section = newSessionsSection(page)
  // The role model precedes the optional subagent model.
  // role picker is first, as in the effort test above.
  const model = section.getByRole('button', { name: 'Model', exact: true })
  await model.click()

  await expect(page.getByRole('menuitem', { name: /^(grok-4\.5|Grok 4\.5)$/ })).toBeVisible()
  const composer = page.getByRole('menuitem', {
    name: /^(grok-composer-2\.5-fast|Composer 2\.5 Fast)$/,
  })
  await expect(composer).toBeVisible()
  await composer.click()
  await expect(page.getByText('Saved', { exact: true }).last()).toBeVisible({ timeout: 10_000 })

  await expect
    .poll(async () => (await myPreferences(trpc)).value)
    .toMatchObject({
      'roles.coding.accountId': nativeAccountId('grok'),
      'roles.coding.model': 'grok-composer-2.5-fast',
    })
})

test('superagent saves model and segmented effort immediately', async ({ page }) => {
  const trpc = makeTrpc('http://localhost:8799')
  await setMyPreferences(trpc, {
    'roles.coding.accountId': nativeAccountId('grok'),
    'roles.superagent.accountId': nativeAccountId('codex'),
    'roles.superagent.model': 'gpt-5.5',
    'roles.superagent.effort': 'auto',
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  const settings = await openAgents(page)
  await expect(settings.getByRole('heading', { name: 'Superagent', exact: true })).toBeVisible()

  const section = superagentSection(page)
  const model = section.getByRole('button', { name: 'Model', exact: true })
  await expect(model).toContainText('GPT-5.5')
  await model.click()
  await page.getByRole('menuitem', { name: 'GPT-5.4', exact: true }).click()

  const effort = section.locator('fieldset[aria-label="Effort"]')
  await effort.getByRole('button', { name: 'Extra high', exact: true }).click()
  await expect(page.getByText('Saved', { exact: true }).last()).toBeVisible({ timeout: 10_000 })

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

  const settings = await openAgents(page)
  await expect(
    settings.getByRole('heading', { name: 'Background model', exact: true }),
  ).toBeVisible()

  const section = backgroundWorkSection(page)
  const account = section.getByRole('combobox', { name: 'Runs on', exact: true })
  // POD-4475: one descriptor label per harness ('Codex' + identity/machine
  // suffixes) instead of 'Codex (ChatGPT)'.
  await expect(account).toContainText(/^Codex/)
  await account.click()
  // Every connected Codex login adds its own suffixed option next to the base
  // descriptor one (the POD-4730 long-identity fixture does so deterministically),
  // so assert at least one Codex option rather than exactly one.
  await expect(page.getByRole('option', { name: /^Codex/ }).first()).toBeVisible()
  await expect(page.getByRole('option', { name: /^Anthropic/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /^OpenAI/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /^OpenRouter/ })).toBeVisible()
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
  await settings.getByRole('button', { name: 'Machines', exact: true }).click()
  const input = settings.getByRole('spinbutton', { name: 'Keep at most' })
  await expect(input).toHaveValue('')
  await expect(
    settings.getByText(/Idle sessions per machine before the oldest are paused/),
  ).toBeVisible()
  await input.fill('12')
  await input.press('Enter')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await expect
    .poll(async () => (await instancePreferences(trpc))['hibernation.maxIdleSessions'])
    .toBe(12)
})
