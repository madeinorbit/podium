/**
 * Runtime verification for the browser's unconditional private replica.
 *
 * The supported app must render from the kernel replica without consulting a
 * rollout flag, and an IndexedDB open failure must stop at the explicit retry
 * screen instead of mounting an outgoing compatibility store.
 */

import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { newSession, openApp, RELAY } from './_harness'

/** Evidence lands in the REPO so it can be attached to the issue and survive the run. */
const EVIDENCE = join(import.meta.dirname, '../../../docs/evidence/pod-1566')
const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: false })

test.skip(
  ({ isMobile }) => isMobile,
  'desktop verification: settings nav and the sidebar work list',
)
test.setTimeout(300_000)

type PathWindow = Window & {
  __podiumReplicaPath?: 'kernel'
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
  test('a blocked private replica open is fatal and retryable', async ({ page }) => {
    await page.addInitScript(() => {
      const native = globalThis.indexedDB
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: new Proxy(native, {
          get(target, property) {
            if (property === 'open') {
              return () => {
                throw new DOMException('IndexedDB is blocked', 'SecurityError')
              }
            }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }),
      })
    })
    await page.goto('/?server=' + RELAY + '&e2e=1')

    await expect(
      page.getByRole('heading', { name: 'Podium could not open its private replica' }),
    ).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText('IndexedDB is blocked')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
    await shot(page, 'fatal-private-replica')
    expect(await replicaPath(page)).toBeUndefined()
  })

  test('the rendered app opens the kernel replica unconditionally', async ({ page }) => {
    await openApp(page)
    await expectKernelPath(page)
    expect((await sidebarText(page)).length).toBeGreaterThan(0)
    await shot(page, '01-kernel-path-rendered')
  })

  test('cold offline start paints the persisted principal slice and per-user state', async ({
    page,
    context,
  }) => {
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
    await openApp(page)
    await expectKernelPath(page)

    // A SECOND CLIENT of the same user: its own tab, its own kernel replica, its
    // own feed subscription. The observer must resolve the same unconditional kernel path — asserted rather than assumed.
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

  test('the optimistic spawn grace window is unchanged on the private replica', async ({
    page,
  }) => {
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
