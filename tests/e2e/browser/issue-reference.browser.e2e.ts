import { type APIRequestContext, expect, test } from '@playwright/test'
import { openApp, RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop compact-reference surfaces')

const HTTP = RELAY.replace(/^ws/, 'http')

async function rpc<T>(request: APIRequestContext, proc: string, input?: unknown): Promise<T> {
  const response = await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
  if (!response.ok()) throw new Error(`${proc} -> ${response.status()}: ${await response.text()}`)
  const body = (await response.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

test('Tray and command palette use the live issue-reference glyph', async ({ page, request }) => {
  const repos = await request.get(`${HTTP}/trpc/repos.list`)
  const repoPath = ((await repos.json()) as { result?: { data?: string[] } }).result?.data?.[0]
  if (!repoPath) throw new Error('harness registered no repo')

  const stamp = Date.now().toString(36)
  const title = `Live reference ${stamp}`
  const issue = await rpc<{ id: string; seq: number; displayRef: string }>(
    request,
    'issues.create',
    { repoPath, title, startNow: false },
  )
  await rpc(request, 'issues.update', { id: issue.id, patch: { stage: 'review' } })

  await page.setViewportSize({ width: 1280, height: 900 })
  await openApp(page)

  const trayCard = page.locator(`[data-testid="tray-card-review"][data-issue-seq="${issue.seq}"]`)
  await expect(trayCard).toBeVisible({ timeout: 20_000 })
  await expect(
    trayCard.getByRole('img', { name: `Review task ${issue.displayRef}: ${title}` }),
  ).toBeVisible()

  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  await palette.getByRole('combobox').fill(title)
  const option = palette.getByRole('option').filter({ hasText: title }).first()
  await expect(option).toBeVisible({ timeout: 15_000 })
  await expect(
    option.getByRole('img', { name: `Review task ${issue.displayRef}: ${title}` }),
  ).toBeVisible()

  if (process.env.ISSUE_REFERENCE_SHOT) {
    await page.screenshot({ path: process.env.ISSUE_REFERENCE_SHOT })
  }

  await option.click()
  await expect(palette).toBeHidden()
  await expect(page.getByTestId('issue-page')).toContainText(title)
})
