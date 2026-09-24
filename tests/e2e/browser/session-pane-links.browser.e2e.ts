/**
 * A LINK TO ONE SESSION OPENS THAT SESSION (POD-4642).
 *
 * With session A the active tab, a full page load of `/workspace?wt=…&pane=<B>`
 * kept A in front under B's URL: the pane scalar came from the URL, the tab
 * strip from the restored layout, and the layout never gained B. Anything done
 * to "the open session" then hit A. The link now opens B the way clicking it
 * would, and B is the active tab.
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { type APIRequestContext, expect, test } from '@playwright/test'
import { openHome, RELAY } from './_harness'

const HTTP = RELAY.replace(/^ws/, 'http')
const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/POD-4642')

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

async function liveSession(request: APIRequestContext, cwd: string, title: string): Promise<string> {
  const { sessionId } = await rpc<{ sessionId: string }>(request, 'sessions.create', {
    agentKind: 'claude-code',
    cwd,
    title,
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
  return sessionId
}

test.setTimeout(180_000)

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop pane link')

  test('a pane link loaded over another active session makes the linked one active', async ({
    page,
    request,
  }) => {
    const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
    const cwd = repos[0]
    if (!cwd) throw new Error('harness registered no repository')
    const stamp = Date.now()
    const first = await liveSession(request, cwd, `Pane link first ${stamp}`)
    const linked = await liveSession(request, cwd, `Pane link linked ${stamp}`)
    const wt = encodeURIComponent(cwd)
    const activeTab = page.locator('[data-session].native-tab-active:visible')

    await openHome(page)
    await page.goto(`/workspace?wt=${wt}&pane=${first}`)
    await expect(activeTab).toHaveAttribute('data-session', first, { timeout: 30_000 })

    // The same browser profile, a full load of the other session's link.
    await page.goto(`/workspace?wt=${wt}&pane=${linked}`)
    await expect(activeTab).toHaveAttribute('data-session', linked, { timeout: 30_000 })
    await expect(page).toHaveURL(new RegExp(`pane=${linked}`))
    await expect(page).toHaveURL(new RegExp(`wt=${wt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    mkdirSync(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: resolve(ARTIFACTS, 'desktop-pane-link-opens-linked.png') })
  })
})
