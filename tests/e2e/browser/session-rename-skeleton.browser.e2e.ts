/**
 * RUNTIME VERIFICATION FOR THE WALKING SKELETON (POD-351).
 *
 * `sessions.rename` is the one command running on the target path in production
 * config (`renameProc` → `dispatchRename` → `renameOnTargetPath`). Every other
 * assertion in this issue is a unit or integration one; this file is the only
 * place the whole vertical runs against a REAL STACK with a REAL BROWSER and a
 * real click — the relay, the built web bundle, the WebSocket feed, the replica
 * and the outbox.
 *
 * It exists because the acceptance criterion says "REAL runtime UI verification",
 * and because a rename that unit-tests perfectly and never repaints a second
 * client is exactly the failure a unit suite cannot see.
 *
 * WHAT IS COVERED HERE
 *   1. Rename from the web UI, ONLINE → converges on a SECOND CLIENT.
 *   2. Rename from the web UI, OFFLINE → paints optimistically on the author,
 *      then drains on reconnect and converges on the second client.
 *
 * WHAT IS NOT, AND WHY — the different-user denial. The criterion asks for a
 * client of a DIFFERENT user to be denied on the write path. That is not
 * expressible at runtime today: authentication is one shared password and
 * `client_sessions` has no user column (readiness §3.2), so the transport cannot
 * mint a second person — every browser here is the same principal by
 * construction. Producing one would mean faking the very thing under test.
 *
 * It IS proven, at the enforcement point where a principal is an argument:
 * `apps/server/src/modules/sessions/rename-shadow.test.ts` ("an agent whose human
 * does NOT hold the session is denied at apply") and `rename-offline.test.ts`
 * (revoked owner, revoked grant, revoked delegating human). POD-1075 makes the
 * runtime half possible; the ledger records the gap rather than implying it away.
 */

import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { openApp } from './_harness'

/**
 * Screenshots land in the REPO, not in test-results/: they are this issue's runtime
 * evidence and are attached to POD-351, so they have to survive the run. A
 * scratchpad or test-results path does not render in the issue sidebar.
 */
const EVIDENCE = join(import.meta.dirname, '../../../docs/evidence/pod-351')
const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: false })

test.skip(({ isMobile }) => isMobile, 'desktop verification: the rename affordance is the sidebar row')
test.setTimeout(240_000)

/**
 * CONVERGENCE IS OBSERVED ON THE SIDEBAR, NOT ON THE WORKSPACE TAB STRIP.
 *
 * Measured, not assumed: a diagnostic run showed each client carries its OWN open
 * pane (`?pane=<id>` in the URL) and renders a tab only for the panes IT has open.
 * The author's tab strip and the observer's are different sets. Asserting there
 * would have tested which pane the second browser happened to have focused —
 * exactly the "test name is a claim" failure, since the claim is about the FEED.
 *
 * The sidebar work list is rendered from each client's own replica and lists the
 * session on both, so it is the shared surface where convergence is visible. It is
 * also a real rename affordance: double-click opens the same `SessionNameEditor`
 * the workspace tab uses (sidebar-common.tsx), so this is still a real user
 * gesture, not a back door.
 */
const sidebar = (page: Page) => page.getByRole('complementary').first()

/** Everything this client currently renders in its work list. */
async function sidebarText(page: Page): Promise<string> {
  return ((await sidebar(page).textContent()) ?? '').trim()
}

/**
 * The AUTHOR renames through its own WORKSPACE TAB, which is addressed by session
 * id rather than by the name it currently shows.
 *
 * Name-addressed targeting would have coupled these two tests to each other:
 * they share one relay, so the second test would look for a label the first test
 * had already changed. Addressing the tab by id makes each test independent of
 * what the session happens to be called when it starts — which is also the honest
 * way to point at "the same session" while the thing under test IS its name.
 *
 * `[role="button"]` disambiguates the tab from the session PANE, which carries the
 * same `data-session` but renders the terminal rather than the label.
 */
const workspaceTab = (page: Page, sessionId: string) =>
  page.locator(`[data-session="${sessionId}"][role="button"]`)

/** The id of the session this client currently has open. */
async function openSessionId(page: Page): Promise<string> {
  const tab = page.locator('[data-session][role="button"]').first()
  await tab.waitFor({ state: 'visible', timeout: 45_000 })
  const id = await tab.getAttribute('data-session')
  if (!id) throw new Error('no data-session on the open workspace tab')
  return id
}

