/**
 * MU-12 (POD-6292; docs/design/multi-user-instance.md §4.5): after Alice signs
 * out and Bob signs in on the same device, Bob sees nothing of Alice's, and none
 * of Alice's queued commands is sent.
 *
 * "The same device" is one browser profile: every tab shares one cookie jar and
 * one storage. Tab A stays on Alice's world with a command queued while its
 * network was down; Alice signs out in tab B, through the real control, and Bob
 * signs in there. Then:
 *
 *  - tab A drops Alice's world at once (it never waits for a request to fail);
 *  - Bob's sidebar shows nothing of Alice's;
 *  - Alice's queued command never lands, as Bob or anyone: Bob's settings are
 *    unchanged after tab A's network comes back.
 *
 * Web covers the desktop shell too: the desktop app runs this same bundle in a
 * webview with one cookie jar. The phone check runs the Expo web build.
 *
 * Needs a password-protected isolated harness:
 *   PODIUM_PASSWORD=… bun run test:browser -- --suite account-switch --project=chromium-desktop
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type APIRequestContext,
  type BrowserContext,
  devices,
  expect,
  type Page,
  type PlaywrightWorkerArgs,
  test,
} from '@playwright/test'
import { RELAY } from './_harness'

const password = process.env.PODIUM_PASSWORD
test.skip(!password, 'This check needs a password-protected isolated harness (PODIUM_PASSWORD).')
test.skip(({ isMobile }) => isMobile, 'Runs both shells itself from the desktop project.')
test.setTimeout(300_000)

const HTTP = RELAY.replace(/^ws/, 'http')
const evidence = fileURLToPath(new URL('../../../.tmp/account-switch-check', import.meta.url))
const BOB = { email: 'bob-mu12@example.com', password: 'bob-mu12-password', displayName: 'Bob' }

/** Sign in through the real login route; the cookie lands in the context's jar. */
async function signIn(request: APIRequestContext, who: 'alice' | 'bob'): Promise<void> {
  const response = await request.post(`${HTTP}/auth/login`, {
    data: who === 'alice' ? { password } : { email: BOB.email, password: BOB.password },
  })
  if (!response.ok()) throw new Error(`${who} could not sign in: ${response.status()}`)
}

/** Bob joins the instance the way people do: Alice invites him and he accepts. */
async function ensureBob(playwright: PlaywrightWorkerArgs['playwright']): Promise<void> {
  const probe = await playwright.request.newContext()
  const known = await probe.post(`${HTTP}/auth/login`, {
    data: { email: BOB.email, password: BOB.password },
  })
  await probe.dispose()
  if (known.ok()) return
  const alice = await playwright.request.newContext()
  await signIn(alice, 'alice')
  const invited = await alice.post(`${HTTP}/auth/members/invite`, { data: { email: BOB.email } })
  if (!invited.ok()) throw new Error(`invite failed: ${invited.status()} ${await invited.text()}`)
  const { invite } = (await invited.json()) as { invite: { token: string } }
  const completed = await alice.post(`${HTTP}/auth/members/complete`, {
    data: { token: invite.token, ...BOB },
  })
  if (!completed.ok()) throw new Error(`accept failed: ${completed.status()}`)
  await alice.dispose()
}

/** Bob's personal settings as the server holds them. */
async function bobSidebarSettings(
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<unknown> {
  const bob = await playwright.request.newContext()
  await signIn(bob, 'bob')
  const response = await bob.get(`${HTTP}/trpc/settings.get`)
  const body = (await response.json()) as { result: { data: { sidebar?: unknown } } }
  await bob.dispose()
  return body.result.data.sidebar
}

/** A started task of Alice's with a title nobody else has: her private work, by name. */
async function createAliceTask(request: APIRequestContext, repo = 0): Promise<string> {
  const repos = await request.get(`${HTTP}/trpc/repos.list?input=${encodeURIComponent('{}')}`)
  const repoPath = ((await repos.json()) as { result: { data: string[] } }).result.data[repo]
  if (!repoPath) throw new Error(`isolated harness has no repo #${repo}`)
  const title = `Alice private ${Date.now().toString(36)}`
  const created = await request.post(`${HTTP}/trpc/issues.create`, {
    // The harness's second repo has only `main`; the first is the checkout itself.
    data: { repoPath, title, startNow: true, ...(repo === 0 ? {} : { parentBranch: 'main' }) },
  })
  if (!created.ok()) throw new Error(`issues.create: ${created.status()} ${await created.text()}`)
  return title
}

async function openWeb(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 120_000 })
}

