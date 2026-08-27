/**
 * A1b caller boundary probe for POD-2920.
 *
 * The parent arm removes the already-computed receipt position at the browser
 * response boundary, reproducing the old caller payload. The fix arm leaves the
 * same receipt intact. Both arms then assert the actual ChatView caption for
 * codex and claude sessions; the harness uses its deterministic keyecho child,
 * while the session driver selection remains the production one.
 */
import { type APIRequestContext, expect, test, type Page } from '@playwright/test'
import { openHome, RELAY } from './_harness'

const HTTP = RELAY.replace(/^ws/, 'http')

type RecordValue = Record<string, unknown>
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

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null
}

function responseData(value: unknown): RecordValue | undefined {
  const envelope = Array.isArray(value) ? value[0] : value
  if (!isRecord(envelope) || !isRecord(envelope.result)) return undefined
  return isRecord(envelope.result.data) ? envelope.result.data : undefined
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

  await page.route('**/trpc/sessions.sendText**', async (route) => {
    const response = await route.fetch()
    const payload = (await response.json()) as unknown
    const data = responseData(payload)
    if (data) {
      callerReceipt = { ...data } as SendReceipt
      if (arm === 'parent') delete data.position
    }
    await route.fulfill({ response, body: JSON.stringify(payload) })
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

      await openHome(page)
      await openSession(page, issueTitle, created.sessionId)

      // The durable message path creates the queue entry. The browser send
      // below is the caller under test and must sit behind it.
      const control = `POD-2920-A1B-CONTROL-${nonce}`
      const controlReceipt = await rpc<SendReceipt>(request, 'messages.send', {
        to: created.sessionId,
        body: control,
        urgency: 'fyi',
      })
      expect(controlReceipt.disposition).toBe('queued')

      const marker = `POD-2920-A1B-CALLER-${nonce}`
      const composer = page.getByRole('textbox', { name: 'Message the agent…' })
      await composer.fill(marker)
      await composer.press('Enter')

      await expect
        .poll(() => callerReceipt, { timeout: 15_000 })
        .toMatchObject({ disposition: expect.stringMatching(/^(queued|accepted)$/) })
      const receipt = callerReceipt
      if (!receipt) throw new Error('browser send produced no receipt')

      const row = page.locator('.transcript-row').filter({ hasText: marker }).last()
      await expect(row).toBeVisible({ timeout: 15_000 })
      const caption = (await row.locator('.transcript-delivery').textContent()) ?? ''
      if (selectedArm === 'parent') {
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
    expect.objectContaining({ driver: 'codex-headless', arm: 'parent', position: expect.any(Number) }),
    expect.objectContaining({ driver: 'codex-headless', arm: 'fix', position: expect.any(Number) }),
    expect.objectContaining({ driver: 'claude-pty', arm: 'parent', position: expect.any(Number) }),
    expect.objectContaining({ driver: 'claude-pty', arm: 'fix', position: expect.any(Number) }),
  ])
  console.log(`[pod-2920] ${JSON.stringify(readings)}`)
})
