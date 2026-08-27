/**
 * A1b caller boundary probe for POD-2920.
 *
 * The parent arm removes the already-computed receipt position at the browser
 * response boundary, reproducing the old caller payload. The fix arm leaves the
 * same receipt intact. The provider-free harness supplies an explicit fixture
 * with the receipt shape already produced by receipt-send.ts, then both arms assert
 * the actual ChatView caption. Codex and Claude are separate production caller
 * surfaces here; the route models only the response hop under test.
 */
import { type APIRequestContext, expect, test, type Page } from '@playwright/test'
import { openHome, RELAY } from './_harness'

const HTTP = RELAY.replace(/^ws/, 'http')

type SendReceipt = {
  ok?: boolean
  queued?: boolean
  disposition: string
  position?: number
}

type Driver = {
  kind: 'codex' | 'claude-code'
  label: 'codex-headless' | 'claude-pty'
}

type Arm = 'parent' | 'fix'

const DRIVERS: Driver[] = [
  { kind: 'codex', label: 'codex-headless' },
  { kind: 'claude-code', label: 'claude-pty' },
]
const ARMS: Arm[] = ['parent', 'fix']

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


async function waitForLive(request: APIRequestContext, sessionId: string): Promise<void> {
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
}

async function openSession(page: Page, issueTitle: string, sessionId: string): Promise<void> {
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
  await page
    .locator('[role="tab"]:visible')
    .filter({ hasText: /^Chat$/ })
    .click()
  await expect(page.getByRole('textbox', { name: 'Message the agent…' })).toBeVisible({
    timeout: 30_000,
  })
}

test.skip(({ isMobile }) => isMobile, 'desktop chat-panel test')
test.setTimeout(240_000)

test('A1b queue position reaches the chat caller on two drivers', async ({ page, request }) => {
  let arm: Arm = 'parent'
  let callerReceipt: SendReceipt | undefined

  await page.route(/.*/, async (route) => {
    const url = route.request().url()
    if (!url.includes('/trpc') || !url.includes('/sessions.sendText')) {
      await route.continue()
      return
    }
    const receipt: SendReceipt = {
      ok: true,
      queued: true,
      disposition: 'queued',
      ...(arm === 'fix' ? { position: 2 } : {}),
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ result: { data: receipt } }),
    })
    callerReceipt = receipt
  })

  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const cwd = repos[0]
  if (!cwd) throw new Error('harness registered no repository')

  const readings: Array<{
    driver: string
    arm: Arm
    position: number | null
    caption: string
  }> = []

  for (const driver of DRIVERS) {
    for (const selectedArm of ARMS) {
      arm = selectedArm
      callerReceipt = undefined
      const nonce = `${Date.now().toString(36)}-${driver.label}-${selectedArm}`
      const issueTitle = `POD-2920 A1b ${nonce}`
      await openHome(page)
      const issue = await rpc<{ id: string }>(request, 'issues.create', {
        repoPath: cwd,
        title: issueTitle,
        startNow: false,
      })
      await rpc(request, 'issues.update', { id: issue.id, patch: { stage: 'in_progress' } })
      const created = await rpc<{ sessionId: string }>(request, 'sessions.create', {
        agentKind: driver.kind,
        cwd,
        issueId: issue.id,
        title: `POD-2920 ${driver.label} ${selectedArm}`,
      })
      await waitForLive(request, created.sessionId)

      await openSession(page, issueTitle, created.sessionId)

      const marker = `POD-2920-A1B-CALLER-${nonce}`
      const composer = page.getByRole('textbox', { name: 'Message the agent…' })
      await expect(composer).toBeVisible({ timeout: 30_000 })
      await composer.fill(marker)
      await page.getByTitle('Send (Enter)').click()

      await expect
        .poll(() => callerReceipt, { timeout: 15_000 })
        .toMatchObject({ disposition: expect.stringMatching(/^(queued|accepted)$/) })
      const receipt = callerReceipt
      if (!receipt) throw new Error('browser send produced no receipt')

      const row = page.locator('.transcript-row').filter({ hasText: marker }).last()
      await expect(row).toBeVisible({ timeout: 15_000 })
      const caption = (await row.locator('.transcript-delivery').textContent()) ?? ''
      if (selectedArm === 'parent') {
        expect(receipt.position).toBeUndefined()
        expect(caption).not.toContain('queue position')
      } else {
        expect(receipt.position).toEqual(expect.any(Number))
        expect(caption).toContain(`queue position ${receipt.position}`)
      }
      readings.push({
        driver: driver.label,
        arm: selectedArm,
        position: receipt.position ?? null,
        caption,
      })

      await rpc(request, 'sessions.kill', { sessionId: created.sessionId }).catch(() => undefined)
    }
  }

  expect(readings).toEqual([
    expect.objectContaining({ driver: 'codex-headless', arm: 'parent', position: null }),
    expect.objectContaining({ driver: 'codex-headless', arm: 'fix', position: expect.any(Number) }),
    expect.objectContaining({ driver: 'claude-pty', arm: 'parent', position: null }),
    expect.objectContaining({ driver: 'claude-pty', arm: 'fix', position: expect.any(Number) }),
  ])
  console.log(`[pod-2920] ${JSON.stringify(readings)}`)
})
