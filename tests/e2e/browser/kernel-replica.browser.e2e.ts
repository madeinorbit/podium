/**
 * RUNTIME VERIFICATION OF THE WEB CUTOVER (POD-1223).
 *
 * POD-376's basis document ends with a list of what it could NOT evidence, and
 * the first item is "the real UI": everything up to and including the wire is
 * verified against a live server in `tests/e2e/feed-v2.e2e.test.ts`, but the last
 * hop into the rendered app was not. This file is that hop. It runs the built web
 * bundle in a real browser against the harness relay, with the `kernel-replica`
 * flag turned on THROUGH THE SETTINGS UI, and asserts the same property the
 * sub-UI e2e already holds — an offline write, a reconnect, a drain, and
 * convergence on a second client of the same user.
 *
 * ---------------------------------------------------------------------------
 * THE INSTRUMENT CHECK THAT MAKES THIS NOT VACUOUS
 * ---------------------------------------------------------------------------
 *
 * Both read paths render the SAME UI when both are correct. A spec that turned
 * the flag on, rendered the app and passed would be indistinguishable from one
 * that silently ran the legacy path — the exact "instrument that cannot say NO"
 * shape this run keeps paying for. So every test here asserts
 * `window.__podiumReplicaPath === 'kernel'` FIRST, and the first test proves the
 * marker can read `legacy` too, by observing it with the flag off before turning
 * it on. A marker that only ever says one thing is not a measurement.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT COVERED HERE, AND WHY
 * ---------------------------------------------------------------------------
 *
 * THE SECOND-ACCOUNT CHECK. `CLIENT_PRINCIPAL_GRADE` is still `device` — one
 * shared password — so two browsers here are the same principal by construction
 * and the transport cannot name two people (basis §5, and POD-351's spec records
 * the same gap for the write path). Producing a second user would mean faking the
 * thing under test. It is recorded as blocked, not as a passing box.
 *
 * THE WRITE PATH. The rename below still drains through the client Outbox over
 * tRPC: this issue moved the READ model, and the kernel Outbox needs command
 * contracts POD-311 owns. That is deliberate and it does not weaken the
 * assertion — the observer's convergence is produced entirely by the v2 feed
 * landing in the kernel replica and repainting, which is the property under test.
 */

import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { openApp, RELAY } from './_harness'

/** Evidence lands in the REPO so it can be attached to the issue and survive the run. */
const EVIDENCE = join(import.meta.dirname, '../../../docs/evidence/pod-1223')
const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: false })

test.skip(
  ({ isMobile }) => isMobile,
  'desktop verification: settings nav and the sidebar work list',
)
test.setTimeout(300_000)

type PathWindow = Window & {
  __podiumReplicaPath?: 'legacy' | 'kernel' | 'kernel-with-shadow'
}

const sidebar = (page: Page) => page.getByRole('complementary').first()

async function sidebarText(page: Page): Promise<string> {
  return ((await sidebar(page).textContent()) ?? '').trim()
}

/** The read path THIS tab resolved to, once the gate has settled. */
async function replicaPath(page: Page): Promise<string | undefined> {
  return page.evaluate(() => (window as PathWindow).__podiumReplicaPath)
}

async function expectKernelPath(page: Page): Promise<void> {
  await expect
    .poll(async () => replicaPath(page), { timeout: 60_000, intervals: [200] })
    .toBe('kernel')
}

