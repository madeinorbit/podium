import { basename } from 'node:path'
import { type APIRequestContext, expect, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop verification: the sidebar is desktop-only')
test.setTimeout(180_000)

const HTTP = RELAY.replace(/^ws/, 'http')
const PORT = Number(process.env.PORT ?? 8799)

async function rpc<T>(
  request: APIRequestContext,
  proc: string,
  input?: unknown,
  method: 'post' | 'get' = 'post',
): Promise<T> {
  const response =
    method === 'get'
      ? await request.get(
          `${HTTP}/trpc/${proc}${input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`,
        )
      : await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
  if (!response.ok()) throw new Error(`${proc} -> ${response.status()}: ${await response.text()}`)
  const body = (await response.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

test('archiving the selected task leaves the cold deck, not a pane with nothing to attach to', async ({
  page,
  request,
}) => {
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos.find((repo) => basename(repo) === `zz-podium-e2e-repo-${PORT}`) ?? repos[0]
  const issue = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    title: 'Archive probe',
    startNow: true,
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  const row = page.locator('[data-testid="unified-issue-row"]', { hasText: 'Archive probe' })
  await row.first().waitFor({ state: 'visible', timeout: 60_000 })
  await row.first().click()
  await expect(page.getByTestId('native-tab-strip').first()).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: 'test-results/pod1153-before.png' })

  await rpc(request, 'issues.archive', { id: issue.id })

  await expect(page.getByTestId('workspace-cold-deck')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('pane-empty-new-panel')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/pod1153-after.png' })
})
