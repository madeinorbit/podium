import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loginTestClient } from '../../../apps/server/src/test-support/client-auth'
import { RELAY } from './_harness'

/**
 * Phone dead-message replay (this issue, third attempt).
 *
 * Live symptom (POD-4604 run 13b): the phone queues a send offline, the
 * session is deleted, the phone reconnects and shows "Message not sent — the
 * session no longer exists" once — then `sessions.resumeAndSend` POSTs the
 * SAME dead message twice more (3 dead_letter replies total) and /mobile/work
 * shows "1 change is queued and will send when connected".
 *
 * The two unit-tested fixes (the outbox terminal retire; the verdict-commit
 * retry) both pass without modelling this path, so this spec drives the real
 * phone stack in a real browser: a real session, a real queued send, a real
 * server-side delete ("Delete session…" is sessions.kill under the confirm),
 * a real hub reconnect, then real navigation to Work. It fails while any code
 * re-POSTs the retired entry or leaves the queued banner up.
 *
 * Offline is staged the way the phone actually reads it: the live socket is
 * cut (hub health drops, the composer takes the durable outbox route) and the
 * drain POST is refused (the kernel parks the entry as unreachable), while
 * plain HTTP keeps working so the desktop-side delete can land mid-outage.
 */
test.skip(({ isMobile }) => !isMobile, 'phone proof (chromium-pixel and webkit-iphone)')
test.setTimeout(240_000)

const HTTP = RELAY.replace(/^ws/, 'http')

