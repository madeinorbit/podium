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
test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium phone proof',
)
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
}) => {
  // Completed drain POSTs only: refused attempts leave no response behind.
  let resumeAndSendPosts = 0
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
  const repos = await rpcGet<string[]>(page.request, 'repos.list')
  const cwd = repos[0]
  if (!cwd) throw new Error('harness registered no repository')
  const issue = await rpc<{ id: string }>(page.request, 'issues.create', {
    repoPath: cwd,
    title: `Dead-message replay ${stamp}`,
    startNow: false,
  })
  await rpc(page.request, 'issues.update', { id: issue.id, patch: { stage: 'in_progress' } })
  const { sessionId } = await rpc<{ sessionId: string }>(page.request, 'sessions.create', {
    agentKind: 'claude-code',
    cwd,
    issueId: issue.id,
    title: `Dead-message replay ${stamp}`,
  })
  await expect
    .poll(
      async () =>
        rpcGet<Array<{ sessionId: string; status: string }>>(page.request, 'sessions.list').then(
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
    if (refuseDrain && route.request().url().includes('resumeAndSend')) await route.abort()
    else await route.continue()
  })

  // Into the session conversation through the phone's own deep link.
  await page.goto(`/mobile/session/${sessionId}?server=${RELAY}&e2e=1`, {
    waitUntil: 'domcontentloaded',
  })
  const composer = page.getByLabel('Message the agent…')
  await expect(composer).toBeVisible({ timeout: 60_000 })

  // The hub's reconnect loop is the outage signal: with health below ok the
  // composer takes the durable outbox route.
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
  await page.waitForTimeout(3_000)
  expect(resumeAndSendPosts, 'no completed POST while cut off').toBe(0)

  // The desktop deletes the session mid-outage.
  await rpc(page.request, 'sessions.kill', { sessionId })

  // Heal both halves: the hub redials, its health edge drains the queue, the
  // server dead-letters the send, the phone says it was not sent — one POST.
  cutSocket = false
  refuseDrain = false
  await expect(page.getByText(/Message not sent — the session no longer exists/)).toBeVisible({
    timeout: 90_000,
  })
  await expect.poll(() => resumeAndSendPosts, { timeout: 30_000 }).toBe(1)

  // To Work the live way — Back out of the session into the tab stack (no
  // page reload, the session screen unmounts like a tab switch), then through
  // the retry cadence: no second POST, no queued banner. The gone-notice
  // banner overlays the header, so dismiss it first as an operator would.
  const dismiss = page.getByLabel('Dismiss error')
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click()
  await page.getByRole('button', { name: 'Back', exact: true }).click({ timeout: 15_000 })
  await expect(page.getByRole('tab', { name: 'Work' })).toBeVisible({ timeout: 30_000 })
  const notice = page.getByTestId('workspace-continuity-notice')
  await notice.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
  console.log('[phone-boot work notice]', JSON.stringify(await notice.allInnerTexts()))
  console.log('[phone-boot work posts]', resumeAndSendPosts)
  await page.waitForTimeout(7_000)
  console.log('[phone-boot work posts after settle]', resumeAndSendPosts)
  console.log('[phone-boot work notice after settle]', JSON.stringify(await notice.allInnerTexts()))
  await expect(page.getByTestId('workspace-continuity-notice')).toHaveCount(0, { timeout: 30_000 })
  await page.waitForTimeout(7_000)
  expect(resumeAndSendPosts, 'no replay after navigating to Work').toBe(1)
  await expect(page.getByText(/queued and will send when connected/)).toHaveCount(0)
})