/** Rename through the UI exactly as a user does: double-click the tab, type, Enter. */
async function renameViaUi(page: Page, sessionId: string, to: string): Promise<void> {
  const tab = workspaceTab(page, sessionId)
  await tab.waitFor({ state: 'visible', timeout: 30_000 })

  // The tab is a drag handle as well as a control, so the first pointer sequence
  // after mount can be swallowed by the sortable sensor. Select it, settle, then
  // double-click — and retry once, because a flaky GESTURE would otherwise read as
  // a failure of the rename PATH, which is the thing actually under test.
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

/** Wait until this client has RENDERED `expected` in its work list. */
async function expectConverged(page: Page, expected: string): Promise<void> {
  await expect
    .poll(async () => sidebarText(page), { timeout: 90_000, intervals: [250] })
    .toContain(expected)
}

/** ...and the inverse, so a client that appended rather than replaced still fails. */
async function expectGone(page: Page, absent: string): Promise<void> {
  await expect
    .poll(async () => sidebarText(page), { timeout: 60_000, intervals: [250] })
    .not.toContain(absent)
}

/** The label `openApp`'s empty-state spawn gives a fresh session. */
const FRESH_SESSION = 'New Claude session'

test.describe('session.rename on the target path, end to end', () => {
  test('online: a rename converges on a second client', async ({ page, context }) => {
    await openApp(page)

    // A SECOND CLIENT of the same user — a second tab is a second replica with its
    // own feed subscription, which is what convergence has to be observed on.
    const observer = await context.newPage()
    await openApp(observer)

    const sessionId = await openSessionId(page)

    // INSTRUMENT CHECK: the observer is rendering this session BEFORE the rename.
    // Without it, a convergence failure below is indistinguishable from an observer
    // that never rendered the session at all.
    const before = await sidebarText(observer)
    expect(before.length).toBeGreaterThan(0)

    const renamed = `skeleton-online-${Date.now()}`
    await renameViaUi(page, sessionId, renamed)

    // THE AUTHOR shows it (optimistic or authoritative — either is correct here).
    await expectConverged(page, renamed)

    // THE OBSERVER converges through the delta feed. This is the assertion the whole
    // vertical exists for: contract -> handler -> Authority commit -> feed -> the
    // other replica -> its UI.
    await expectConverged(observer, renamed)

    // ...and the old label is gone there. A client that appended rather than
    // replaced would pass the assertion above and fail this one.
    await expectGone(observer, FRESH_SESSION)
    expect(before).not.toContain(renamed)

    await shot(page, '01-online-author')
    await shot(observer, '02-online-observer-converged')

    await observer.close()
  })

  test('offline: a rename paints optimistically, then drains and converges on reconnect', async ({
    page,
    context,
  }) => {
    await openApp(page)
    const observer = await context.newPage()
    await openApp(observer)

    // Seed a known shared starting point ONLINE and confirm both clients agree. If
    // the online path were broken, every offline assertion below would be measuring
    // the wrong failure.
    const sessionId = await openSessionId(page)
    const seed = `skeleton-seed-${Date.now()}`
    await renameViaUi(page, sessionId, seed)
    await expectConverged(observer, seed)

    // GO OFFLINE. The client outbox is now the only thing holding the write.
    await context.setOffline(true)

    const offlineName = `skeleton-offline-${Date.now()}`
    await renameViaUi(page, sessionId, offlineName)

    // THE OPTIMISTIC OVERLAY — the author sees its own write with no server
    // involved. This is the optimistic path this issue shipped, running for real.
    await expectConverged(page, offlineName)

    // The observer must NOT have it: nothing left the author's machine. Without
    // this the offline case is indistinguishable from an online one that succeeded.
    expect(await sidebarText(observer)).toContain(seed)
    expect(await sidebarText(observer)).not.toContain(offlineName)

    await shot(page, '03-offline-author-optimistic')
    await shot(observer, '04-offline-observer-still-old')

    // RECONNECT — the outbox drains, the write is re-authorized AT APPLY, and the
    // delta reaches the second client.
    await context.setOffline(false)

    await expectConverged(observer, offlineName)
    await expectGone(observer, seed)

    // The author still shows it after the round-trip — the authoritative row
    // replaced the overlay without flickering back to the pre-offline name.
    expect(await sidebarText(page)).toContain(offlineName)

    await shot(observer, '05-offline-observer-converged-after-drain')

    await observer.close()
  })
})
