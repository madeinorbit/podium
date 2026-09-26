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
 * phone stack in a real browser: real task + session, real offline queue,
 * real server-side delete, real reconnect, real navigation to Work. It fails
 * while any code re-POSTs the retired entry or leaves the queued banner up.
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
  await page.goto(`/mobile?server=${RELAY}&e2e=1`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toBeVisible({
    timeout: 90_000,
  })
}

test('a send to a deleted session posts once, toasts once, and leaves no queued banner on Work', async ({
  page,
  context,
}) => {
  let resumeAndSendPosts = 0
  await page.route(/\/trpc(?:\/|$)/, async (route) => {
    if (route.request().url().includes('resumeAndSend')) resumeAndSendPosts += 1
    await route.continue()
  })

  await openPhone(page)

  // Real task + session through the phone UI (the expo-mobile-persistence flow).
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.getByRole('button', { name: 'New task' }).click()
  await expect(page.getByLabel(/^Repository /).first()).toBeVisible({ timeout: 30_000 })
  const stamp = Date.now()
  const title = `Dead-message replay ${stamp}`
  const messageText = `dead message ${stamp}`
  await page.getByLabel('Task title').fill(title)
  await page.getByRole('button', { name: 'Agent will start now' }).click()
  await page.getByRole('button', { name: 'Create task' }).click()
  await expect(page.getByRole('button', { name: 'Task title — edit' })).toContainText(title, {
    timeout: 60_000,
  })

  // Into the session conversation.
  const openSession = page.getByRole('button', { name: /^Open / }).first()
  await expect(openSession).toBeVisible({ timeout: 60_000 })
  await openSession.click()
  const composer = page.getByLabel('Message the agent…')
  await expect(composer).toBeVisible({ timeout: 60_000 })
  const sessionId = page.url().match(/\/session\/([^?/]+)/)?.[1]
  expect(sessionId, 'session id in the session route').toBeTruthy()

  // Queue the send offline: durable enqueue, nothing on the wire.
  await context.setOffline(true)
  await composer.fill(messageText)
  await page.getByTestId('composer-bar').getByRole('button', { name: 'Send', exact: true }).click()
  await page.waitForTimeout(1_500)
  expect(resumeAndSendPosts, 'no POST while offline').toBe(0)

  // The desktop deletes the session while the phone is offline
  // ("Delete session…" is sessions.kill under the confirm).
  await rpc(page.request, 'sessions.kill', { sessionId })

  // Reconnect: the queued send drains, the server dead-letters it, the phone
  // says the message was not sent — exactly once on the wire.
  await context.setOffline(false)
  await expect(page.getByText(/Message not sent — the session no longer exists/)).toBeVisible({
    timeout: 60_000,
  })
  await expect.poll(() => resumeAndSendPosts, { timeout: 30_000 }).toBe(1)

  // To Work, then through the retry cadence: no second POST, no queued banner.
  const back = page.getByRole('button', { name: 'Back', exact: true })
  if (await back.isVisible().catch(() => false)) await back.click()
  await page.getByRole('button', { name: 'Work', exact: true }).click({ timeout: 15_000 })
  await expect(page.getByTestId('workspace-continuity-notice')).toHaveCount(0, { timeout: 30_000 })
  await page.waitForTimeout(7_000)
  expect(resumeAndSendPosts, 'no replay after navigating to Work').toBe(1)
  await expect(page.getByText(/queued and will send when connected/)).toHaveCount(0)
})
