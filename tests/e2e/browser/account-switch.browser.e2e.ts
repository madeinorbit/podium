/**
 * MU-12 (POD-6292; docs/design/multi-user-instance.md §4.5): after Alice signs
 * out and Bob signs in on the same device, Bob sees nothing of Alice's, and none
 * of Alice's queued commands is sent.
 *
 * "The same device" is one browser profile: every tab shares one cookie jar and
 * one storage. Tab A stays on Alice's world; Alice signs out in tab B, through
 * the real control, and Bob signs in there.
 *
 * Tasks are shared (POD-6288): Bob reads Alice's task, so its title is the
 * POSITIVE control, proving each view has loaded the task. What is Alice's alone
 * is her per-member pin on it (design 4.1, per-user state). Each view shows it:
 * the web task page as a "pinned" chip, the phone's mission menu as "Unpin".
 *
 *  - tab A shows Alice's pin until she signs out elsewhere, then drops it at
 *    once (it never waits for a request to fail);
 *  - Bob's view of the same task shows its title and not her pin;
 *  - on web, a command Alice queued offline in tab A never lands on Bob: his
 *    settings are unchanged after tab A's network comes back.
 *
 * These checks cover Chromium and the Expo web build. Native desktop webview
 * cookies and a real phone's storage/transport boundary need separate evidence.
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
  const { userId: bob } = (await completed.json()) as { userId: string }
  // Bob has no machine of his own. Alice shares hers, as an admin would for a
  // teammate, so Bob's web shell opens on tasks rather than first-run setup.
  const listed = await alice.get(`${HTTP}/trpc/machines.list`)
  const machines = ((await listed.json()) as { result: { data: { id: string }[] } }).result.data
  for (const machine of machines) {
    const shared = await alice.post(`${HTTP}/trpc/machines.share`, {
      data: { id: machine.id, grantee: bob, verb: 'use', acknowledgeSharedMachine: true },
    })
    if (!shared.ok()) throw new Error(`share failed: ${shared.status()} ${await shared.text()}`)
  }
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

interface AliceTask {
  readonly id: string
  readonly title: string
}

/** A started task of Alice's, pinned by her: the pin is hers alone. */
async function createAliceTask(request: APIRequestContext, repo = 0): Promise<AliceTask> {
  const repos = await request.get(`${HTTP}/trpc/repos.list?input=${encodeURIComponent('{}')}`)
  const repoPath = ((await repos.json()) as { result: { data: string[] } }).result.data[repo]
  if (!repoPath) throw new Error(`isolated harness has no repo #${repo}`)
  const title = `Alice private ${Date.now().toString(36)}`
  // A fresh daemon may still be probing claude-code when the UI becomes ready.
  // Wait BEFORE create: startNow can persist a task before refusing its start.
  await expect
    .poll(
      async () => {
        const listed = await request.get(`${HTTP}/trpc/machines.list`)
        if (!listed.ok())
          throw new Error(`machines.list: ${listed.status()} ${await listed.text()}`)
        const machines = (
          (await listed.json()) as {
            result: {
              data: Array<{
                online: boolean
                inventory?: { agents: Array<{ kind: string; installed: boolean }> }
              }>
            }
          }
        ).result.data
        return machines.some(
          (machine) =>
            machine.online &&
            machine.inventory?.agents.some(
              (agent) => agent.kind === 'claude-code' && agent.installed,
            ),
        )
      },
      { timeout: 60_000, message: 'the fresh harness has finished probing claude-code' },
    )
    .toBe(true)
  const created = await request.post(`${HTTP}/trpc/issues.create`, {
    // The harness's second repo has only `main`; the first is the checkout itself.
    data: { repoPath, title, startNow: true, ...(repo === 0 ? {} : { parentBranch: 'main' }) },
  })
  if (!created.ok()) throw new Error(`issues.create: ${created.status()} ${await created.text()}`)
  const data = (
    (await created.json()) as { result: { data: { id?: string; issue?: { id: string } } } }
  ).result.data
  const id = data.id ?? data.issue?.id
  if (!id) throw new Error('issues.create returned no id')
  const pinned = await request.post(`${HTTP}/trpc/issues.update`, {
    data: { id, patch: { pinned: true } },
  })
  if (!pinned.ok()) throw new Error(`pin: ${pinned.status()} ${await pinned.text()}`)
  return { id, title }
}

/** Open a task's page in the web app, client-side (the harness has no SPA fallback). */
async function openWebTask(page: Page, id: string): Promise<void> {
  await page.evaluate((issueId) => {
    history.pushState(null, '', `/issues/${encodeURIComponent(issueId)}${location.search}`)
    dispatchEvent(new PopStateEvent('popstate'))
  }, id)
}

/** The web task page's per-member pin chip. */
const pinChip = (page: Page) => page.getByText('pinned', { exact: true })

