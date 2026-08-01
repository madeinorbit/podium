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
import { newSession, openApp, RELAY } from './_harness'

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
 * Drive the hidden `kernel-replica` flag through the REAL Settings UI.
 *
 * The harness runs from source, so the server is in dev mode and hidden flags are
 * listed with a "Dev" badge — which is what makes a real click possible here
 * instead of a back-door write to the settings blob.
 *
 * It sets an ABSOLUTE state rather than toggling, and the counterfactual test
 * below turns the flag OFF before asserting `legacy`. The flag lives in
 * instance settings, so it OUTLIVES the browser context: a run interrupted
 * before `global-teardown` wipes the harness state dir leaves it on, and a
 * counterfactual that assumed "off at the start" would then quietly assert
 * nothing on the next run. Asserting a state you did not establish is how a
 * check stops being a check.
 */
async function setKernelReplica(page: Page, on: boolean): Promise<void> {
  await openExperimental(page)
  const row = flagRow(page, 'Kernel replica (IndexedDB)')
  const toggle = row.getByRole('switch').first()
  await expect(toggle).toBeEnabled({ timeout: 30_000 })
  const want = on ? 'true' : 'false'
  if ((await toggle.getAttribute('aria-checked')) === want) return
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', want)

  // "Save changes" on the DIRTY BAR, and the bar reading "Saved ✓" is the
  // confirmation. Measured against the running app rather than copied: the
  // affordance in `experimental-settings.browser.e2e.ts` is `/^Save$/` plus
  // "Saved.", and neither exists — that spec is one of the suites POD-1227's
  // census finds red. Inheriting its locators made this suite fail for a reason
  // that had nothing to do with the cutover: the toggle flipped, nothing
  // persisted, and the app correctly resolved to the legacy path afterwards.
  const save = page.getByRole('button', { name: /^Save changes$/ })
  await expect(save).toBeVisible({ timeout: 15_000 })
  await save.click()
  await expect(page.getByText('Saved ✓')).toBeVisible({ timeout: 15_000 })
  // The dirty bar's button goes away once the blob is committed; asserting the
  // toast alone would pass on a save that was refused.
  await expect(save).toBeHidden({ timeout: 15_000 })
}

const enableKernelReplica = (page: Page) => setKernelReplica(page, true)

/**
 * LEAVE SETTINGS THE WAY A USER DOES, and why this is not ceremony.
 *
 * The Settings screen is an overlay over whichever view was last active, and on
 * this harness that ends up being Tasks — which renders no `complementary`
 * sidebar at all. Every helper that waits for the sidebar (including
 * `_harness.openApp`'s `gotoWorkspace`) then times out, and the failure reads as
 * "the app never booted" when the app is fine and simply showing a different
 * screen. Three of this suite's four tests failed exactly that way.
 *
 * Clicking the primary nav's Work button puts the app back where those helpers
 * expect it, with a real gesture rather than a navigation trick.
 */
