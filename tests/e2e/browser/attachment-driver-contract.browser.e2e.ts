import { type APIRequestContext, expect, test } from '@playwright/test'
import { openHome, RELAY } from './_harness'

const HTTP = RELAY.replace(/^ws/, 'http')

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

const GROK_ATTACHMENT_REFUSAL = 'Grok ACP reports promptCapabilities.image=false and no file input'

test.setTimeout(120_000)

test('a Grok file attach surfaces its typed unsupported refusal', async ({
  page,
  request,
}, testInfo) => {
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const cwd = repos[0]
  if (!cwd) throw new Error('harness registered no repository')
  const issueTitle = `Attachment refusal evidence ${Date.now()}`
  const issue = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath: cwd,
    title: issueTitle,
    startNow: false,
  })
  await rpc(request, 'issues.update', { id: issue.id, patch: { stage: 'in_progress' } })

  const { sessionId } = await rpc<{ sessionId: string }>(request, 'sessions.create', {
    agentKind: 'grok',
    cwd,
    issueId: issue.id,
    runtimeContract: true,
    title: 'Attachment refusal evidence',
  })

  await expect
    .poll(
      async () => {
        const sessions = await rpc<Array<{ sessionId: string; status: string }>>(
          request,
          'sessions.list',
          undefined,
          'get',
        )
        return sessions.find((session) => session.sessionId === sessionId)?.status
      },
      { timeout: 60_000 },
    )
    .toBe('live')

  await openHome(page)
  const updateDialog = page.getByRole('dialog', { name: 'Podium update' })
  await updateDialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  if (await updateDialog.isVisible().catch(() => false)) {
    await updateDialog.getByRole('button', { name: 'Hide' }).click()
  }
  const issueRow = page.getByTestId('unified-issue-row').filter({ hasText: issueTitle }).first()
  await issueRow.waitFor({ state: 'visible', timeout: 30_000 })
  await issueRow.locator('button.flex-1').first().click()
  await page
    .locator(`[data-session="${sessionId}"]:visible`)
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
  await expect(page.getByRole('textbox', { name: 'Message the agent…' })).toBeVisible({
    timeout: 30_000,
  })

  await page
    .locator('[role="tab"]:visible')
    .filter({ hasText: /^Chat$/ })
    .click()

  await page.locator('input[type=file]').setInputFiles({
    name: 'attachment-evidence.png',
    mimeType: 'image/png',
    buffer: Buffer.from('not actually an image'),
  })

  const refusal = page.getByText(GROK_ATTACHMENT_REFUSAL, { exact: true })
  await expect(refusal).toBeVisible({ timeout: 15_000 })

  const screenshot = await page.screenshot()
  if (process.env.ATTACHMENT_REFUSAL_SHOT) {
    await page.screenshot({ path: process.env.ATTACHMENT_REFUSAL_SHOT })
  }
  await testInfo.attach('grok-typed-attachment-refusal', {
    body: screenshot,
    contentType: 'image/png',
  })
})

test('a supported attachment reaches the agent boundary after staging', async ({
  page,
  request,
}, testInfo) => {
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const cwd = repos[0]
  if (!cwd) throw new Error('harness registered no repository')
  const issueTitle = `Attachment send evidence ${Date.now()}`
  const issue = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath: cwd,
    title: issueTitle,
    startNow: false,
  })
  await rpc(request, 'issues.update', { id: issue.id, patch: { stage: 'in_progress' } })

  const { sessionId } = await rpc<{ sessionId: string }>(request, 'sessions.create', {
    agentKind: 'claude-code',
    cwd,
    issueId: issue.id,
    runtimeContract: true,
    title: 'Attachment send evidence',
  })
  await expect
    .poll(
      async () => {
        const sessions = await rpc<Array<{ sessionId: string; status: string }>>(
          request,
          'sessions.list',
          undefined,
          'get',
        )
        return sessions.find((session) => session.sessionId === sessionId)?.status
      },
      { timeout: 60_000 },
    )
    .toBe('live')

  await openHome(page)
  const updateDialog = page.getByRole('dialog', { name: 'Podium update' })
  await updateDialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  if (await updateDialog.isVisible().catch(() => false)) {
    await updateDialog.getByRole('button', { name: 'Hide' }).click()
  }
  const issueRow = page.getByTestId('unified-issue-row').filter({ hasText: issueTitle }).first()
  await issueRow.waitFor({ state: 'visible', timeout: 30_000 })
  await issueRow.locator('button.flex-1').first().click()
  await page
    .locator(`[data-session="${sessionId}"]:visible`)
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
  await expect(page.getByRole('textbox', { name: 'Message the agent…' })).toBeVisible({
    timeout: 30_000,
  })
  await page
    .locator('[role="tab"]:visible')
    .filter({ hasText: /^Chat$/ })
    .click()

  await page.locator('input[type=file]').setInputFiles({
    name: 'attachment-evidence.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('attachment bytes reached the driver'),
  })
  await expect(page.getByText('attachment-evidence.txt', { exact: true })).toBeVisible({
    timeout: 15_000,
  })
  const marker = `attachment reached agent ${Date.now()}`
  const composer = page.getByRole('textbox', { name: 'Message the agent…' })
  await composer.fill(marker)
  await composer.press('Enter')
  await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('attachment-strip')).toHaveCount(0)

  const screenshot = await page.screenshot()
  if (process.env.ATTACHMENT_SEND_SHOT) {
    await page.screenshot({ path: process.env.ATTACHMENT_SEND_SHOT })
  }
  await testInfo.attach('supported-attachment-sent-from-chat', {
    body: screenshot,
    contentType: 'image/png',
  })

  await page
    .locator('[role="tab"]:visible')
    .filter({ hasText: /^CLI$/ })
    .click()
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const api = (window as unknown as { __podium?: { screenText(): string } }).__podium
          return api?.screenText() ?? ''
        }),
      { timeout: 30_000 },
    )
    .toContain(marker)
  const screen = await page.evaluate(() => {
    const api = (window as unknown as { __podium?: { screenText(): string } }).__podium
    return api?.screenText() ?? ''
  })
  expect(screen).toContain(`/uploads/${sessionId}/`)
  await testInfo.attach('supported-attachment-agent-boundary', {
    body: Buffer.from(screen),
    contentType: 'text/plain',
  })
})
