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
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { openApp, RELAY } from './_harness'

/**
 * Screenshots land in the REPO, not in test-results/: they are this issue's runtime
 * evidence and are attached to POD-351, so they have to survive the run. A
 * scratchpad or test-results path does not render in the issue sidebar.
 */
const EVIDENCE = join(import.meta.dirname, '../../../docs/evidence/pod-351')
const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: false })

const PHASE3_EVIDENCE = join(import.meta.dirname, '../../../docs/evidence/pod-1283')
const phase3Shot = (page: Page, name: string) =>
  page.screenshot({ path: join(PHASE3_EVIDENCE, `${name}.png`), fullPage: false })
const HTTP = RELAY.replace(/^ws/, 'http')
const OWNER_PASSWORD = process.env.PODIUM_PASSWORD

async function rpc<T>(
  request: APIRequestContext,
  proc: string,
  input?: unknown,
  method: 'post' | 'get' = 'post',
): Promise<T> {
  const response =
    method === 'get'
      ? await request.get(`${HTTP}/trpc/${proc}`)
      : await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
  if (!response.ok()) throw new Error(`${proc} -> ${response.status()}: ${await response.text()}`)
  const body = (await response.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

async function login(
  request: APIRequestContext,
  userId: string,
  password: string,
): Promise<string> {
  const response = await request.post(`${HTTP}/auth/login`, { data: { userId, password } })
  if (!response.ok())
    throw new Error(`login ${userId} -> ${response.status()}: ${await response.text()}`)
  const cookie = response.headers()['set-cookie']?.match(/podium_session=([^;]+)/)?.[1]
  if (!cookie) throw new Error(`login ${userId} returned no podium_session cookie`)
  return cookie
}

test.skip(
  ({ isMobile }) => isMobile,
  'desktop verification: the rename affordance is the sidebar row',
)
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

/** Connect the real app without asking its empty state to spawn an agent. The
 * recovery test creates its controlled target after the feed is attached. */
async function openBareApp(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('podium.panelMode', 'native'))
  const params = new URLSearchParams({ server: RELAY, e2e: '1' })
  await page.goto(`/?${params}`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  await sidebar(page)
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(async () => {
      throw new Error(
        `app shell missing at ${page.url()}: ${await page.locator('body').innerText()}`,
      )
    })
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

/** The same real editor, reached through the work-list row so the recovery
 * journey does not need a live terminal panel. */
async function renameViaSidebar(page: Page, sessionId: string, to: string): Promise<void> {
  const row = sidebar(page).locator(`[data-session="${sessionId}"]`)
  await row.waitFor({ state: 'visible', timeout: 45_000 })
  const editor = row.locator('input[type="text"]').first()
  const primary = row.locator(':scope > button[data-pressable]')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await primary.dblclick()
    const opened = await editor
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
    if (opened) break
    if (attempt === 1) throw new Error(`sidebar rename editor never opened for ${sessionId}`)
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

async function kernelEntityKeys(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const opened = indexedDB.open('podium-kernel-replica')
        opened.onerror = () => reject(opened.error ?? new Error('failed to open kernel replica'))
        opened.onsuccess = () => {
          const db = opened.result
          const tx = db.transaction('entities', 'readonly')
          const rows = tx.objectStore('entities').getAll()
          rows.onerror = () => reject(rows.error ?? new Error('failed to read kernel entities'))
          rows.onsuccess = () => {
            const keys = (
              rows.result as Array<{ principal: string; entity: string; entityId: string }>
            ).map((row) => `${row.principal}:${row.entity}:${row.entityId}`)
            db.close()
            resolve(keys)
          }
        }
      }),
  )
}

async function kernelOutboxStates(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const opened = indexedDB.open('podium-kernel-replica')
        opened.onerror = () => reject(opened.error ?? new Error('failed to open kernel replica'))
        opened.onsuccess = () => {
          const db = opened.result
          const tx = db.transaction('outbox', 'readonly')
          const rows = tx.objectStore('outbox').getAll()
          rows.onerror = () => reject(rows.error ?? new Error('failed to read kernel Outbox'))
          rows.onsuccess = () => {
            const states = (rows.result as Array<{ record?: { state?: string } }>).map(
              (row) => row.record?.state ?? 'unknown',
            )
            db.close()
            resolve(states)
          }
        }
      }),
  )
}

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