async function leaveSettings(page: Page): Promise<void> {
  const work = page.getByRole('button', { name: 'Work', exact: true }).first()
  await work.click({ timeout: 30_000 })
  await sidebar(page).waitFor({ state: 'visible', timeout: 60_000 })
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

async function persistedSessionState(
  page: Page,
  sessionId: string,
): Promise<{ principal: string; hasSnooze: boolean; snoozedUntil: string | null } | null> {
  return page.evaluate(
    (wanted) =>
      new Promise((resolve, reject) => {
        const opened = indexedDB.open('podium-kernel-replica')
        opened.onerror = () => reject(opened.error ?? new Error('failed to open kernel replica'))
        opened.onsuccess = () => {
          const db = opened.result
          const tx = db.transaction('entities', 'readonly')
          const rows = tx.objectStore('entities').getAll()
          rows.onerror = () => reject(rows.error ?? new Error('failed to read kernel entities'))
          rows.onsuccess = () => {
            const row = (
              rows.result as Array<{
                principal: string
                entity: string
                entityId: string
                value: { snoozedUntil?: string | null }
              }>
            ).find((candidate) => candidate.entity === 'session' && candidate.entityId === wanted)
            db.close()
            resolve(
              row === undefined
                ? null
                : {
                    principal: row.principal,
                    hasSnooze: Object.hasOwn(row.value, 'snoozedUntil'),
                    snoozedUntil: row.value.snoozedUntil ?? null,
                  },
            )
          }
        }
      }),
    sessionId,
  )
}

test.describe('the web engine on the kernel replica', () => {
  test('the flag moves the rendered app onto the kernel path, and the marker can say legacy', async ({
    page,
  }) => {
    // ESTABLISH the flag-off state rather than assuming it — see setKernelReplica.
    await setKernelReplica(page, false)
    await leaveSettings(page)

    // BACK VIA `openApp`, not a bare goto: leaving Settings restores whichever
    // view was last persisted, and on this harness that is Tasks — which has no
    // `complementary` sidebar at all. A bare `goto('/')` plus a sidebar wait
    // silently assumed the Work view and timed out for a reason with nothing to
    // do with the read path. `openApp` is what the other tests here use, and it
    // navigates to the workspace explicitly.
    await openApp(page)

    // WITH THE FLAG OFF the app resolves the shipped path. This assertion is the
    // counterfactual for every `expectKernelPath` below: it shows the marker is a
    // measurement and not a constant.
    await expect
      .poll(async () => replicaPath(page), { timeout: 60_000, intervals: [200] })
      .toBe('legacy')

    await enableKernelReplica(page)
    await leaveSettings(page)

    // A reload is what a user gets: the gate resolves before the store mounts.
    await openApp(page)
    await expectKernelPath(page)

    // The app RENDERED from it — the work list is non-empty, and it is populated
    // by the v2 feed landing in the kernel replica and repainting through the
    // facade's rows()/subscribeRows().
    expect((await sidebarText(page)).length).toBeGreaterThan(0)
    await shot(page, '01-kernel-path-rendered')
  })

  test('cold offline start paints the persisted principal slice and per-user state', async ({
    page,
    context,
  }) => {
    await enableKernelReplica(page)
    await leaveSettings(page)
    await openApp(page)
    await expectKernelPath(page)
    await newSession(page, 'Shell')
    const sessionId = await openSessionId(page)
    const seeded = await sidebarText(page)
    expect(seeded.length).toBeGreaterThan(0)

    // Persist a user-owned row through the real control, then verify it reached
    // this principal's transactional entity region before disconnecting.
    const snooze = page.getByRole('button', { name: 'Snooze', exact: true }).first()
    await expect(snooze).toBeVisible({ timeout: 30_000 })
    await snooze.click()
    await expect(page.getByRole('button', { name: /^Snoozed/ }).first()).toBeVisible({
      timeout: 15_000,
    })
    await expect
      .poll(() => persistedSessionState(page, sessionId), {
        timeout: 60_000,
        intervals: [250],
      })
      .toMatchObject({ hasSnooze: true, snoozedUntil: null })

    // Reload with the DATA PLANE offline while the already-installed app shell
    // remains available: auth identity, settings/boot RPCs and the v2 socket all
    // fail. The sole principal namespace identifies the slice without a raw
    // last-user key, and the first paint must come from IndexedDB.
    await context.route('**/auth/status', (route) => route.abort('internetdisconnected'))
    await context.route('**/version', (route) => route.abort('internetdisconnected'))
    await context.route('**/trpc/**', (route) => route.abort('internetdisconnected'))
    await context.routeWebSocket('**', (socket) => socket.close())
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    await sidebar(page).waitFor({ state: 'visible', timeout: 8_000 })
    await expect
      .poll(async () => (await sidebarText(page)).length, { timeout: 8_000, intervals: [100] })
      .toBeGreaterThan(0)
    await expectKernelPath(page)
    await expect(page.getByRole('button', { name: /^Snoozed/ }).first()).toBeVisible({
      timeout: 8_000,
    })
    await page.screenshot({
      path: join(import.meta.dirname, '../../../docs/evidence/pod-401/cold-start-offline.png'),
      fullPage: false,
    })

    await context.unroute('**/auth/status')
    await context.unroute('**/version')
    await context.unroute('**/trpc/**')
  })

  test('offline write → reconnect → drain → convergence on a second client', async ({
    page,
    context,
  }) => {
    await enableKernelReplica(page)
    await leaveSettings(page)
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
    await leaveSettings(page)
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
