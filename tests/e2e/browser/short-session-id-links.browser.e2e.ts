/**
 * A SHORT SESSION ID IN A LINK OPENS THE SESSION (POD-4637).
 *
 * `podium session status 214a3887` resolved; the same prefix in a desktop
 * `?pane=` link opened nothing, and on the phone `/mobile/session/214a3887` said
 * "Session not here yet." about a live session. Both now ask the server's
 * `sessions.resolve` — the CLI's rule — and land on the full id, or say why not.
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { type APIRequestContext, expect, test } from '@playwright/test'
import { openHome, RELAY } from './_harness'

const HTTP = RELAY.replace(/^ws/, 'http')
const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-4637')

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

async function liveSession(request: APIRequestContext): Promise<{ sessionId: string; cwd: string }> {
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const cwd = repos[0]
  if (!cwd) throw new Error('harness registered no repository')
  const { sessionId } = await rpc<{ sessionId: string }>(request, 'sessions.create', {
    agentKind: 'claude-code',
    cwd,
    title: `Short id link ${Date.now()}`,
  })
  await expect
    .poll(
      async () =>
        (
          await rpc<Array<{ sessionId: string; status: string }>>(
            request,
            'sessions.list',
            undefined,
            'get',
          )
        ).find((session) => session.sessionId === sessionId)?.status,
      { timeout: 60_000 },
    )
    .toBe('live')
  return { sessionId, cwd }
}

test.setTimeout(150_000)

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop pane link')

  test('a ?pane= link with a short id opens the session', async ({ page, request }) => {
    const { sessionId, cwd } = await liveSession(request)
    const short = sessionId.slice(0, 8)
    await openHome(page)
    await page.goto(`/workspace?wt=${encodeURIComponent(cwd)}&pane=${short}`)
    await expect(page).toHaveURL(new RegExp(`pane=${sessionId}`), { timeout: 30_000 })
    await expect(page.locator(`[data-session="${sessionId}"]:visible`).first()).toBeVisible({
      timeout: 30_000,
    })
    mkdirSync(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: resolve(ARTIFACTS, 'desktop-short-id-opens.png') })
  })

  test('a ?pane= link with an unknown short id says so', async ({ page, request }) => {
    const { cwd } = await liveSession(request)
    await openHome(page)
    await page.goto(`/workspace?wt=${encodeURIComponent(cwd)}&pane=fffffff0`)
    await expect(page.getByText("no session matches 'fffffff0'")).toBeVisible({ timeout: 30_000 })
    mkdirSync(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: resolve(ARTIFACTS, 'desktop-short-id-not-found.png') })
  })
})

test.describe('phone', () => {
  test.skip(
    ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
    'Pixel Chromium proof',
  )

  test('/mobile/session/<short id> opens the live session', async ({ page, request }) => {
    const { sessionId } = await liveSession(request)
    await page.goto(`/mobile?server=${RELAY}`)
    await page.goto(`/mobile/session/${sessionId.slice(0, 8)}`)
    await expect(page).toHaveURL(new RegExp(`/mobile/session/${sessionId}`), { timeout: 30_000 })
    await expect(page.getByText('Session not here yet.')).toHaveCount(0)
    await expect(page.getByLabel('Session actions')).toBeVisible({ timeout: 30_000 })
    mkdirSync(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: resolve(ARTIFACTS, 'phone-short-id-opens.png') })
  })

  test('/mobile/session/<unknown short id> says not found', async ({ page }) => {
    await page.goto(`/mobile?server=${RELAY}`)
    await page.goto('/mobile/session/fffffff0')
    await expect(page.getByText('Session not found.')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Session not here yet.')).toHaveCount(0)
    mkdirSync(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: resolve(ARTIFACTS, 'phone-short-id-not-found.png') })
  })
})