test('kernel Outbox dead-letter retry, edit, and discard after a live apply refusal', async ({
  browser,
  context: ownerContext,
}) => {
  test.skip(!OWNER_PASSWORD, 'requires PODIUM_PASSWORD so two production principals can log in')
  if (!OWNER_PASSWORD) return

  const owner = 'user:sole'
  const member = 'user:phase3-member'
  const memberPassword = 'phase3-member-password'
  const ownerToken = await login(ownerContext.request, owner, OWNER_PASSWORD)
  await ownerContext.addCookies([
    {
      name: 'podium_session',
      value: ownerToken,
      url: HTTP,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])

  const account = await ownerContext.request.post(`${HTTP}/auth/users`, {
    data: {
      userId: member,
      displayName: 'Phase 3 Member',
      role: 'member',
      password: memberPassword,
    },
  })
  if (!account.ok()) {
    throw new Error(`create member -> ${account.status()}: ${await account.text()}`)
  }

  const repos = await rpc<string[]>(ownerContext.request, 'repos.list', undefined, 'get')
  const repoPath = repos[0]
  if (!repoPath) throw new Error('harness registered no repo')
  const memberContext = await browser.newContext({ baseURL: HTTP })
  try {
    const memberToken = await login(memberContext.request, member, memberPassword)
    await memberContext.addCookies([
      {
        name: 'podium_session',
        value: memberToken,
        url: HTTP,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ])
    const memberPage = await memberContext.newPage()
    const issue = await rpc<{ id: string }>(ownerContext.request, 'issues.create', {
      repoPath,
      title: `Phase 3 outbox ${Date.now()}`,
      startNow: false,
    })
    const grant = { id: issue.id, grantee: member, verb: 'write' }
    await rpc(ownerContext.request, 'issues.share', grant)
    const machines = await rpc<Array<{ id: string }>>(
      ownerContext.request,
      'machines.list',
      undefined,
      'get',
    )
    const machineId = machines[0]?.id
    if (!machineId) throw new Error('harness registered no machine')
    await rpc(ownerContext.request, 'machines.share', {
      id: machineId,
      grantee: member,
      verb: 'use',
    })
    await expect
      .poll(async () =>
        (await rpc<Array<{ id: string }>>(memberContext.request, 'machines.list', undefined, 'get'))
          .map((machine) => machine.id)
          .includes(machineId),
      )
      .toBe(true)
    await rpc(ownerContext.request, 'issues.start', { id: issue.id, agentKind: 'claude' })
    await rpc(ownerContext.request, 'issues.addSession', { id: issue.id, agentKind: 'claude' })

    let sessionId: string | undefined
    await expect
      .poll(async () => {
        const sessions = await rpc<Array<{ sessionId: string; issueId?: string }>>(
          memberContext.request,
          'sessions.list',
          undefined,
          'get',
        )
        const issueSessions = sessions.filter((session) => session.issueId === issue.id)
        sessionId = issueSessions[0]?.sessionId
        return issueSessions.length >= 2 ? sessionId : undefined
      })
      .not.toBeUndefined()
    if (!sessionId) throw new Error('shared issue agent did not appear for grantee')

    const memberSlice = await rpc<{
      rows: Array<{ entity: string; entityId: string }>
    }>(memberContext.request, 'sync.feedSlice', undefined, 'get')
    expect(memberSlice.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: 'issue', entityId: issue.id }),
        expect.objectContaining({ entity: 'session', entityId: sessionId }),
      ]),
    )

    await openBareApp(memberPage)
    await expect
      .poll(() => memberPage.evaluate(() => globalThis.__podiumReplicaPath))
      .toBe('kernel')
    await expect
      .poll(() => kernelEntityKeys(memberPage), { timeout: 30_000 })
      .toEqual(
        expect.arrayContaining([`${member}:issue:${issue.id}`, `${member}:session:${sessionId}`]),
      )
    await expectConverged(memberPage, 'Phase 3 outbox')
    await memberPage
      .locator('[data-issue-row="' + issue.id + '"]')
      .getByRole('button', { name: /^Expand / })
      .click()
    const chip = memberPage.getByTestId('outbox-recovery-chip')

    const restore = async (): Promise<void> => {
      await rpc(ownerContext.request, 'issues.share', grant)
    }
    const serverName = async (): Promise<string | undefined> => {
      const sessions = await rpc<Array<{ sessionId: string; name?: string }>>(
        ownerContext.request,
        'sessions.list',
        undefined,
        'get',
      )
      return sessions.find((session) => session.sessionId === sessionId)?.name
    }
    const parkRevokedGrant = async (name: string): Promise<void> => {
      const renameTransport = '**/trpc/sessions.rename*'
      await memberPage.route(renameTransport, (route) => route.abort('internetdisconnected'))
      await renameViaSidebar(memberPage, sessionId, name)
      await expect(sidebar(memberPage).locator('[data-session="' + sessionId + '"]')).toContainText(
        name,
      )
      await expect.poll(() => kernelOutboxStates(memberPage)).toContain('queued')
      await rpc(ownerContext.request, 'issues.unshare', grant)
      await memberPage.unroute(renameTransport)
      await memberPage.evaluate(() => window.dispatchEvent(new Event('online')))
      await expect
        .poll(() => kernelOutboxStates(memberPage), { timeout: 60_000 })
        .toContain('dead-letter')
      await expect(chip).toBeVisible({ timeout: 60_000 })
    }

    const retried = `phase3-retry-${Date.now()}`
    await parkRevokedGrant(retried)
    await chip.click()
    await expect(memberPage.getByRole('dialog', { name: 'Changes that need you' })).toBeVisible()
    await phase3Shot(memberPage, '01-live-authorization-dead-letter')
    await restore()
    await memberPage.getByTestId('outbox-retry').click()
    await expect(chip).toBeHidden({ timeout: 30_000 })
    await expect.poll(serverName).toBe(retried)

    const originalEdit = `phase3-edit-original-${Date.now()}`
    const edited = `phase3-edit-recovered-${Date.now()}`
    await parkRevokedGrant(originalEdit)
    await chip.click()
    await expect(memberPage.getByRole('dialog', { name: 'Changes that need you' })).toBeVisible()
    await memberPage.getByRole('button', { name: 'Edit', exact: true }).click()
    await memberPage.getByRole('textbox', { name: 'Your text' }).fill(edited)
    await phase3Shot(memberPage, '02-edit-recovery-before-send')
    await restore()
    await memberPage.getByRole('button', { name: 'Save and send', exact: true }).click()
    await expect(chip).toBeHidden({ timeout: 30_000 })
    await expect.poll(serverName).toBe(edited)

    const discarded = `phase3-discard-${Date.now()}`
    await parkRevokedGrant(discarded)
    await chip.click()
    await phase3Shot(memberPage, '03-discard-recovery-before-cancel')
    await memberPage.getByRole('button', { name: 'Discard', exact: true }).click()
    await expect(chip).toBeHidden({ timeout: 30_000 })
    expect(await serverName()).not.toBe(discarded)
  } finally {
    await memberContext.close()
  }
})