async function openWeb(page: Page): Promise<void> {
  // Bob is new and has no machine; skip the first-run setup screen so his shell
  // shows tasks the same way Alice's does.
  await page.addInitScript(() => {
    ;(window as Window & { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__ = true
  })
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
  const task = await createAliceTask(device.request)
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
  await expect(tabA.locator('aside').first().getByTestId('project-group-label')).toHaveCount(2, {
    timeout: 60_000,
  })
  await test.step('Alice queues a command offline in tab A', () => queueAliceCommand(tabA))
  await openWebTask(tabA, task.id)
  await expect(tabA.getByText(task.title).first()).toBeVisible({ timeout: 60_000 })
  await expect(pinChip(tabA), 'tab A shows Alice’s own pin').toBeVisible({ timeout: 30_000 })

  const tabB = await device.newPage()
  trace('B', tabB)
  await test.step('tab B opens as Alice', () => openWeb(tabB))
  await test.step('Alice signs out in tab B', () => signOutOnWeb(tabB))

  // Tab A let go of Alice's world the moment she signed out elsewhere.
  await expect(pinChip(tabA), 'tab A still shows Alice’s pin').toHaveCount(0, { timeout: 15_000 })
  await expect(tabA.getByText(task.title)).toHaveCount(0)
  await expect(tabB.getByLabel('Password', { exact: true })).toBeVisible({ timeout: 30_000 })

  await test
    .step('Bob signs in in tab B', () => signInBobOnWeb(tabB))
    .catch(async (error) => {
      await tabB.screenshot({ path: resolve(evidence, 'web-tab-b-failed.png') }).catch(() => {})
      console.log(`[tab B body] ${(await tabB.locator('body').innerText()).slice(0, 400)}`)
      throw error
    })
  await openWebTask(tabB, task.id)
  // Positive control: Bob's view has loaded Alice's (shared) task...
  await expect(tabB.getByText(task.title).first())
    .toBeVisible({ timeout: 60_000 })
    .catch(async (error) => {
      await tabB.screenshot({ path: resolve(evidence, 'web-tab-b-task.png') }).catch(() => {})
      console.log(`[tab B ${tabB.url()}] ${(await tabB.locator('body').innerText()).slice(0, 600)}`)
      throw error
    })
  // ...and shows nothing that is Alice's alone.
  await expect(pinChip(tabB), 'Bob sees Alice’s pin').toHaveCount(0)
  await tabB.screenshot({ path: resolve(evidence, 'web-bob-after-switch.png') })
  await tabA.screenshot({ path: resolve(evidence, 'web-tab-a-after-switch.png') })

  await restoreNetwork(tabA)
  await expect(pinChip(tabA)).toHaveCount(0)
  expect(await bobSidebarSettings(playwright), 'Alice’s queued write landed on Bob').toEqual(
    bobBefore,
  )
  await device.close()
})

/** The phone's mission for a task, opened from Work, with its actions menu open. */
async function openPhoneMissionMenu(page: Page, title: string): Promise<void> {
  await page
    .getByRole('button', { name: new RegExp(title) })
    .first()
    .click({ timeout: 60_000 })
  await page.getByLabel('Mission actions', { exact: true }).click({ timeout: 60_000 })
  await expect(page.getByText('Task details', { exact: true })).toBeVisible({ timeout: 30_000 })
}

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
  const task = await createAliceTask(device.request)

  const tabA = await device.newPage()
  await tabA.goto(`/mobile/work?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await openPhoneMissionMenu(tabA, task.title)
  const aliceUnpin = tabA.getByText('Unpin', { exact: true })
  await expect(aliceUnpin, 'tab A shows Alice’s own pin').toBeVisible()

  const tabB = await device.newPage()
  await tabB.goto(`/mobile/settings?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await tabB.getByLabel('Log out').click({ timeout: 60_000 })

  // Tab A let go of Alice's world the moment she logged out elsewhere.
  await expect(aliceUnpin, 'tab A still shows Alice’s pin').toHaveCount(0, { timeout: 15_000 })
  await expect(tabA.getByText(task.title)).toHaveCount(0)

  // Logging out reloads the page; sign in on the page it lands on.
  await tabB.waitForEvent('load', { timeout: 60_000 }).catch(() => {})
  await expect(tabB.getByLabel('Password', { exact: true })).toBeVisible({ timeout: 60_000 })
  await tabB.getByLabel('Email', { exact: true }).fill(BOB.email)
  await tabB.getByLabel('Password', { exact: true }).fill(BOB.password)
  await expect(tabB.getByLabel('Email', { exact: true })).toHaveValue(BOB.email)
  await tabB.getByRole('button', { name: 'Log in', exact: true }).click()
  await expect(tabB.getByLabel('Password', { exact: true })).toBeHidden({ timeout: 60_000 })
  await tabB.goto(`/mobile/work?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  // Positive control: Bob's view has loaded Alice's (shared) task and its menu...
  await openPhoneMissionMenu(tabB, task.title)
  await expect(tabB.getByText('Pin', { exact: true })).toBeVisible()
  // ...and shows nothing that is Alice's alone.
  await expect(tabB.getByText('Unpin', { exact: true }), 'Bob sees Alice’s pin').toHaveCount(0)
  await expect(aliceUnpin).toHaveCount(0)
  await tabB.screenshot({ path: resolve(evidence, 'phone-bob-after-switch.png') })
  await tabA.screenshot({ path: resolve(evidence, 'phone-tab-a-after-switch.png') })
  await device.close()
})