/** Queue one of Alice's commands while tab A cannot reach the server. */
async function queueAliceCommand(page: Page): Promise<() => number> {
  let attempts = 0
  await page.route(
    (url) => url.pathname.startsWith('/trpc/') && url.pathname.includes('settings.updatePersonal'),
    async (route) => {
      attempts += 1
      await route.abort('internetdisconnected')
    },
  )
  const aside = page.locator('aside').first()
  await aside.getByTestId('folder-options').first().click()
  await page.getByRole('menuitem', { name: 'Move down' }).click()
  await expect.poll(() => attempts, { timeout: 15_000 }).toBeGreaterThan(0)
  return () => attempts
}

async function signOutOnWeb(page: Page): Promise<void> {
  await page.evaluate(() => {
    history.pushState(null, '', `/settings/security${location.search}`)
    dispatchEvent(new PopStateEvent('popstate'))
  })
  await page.getByRole('button', { name: 'Sign out', exact: true }).click({ timeout: 30_000 })
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible({ timeout: 30_000 })
}

async function signInBobOnWeb(page: Page): Promise<void> {
  const withEmail = page.getByRole('button', { name: 'Sign in with email' })
  if (await withEmail.isVisible().catch(() => false)) await withEmail.click()
  await page.getByLabel('Email', { exact: true }).fill(BOB.email)
  await page.getByLabel('Password', { exact: true }).fill(BOB.password)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  // Bob is new here: his shell may open on a first-run view rather than the sidebar.
  await expect(page.getByLabel('Password', { exact: true })).toBeHidden({ timeout: 60_000 })
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  const status = await page.evaluate(() =>
    fetch('/auth/status').then((response) => response.json() as Promise<{ memberId?: string }>),
  )
  expect(status.memberId, 'tab B is signed in as Bob').toBeTruthy()
  await page.waitForTimeout(3_000)
}

/** Let tab A's network back in, and nudge its queue as a reconnect would. */
async function restoreNetwork(page: Page): Promise<void> {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await page.evaluate(() => dispatchEvent(new Event('online'))).catch(() => {})
  await page.waitForTimeout(5_000)
}