async function rpc<T>(request: APIRequestContext, proc: string, input?: unknown): Promise<T> {
  const response = await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
  if (!response.ok()) throw new Error(`${proc} -> ${response.status()}: ${await response.text()}`)
  const body = (await response.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

async function rpcGet<T>(request: APIRequestContext, proc: string): Promise<T> {
  const response = await request.get(`${HTTP}/trpc/${proc}`)
  if (!response.ok()) throw new Error(`${proc} -> ${response.status()}: ${await response.text()}`)
  const body = (await response.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

async function openPhone(page: Page): Promise<void> {
  const password = process.env.PODIUM_PASSWORD?.trim()
  if (password) {
    const login = await loginTestClient({ origin: HTTP, password })
    await page.context().addCookies([
      {
        name: login.cookieName,
        value: login.cookieValue,
        url: HTTP,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ])
  }
  page.on('pageerror', (error) => console.log('[phone-boot pageerror]', String(error).slice(0, 300)))
  await page.goto(`/mobile?server=${RELAY}&e2e=1`, { waitUntil: 'domcontentloaded' })
  // The readiness gate parks on a transient probe failure (10s probe timeout
  // against a cold harness) with a manual Retry only — drive it.
  const tabs = page.getByRole('tab', { name: 'Tasks' })
  await expect
    .poll(
      async () => {
        if (await tabs.isVisible().catch(() => false)) return true
        const retry = page.getByRole('button', { name: 'Retry' })
        if (await retry.isVisible().catch(() => false)) await retry.click()
        return false
      },
      { timeout: 120_000 },
    )
    .toBe(true)
}

test('a send to a deleted session posts once, toasts once, and leaves no queued banner on Work', async ({
  page,
  context,
  request,
}) => {
  // Completed drain POSTs and every attempt: a reload that races the retire
  // commit re-sends before any reply completes.
  let resumeAndSendPosts = 0
  let resumeAndSendRequests = 0
  page.on('response', (response) => {
    if (response.url().includes('resumeAndSend') && response.status() === 200) {
      resumeAndSendPosts += 1
    }
  })

  await openPhone(page)

  // A real session through the same procedures the UI uses: a repo, a task,
  // and a chat-capable (keyecho-backed) session on it.
  const stamp = Date.now()
  const messageText = `dead message ${stamp}`
  const repos = await rpcGet<string[]>(request, 'repos.list')
  const cwd = repos[0]
  if (!cwd) throw new Error('harness registered no repository')
  const issue = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath: cwd,
    title: `Dead-message replay ${stamp}`,
    startNow: false,
  })
  await rpc(request, 'issues.update', { id: issue.id, patch: { stage: 'in_progress' } })
  // A busy world, like the live sandbox: seed tasks the phone syncs while
  // online, then churn them DURING the hold so the reconnect delivers a real
  // catch-up burst behind which the verdict commit must queue.
  const seedIds: string[] = []
  for (let i = 0; i < 500; i++) {
    const seeded = await rpc<{ id: string }>(request, 'issues.create', {
      repoPath: cwd,
      title: `Replay-world filler ${stamp}-${i}`,
      startNow: false,
    })
    seedIds.push(seeded.id)
  }
  const { sessionId } = await rpc<{ sessionId: string }>(request, 'sessions.create', {
    agentKind: 'claude-code',
    cwd,
    issueId: issue.id,
    title: `Dead-message replay ${stamp}`,
  })
  await expect
    .poll(
      async () =>
        rpcGet<Array<{ sessionId: string; status: string }>>(request, 'sessions.list').then(
          (sessions) => sessions.find((session) => session.sessionId === sessionId)?.status,
        ),
      { timeout: 90_000 },
    )
    .toMatch(/^(starting|live)$/)

  // Cut the live socket and refuse the drain POST BEFORE the session page
  // loads (a socket route only meets new connections): the composer queues
  // durably and the entry waits, exactly as on a dead connection. Flag-driven
  // handlers, so healing is a flip rather than an unroute the live hub may
  // never notice.
  let cutSocket = true
  let refuseDrain = true
  await page.routeWebSocket(/\/client(?:\?|$)/, (websocket) => {
    if (cutSocket) void websocket.close({ code: 1001, reason: 'dead-message replay outage' })
    else websocket.connectToServer()
  })
  await page.route(/\/trpc(?:\/|$)/, async (route) => {
    if (route.request().url().includes('resumeAndSend')) {
      if (refuseDrain) await route.abort()
      else {
        resumeAndSendRequests += 1
        await route.continue()
      }
    } else await route.continue()
  })

  // Into the session conversation through the phone's own deep link.
  await page.goto(`/mobile/session/${sessionId}?server=${RELAY}&e2e=1`, {
    waitUntil: 'domcontentloaded',
  })
  const composer = page.getByLabel('Message the agent…')
  await expect(composer).toBeVisible({ timeout: 60_000 })

  // The hub's reconnect loop is the outage signal: with health below ok the
  // composer takes the durable outbox route. Full offline too (like the live
  // run): navigator.onLine false, so the queued entry is never attempted —
  // no backoff armed — until the reconnect edge drains it.
  await context.setOffline(true)
  try {
    await expect(page.getByText('Reconnecting').first()).toBeVisible({ timeout: 30_000 })
  } catch {
    const text = await page.locator('body').innerText().catch((error: unknown) => String(error))
    console.log('[phone-boot outage text]', JSON.stringify(text.slice(0, 1500)))
    throw new Error('hub never noticed the socket cut (dump above)')
  }
  await composer.fill(messageText)
  await page.getByTestId('composer-bar').getByRole('button', { name: 'Send', exact: true }).click()
  // The optimistic pending row proves the tap entered the send path.
  await expect(page.getByText(messageText).first()).toBeVisible({ timeout: 15_000 })
  // Churn the seeded world mid-outage so the reconnect delivers a catch-up
  // burst, then delete the session — all while the phone sees nothing.
  for (const id of seedIds) {
    await rpc(request, 'issues.update', { id, patch: { stage: 'in_progress' } })
  }
  await rpc(request, 'sessions.kill', { sessionId })
  expect(resumeAndSendPosts, 'no completed POST while cut off').toBe(0)
  expect(resumeAndSendRequests, 'no attempted POST while cut off').toBe(0)

  // Heal: the hub redials, its health edge drains the queue behind the
  // catch-up burst, the server dead-letters the send. Then reload the live
  // way — a full load of /mobile/work the moment the notice proves the reply
  // landed, racing the retire commit exactly as the tester's immediate goto
  // does, then once more like its goto to the other session.
  await context.setOffline(false)
  cutSocket = false
  refuseDrain = false
  await expect
    .poll(() => page.getByText(/Message not sent — the session no longer exists/).count(), {
      timeout: 90_000,
    })
    .toBeGreaterThan(0)
  console.log('[phone-boot requests at notice]', resumeAndSendRequests)
  await page.goto(`/mobile/work?server=${RELAY}&e2e=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(12_000)
  console.log('[phone-boot requests after race 1]', resumeAndSendRequests)
  await page.goto(`/mobile/session/${sessionId}?server=${RELAY}&e2e=1`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForTimeout(12_000)
  console.log('[phone-boot requests after race 2]', resumeAndSendRequests)
  // Let every verdict land, then read the final state.
  await page.waitForTimeout(15_000)
  console.log('[phone-boot final requests]', resumeAndSendRequests)
  console.log('[phone-boot final posts]', resumeAndSendPosts)
  const notice = page.getByTestId('workspace-continuity-notice')
  console.log('[phone-boot final notice]', JSON.stringify(await notice.allInnerTexts()))
  expect(resumeAndSendRequests, 'no replay after navigating to Work').toBe(1)
  await expect(page.getByText(/queued and will send when connected/)).toHaveCount(0)
})