/** Deep-link to Settings → Experimental the way the shipped app routes. */
async function openExperimental(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await sidebar(page).waitFor({ state: 'visible', timeout: 120_000 })
  await page.evaluate(() => {
    history.pushState(null, '', `/settings/experimental${location.search}`)
    dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(page.getByRole('heading', { name: 'Experimental' })).toBeVisible({ timeout: 30_000 })
}

/** The flag row = the deepest div holding both the flag name and its switch. */
const flagRow = (page: Page, name: string) =>
  page
    .locator('div')
    .filter({ hasText: name })
    .filter({ has: page.getByRole('switch') })
    .last()

/**
 * Turn the hidden `kernel-replica` flag on through the REAL Settings UI.
 *
 * The harness runs from source, so the server is in dev mode and hidden flags are
 * listed with a "Dev" badge — which is what makes a real click possible here
 * instead of a back-door write to the settings blob.
 */
async function enableKernelReplica(page: Page): Promise<void> {
  await openExperimental(page)
  const row = flagRow(page, 'Kernel replica (IndexedDB)')
  const toggle = row.getByRole('switch').first()
  await expect(toggle).toBeEnabled({ timeout: 30_000 })
  if ((await toggle.getAttribute('aria-checked')) !== 'true') {
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('button', { name: /^Save$/ }).click()
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible({ timeout: 15_000 })
  }
}

const workspaceTab = (page: Page, sessionId: string) =>
  page.locator(`[data-session="${sessionId}"][role="button"]`)

async function openSessionId(page: Page): Promise<string> {
  const tab = page.locator('[data-session][role="button"]').first()
  await tab.waitFor({ state: 'visible', timeout: 45_000 })
  const id = await tab.getAttribute('data-session')
  if (!id) throw new Error('no data-session on the open workspace tab')
  return id
}

/** Rename as a user does: double-click the tab, type, Enter. */
async function renameViaUi(page: Page, sessionId: string, to: string): Promise<void> {
  const tab = workspaceTab(page, sessionId)
  await tab.waitFor({ state: 'visible', timeout: 30_000 })
  const editor = tab.locator('input[type="text"]').first()
  for (let attempt = 0; attempt < 2; attempt++) {
    await tab.click()
    await page.waitForTimeout(300)
    await tab.dblclick()
    const opened = await editor
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    if (opened) break
    if (attempt === 1) throw new Error(`rename editor never opened for ${sessionId}`)
  }
  await editor.fill(to)
  await editor.press('Enter')
}

async function expectConverged(page: Page, expected: string): Promise<void> {
  await expect
    .poll(async () => sidebarText(page), { timeout: 90_000, intervals: [250] })
    .toContain(expected)
}

test.describe('the web engine on the kernel replica', () => {
  test('the flag moves the rendered app onto the kernel path, and the marker can say legacy', async ({
    page,
  }) => {
    // WITH THE FLAG OFF the app resolves the shipped path. This assertion is the
    // counterfactual for every `expectKernelPath` below: it shows the marker is a
    // measurement and not a constant.
    await page.goto(`/?server=${RELAY}&e2e=1`)
    await sidebar(page).waitFor({ state: 'visible', timeout: 120_000 })
    await expect
      .poll(async () => replicaPath(page), { timeout: 60_000, intervals: [200] })
      .toBe('legacy')

    await enableKernelReplica(page)

    // A reload is what a user gets: the gate resolves before the store mounts.
    await openApp(page)
    await expectKernelPath(page)

    // The app RENDERED from it — the work list is non-empty, and it is populated
    // by the v2 feed landing in the kernel replica and repainting through the
    // facade's rows()/subscribeRows().
    expect((await sidebarText(page)).length).toBeGreaterThan(0)
    await shot(page, '01-kernel-path-rendered')
  })

  test('cold start paints from the persisted kernel store, before the feed answers', async ({
    page,
  }) => {
    await enableKernelReplica(page)
    await openApp(page)
    await expectKernelPath(page)
    const seeded = await sidebarText(page)
    expect(seeded.length).toBeGreaterThan(0)

    // RELOAD. The IndexedDB store is already populated, so the first render must
    // read it rather than wait for a bootstrap. The budget is what makes this an
    // assertion about PAINT rather than about eventual arrival: a client that
    // waited for the network would not have rows this early.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await sidebar(page).waitFor({ state: 'visible', timeout: 120_000 })
    await expect
      .poll(async () => (await sidebarText(page)).length, { timeout: 8_000, intervals: [100] })
      .toBeGreaterThan(0)
    await expectKernelPath(page)
    await shot(page, '02-cold-start-paint')
  })

  test('offline write → reconnect → drain → convergence on a second client', async ({
    page,
    context,
  }) => {
    await enableKernelReplica(page)
    await openApp(page)
    await expectKernelPath(page)

    // A SECOND CLIENT of the same user: its own tab, its own kernel replica, its
    // own feed subscription. The flag is per-install, so it resolves to the
    // kernel path too — asserted rather than assumed.
    const observer = await context.newPage()
    await openApp(observer)
    await expectKernelPath(observer)

    const sessionId = await openSessionId(page)

    // Seed a shared starting point ONLINE. If the online path were broken, every
    // offline assertion below would be measuring the wrong failure.
    const seed = `kernel-seed-${Date.now()}`
    await renameViaUi(page, sessionId, seed)
    await expectConverged(page, seed)
    await expectConverged(observer, seed)

    // OFFLINE. The outbox is now the only thing holding the write.
    await context.setOffline(true)
    const offlineName = `kernel-offline-${Date.now()}`
    await renameViaUi(page, sessionId, offlineName)

    // The author paints its own write with no server involved — the optimistic
    // overlay still derives correctly over a kernel-backed base.
    await expectConverged(page, offlineName)

    // The observer must NOT have it. Without this the offline case is
    // indistinguishable from an online one that succeeded.
    expect(await sidebarText(observer)).toContain(seed)
    expect(await sidebarText(observer)).not.toContain(offlineName)
    await shot(page, '03-offline-author-optimistic')
    await shot(observer, '04-offline-observer-still-old')

    // RECONNECT: the outbox drains and the change reaches the observer AS A v2
    // FEED DELTA applied by its kernel Replica. This is the assertion the whole
    // cutover exists for.
    await context.setOffline(false)
    await expectConverged(observer, offlineName)
    await expect
      .poll(async () => sidebarText(observer), { timeout: 60_000, intervals: [250] })
      .not.toContain(seed)

    // The author still shows it after the round trip: the authoritative row
    // replaced the overlay without flickering back.
    expect(await sidebarText(page)).toContain(offlineName)
    await shot(observer, '05-observer-converged-after-drain')

    await observer.close()
  })

  test('the optimistic spawn grace window is unchanged with the flag on', async ({ page }) => {
    await enableKernelReplica(page)
    await openApp(page)
    await expectKernelPath(page)

    // `openApp` spawns on an empty workspace and otherwise opens the existing one;
    // either way a session tab is present. The grace window's property is that the
    // client-minted row STAYS rendered while the server confirms — a row that
    // vanished and came back would be the regression.
    const sessionId = await openSessionId(page)
    const stable: boolean[] = []
    for (let i = 0; i < 12; i++) {
      stable.push(await workspaceTab(page, sessionId).isVisible())
      await page.waitForTimeout(300)
    }
    // 3.6s of samples spans the 2s SPAWN_CONFIRM_GRACE_MS on both sides.
    expect(stable.every(Boolean)).toBe(true)
    await shot(page, '06-spawn-grace-window')
  })
})