test('web: Bob sees nothing of Alice’s, and her queued command is never sent', async ({
  browser,
  playwright,
}) => {
  mkdirSync(evidence, { recursive: true })
  await ensureBob(playwright)
  const bobBefore = await bobSidebarSettings(playwright)
  expect(bobBefore, 'Bob’s sidebar settings must be readable').toBeDefined()

  const device: BrowserContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  })
  await signIn(device.request, 'alice')
  const title = await createAliceTask(device.request)
  // A second project, so the sidebar has an order Alice can change.
  await createAliceTask(device.request, 1)
  const tabA = await device.newPage()
  // Evidence: each request the member fence refused, and whose it was.
  const trace = (tab: string, page: Page) => {
    page.on('response', async (r) => {
      if (r.status() !== 401) return
      const sent = (await r.request().allHeaders())['x-podium-member'] ?? '-'
      const body = await r.text().catch(() => '')
      console.log(`[${tab}] 401 ${new URL(r.url()).pathname} fence=${sent} ${body.slice(0, 120)}`)
    })
  }
  trace('A', tabA)
  await test.step('tab A opens as Alice', () => openWeb(tabA))
  const aliceTask = tabA.getByText(title)
  await expect(aliceTask.first()).toBeVisible({ timeout: 60_000 })
  await expect(tabA.locator('aside').first().getByTestId('project-group-label')).toHaveCount(2, {
    timeout: 60_000,
  })
  await queueAliceCommand(tabA)

  const tabB = await device.newPage()
  trace('B', tabB)
  await test.step('tab B opens as Alice', () => openWeb(tabB))
  await test.step('Alice signs out in tab B', () => signOutOnWeb(tabB))

  // Tab A let go of Alice's world the moment she signed out elsewhere.
  await expect(aliceTask).toHaveCount(0, { timeout: 15_000 })
  await expect(tabA.getByTestId('unified-issue-row')).toHaveCount(0)

  await test
    .step('Bob signs in in tab B', () => signInBobOnWeb(tabB))
    .catch(async (error) => {
      await tabB.screenshot({ path: resolve(evidence, 'web-tab-b-failed.png') }).catch(() => {})
      console.log(`[tab B body] ${(await tabB.locator('body').innerText()).slice(0, 400)}`)
      throw error
    })
  await expect(tabB.getByTestId('unified-issue-row')).toHaveCount(0)
  await expect(tabB.getByText(title)).toHaveCount(0)
  await tabB.screenshot({ path: resolve(evidence, 'web-bob-after-switch.png') })
  await tabA.screenshot({ path: resolve(evidence, 'web-tab-a-after-switch.png') })

  await restoreNetwork(tabA)
  await expect(aliceTask).toHaveCount(0)
  expect(await bobSidebarSettings(playwright), 'Alice’s queued write landed on Bob').toEqual(
    bobBefore,
  )
  await device.close()
})

test('phone: Bob sees nothing of Alice’s after she logs out', async ({ browser, playwright }) => {
  mkdirSync(evidence, { recursive: true })
  await ensureBob(playwright)
  const phone = devices['Pixel 7']!
  const device = await browser.newContext({
    viewport: phone.viewport,
    userAgent: phone.userAgent,
    deviceScaleFactor: phone.deviceScaleFactor,
    isMobile: phone.isMobile,
    hasTouch: phone.hasTouch,
    serviceWorkers: 'block',
  })
  await signIn(device.request, 'alice')
  const title = await createAliceTask(device.request)

  const tabA = await device.newPage()
  await tabA.goto(`/mobile/work?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  const aliceRows = tabA.getByRole('button', { name: new RegExp(title) })
  await expect(aliceRows.first()).toBeVisible({ timeout: 60_000 })

  const tabB = await device.newPage()
  await tabB.goto(`/mobile/settings?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await tabB.getByLabel('Log out').click({ timeout: 60_000 })
  // Logging out reloads the page; sign in on the page it lands on.
  await tabB.waitForEvent('load', { timeout: 60_000 }).catch(() => {})
  await expect(tabB.getByLabel('Password', { exact: true })).toBeVisible({ timeout: 60_000 })

  // Tab A let go of Alice's work the moment she logged out elsewhere.
  await expect(aliceRows).toHaveCount(0, { timeout: 15_000 })

  await tabB.getByLabel('Email', { exact: true }).fill(BOB.email)
  await tabB.getByLabel('Password', { exact: true }).fill(BOB.password)
  await expect(tabB.getByLabel('Email', { exact: true })).toHaveValue(BOB.email)
  await tabB.getByRole('button', { name: 'Log in', exact: true }).click()
  await expect(tabB.getByLabel('Password', { exact: true })).toBeHidden({ timeout: 60_000 })
  await tabB.goto(`/mobile/work?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(tabB.getByRole('tab', { name: 'Work', exact: true })).toBeVisible({
    timeout: 60_000,
  })
  await tabB.waitForTimeout(3_000)
  await expect(tabB.getByText(title)).toHaveCount(0)
  await expect(aliceRows).toHaveCount(0)
  await tabB.screenshot({ path: resolve(evidence, 'phone-bob-after-switch.png') })
  await tabA.screenshot({ path: resolve(evidence, 'phone-tab-a-after-switch.png') })
  await device.close()
})
