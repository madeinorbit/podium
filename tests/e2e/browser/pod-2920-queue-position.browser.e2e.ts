/**
 * A1b caller-boundary evidence for POD-2920.
 *
 * The harness fixture creates two real production sessions and reports them
 * working before this spec sends. This spec does not intercept or manufacture
 * the response: it captures the actual sessions.sendText tRPC response, reloads
 * the ChatView, and waits for the real idle drain to deliver the queued row.
 * Parent and fix are run from separate code pins by the evidence driver.
 */
import { type APIRequestContext, expect, test, type Page } from '@playwright/test'
import { openHome, RELAY } from './_harness'

const HTTP = RELAY.replace(/^ws/, 'http')
const ISSUE_TITLE = 'POD-2920 A1b production queue'

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

type SessionWire = {
  sessionId: string
  status: string
  agentKind: string
  name?: string | null
  title?: string
  agentState?: { phase?: string }
}

type LedgerRow = {
  id: string
  body: string
  status: string
  queuePosition?: number
  injectedAt?: string | null
}

const ARM: Arm =
  process.env.PODIUM_E2E_QUEUE_POSITION_ARM === 'parent' ? 'parent' : 'fix'
const DRIVERS: Driver[] = [
  { kind: 'codex', label: 'codex-headless' },
  { kind: 'claude-code', label: 'claude-pty' },
]

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

async function fixtureSession(
  request: APIRequestContext,
  driver: Driver,
): Promise<SessionWire> {
  let found: SessionWire | undefined
  await expect
    .poll(
      async () => {
        const sessions = await rpc<SessionWire[]>(request, 'sessions.list', undefined, 'get')
        found = sessions.find(
          (session) =>
            session.agentKind === driver.kind &&
            (session.name === `POD-2920 A1b ${driver.label}` ||
              session.title === `POD-2920 A1b ${driver.label}`),
        )
        return found?.sessionId
      },
      { timeout: 60_000 },
    )
    .toBeDefined()
  if (!found) throw new Error(`missing ${driver.label} queue fixture session`)
  return found
}

async function waitForPhase(
  request: APIRequestContext,
  sessionId: string,
  phase: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const sessions = await rpc<SessionWire[]>(request, 'sessions.list', undefined, 'get')
        return sessions.find((session) => session.sessionId === sessionId)?.agentState?.phase
      },
      { timeout: 30_000 },
    )
    .toBe(phase)
}

async function openSession(page: Page, sessionId: string): Promise<void> {
  const updateDialog = page.getByRole('dialog', { name: 'Podium update' })
  await updateDialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  if (await updateDialog.isVisible().catch(() => false)) {
    await updateDialog.getByRole('button', { name: 'Hide' }).click()
  }
  const issueRow = page.getByTestId('unified-issue-row').filter({ hasText: ISSUE_TITLE }).first()
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

async function ledgerRows(
  request: APIRequestContext,
  sessionId: string,
): Promise<LedgerRow[]> {
  return rpc<LedgerRow[]>(request, 'messages.ledger', {
    sessionId,
    limit: 100,
  })
}

async function ledgerRow(
  request: APIRequestContext,
  sessionId: string,
  marker: string,
): Promise<LedgerRow | undefined> {
  return (await ledgerRows(request, sessionId)).find((row) => row.body === marker)
}

async function rowCaption(page: Page, marker: string): Promise<string> {
  const row = page.locator('.transcript-row').filter({ hasText: marker }).last()
  await expect(row).toBeVisible({ timeout: 20_000 })
  const foot = row.locator('.transcript-delivery')
  await expect(foot).toBeVisible({ timeout: 20_000 })
  return (await foot.textContent()) ?? ''
}

async function sendFromCaller(page: Page, marker: string): Promise<SendReceipt> {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/trpc/sessions.sendText'),
    { timeout: 30_000 },
  )
  const composer = page.getByRole('textbox', { name: 'Message the agent…' })
  await composer.fill(marker)
  await page.getByTitle('Send (Enter)').click()
  const response = await responsePromise
  expect(response.ok()).toBe(true)
  const body = (await response.json()) as { result?: { data?: SendReceipt } }
  const receipt = body.result?.data
  if (!receipt) throw new Error('sessions.sendText returned no receipt')
  return receipt
}

async function reloadAndOpen(page: Page, sessionId: string): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  const issueRow = page.getByTestId('unified-issue-row').filter({ hasText: ISSUE_TITLE }).first()
  const stillInWorkspace = await issueRow
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false)
  if (!stillInWorkspace) await openHome(page)
  await openSession(page, sessionId)
}

async function waitForDelivered(
  request: APIRequestContext,
  sessionId: string,
  marker: string,
): Promise<LedgerRow> {
  let delivered: LedgerRow | undefined
  await expect
    .poll(
      async () => {
        delivered = await ledgerRow(request, sessionId, marker)
        return delivered?.status
      },
      { timeout: 120_000, intervals: [250, 500, 1_000, 2_000] },
    )
    .toBe('delivered')
  if (!delivered) throw new Error(`ledger row for ${marker} disappeared before delivery`)
  return delivered
}

test.skip(process.env.PODIUM_E2E_QUEUE_POSITION !== '1', 'requires the POD-2920 production queue fixture')
test.skip(({ isMobile }) => isMobile, 'desktop chat-panel test')
test.setTimeout(360_000)

test('A1b queue position reaches the caller on two real drivers', async ({ page, request }) => {
  const readings: Array<{
    driver: string
    arm: Arm
    receiptPosition: number | null
    reloadPosition: number | null
    beforeReloadCaption: string
    afterReloadCaption: string
    deliveredStatus: string
  }> = []

  for (const driver of DRIVERS) {
    const session = await fixtureSession(request, driver)
    await waitForPhase(request, session.sessionId, 'working')
    await openHome(page)
    await openSession(page, session.sessionId)

    const marker = `POD-2920-A1b-${driver.label}-${Date.now().toString(36)}`
    const receipt = await sendFromCaller(page, marker)
    expect(receipt).toMatchObject({
      ok: true,
      queued: true,
      disposition: 'queued',
    })

    const beforeReloadCaption = await rowCaption(page, marker)
    const queued = await expect
      .poll(
        () => ledgerRow(request, session.sessionId, marker),
        { timeout: 20_000 },
      )
      .not.toBeUndefined()
    void queued
    const beforeReload = await ledgerRow(request, session.sessionId, marker)
    if (!beforeReload) throw new Error('queued send never appeared in the message ledger')

    if (ARM === 'parent') {
      expect(receipt.position).toBeUndefined()
      expect(beforeReload.queuePosition).toBeUndefined()
      expect(beforeReloadCaption).not.toContain('queue position')
    } else {
      expect(receipt.position).toEqual(expect.any(Number))
      expect(beforeReload.queuePosition).toBe(receipt.position)
      expect(beforeReloadCaption).toContain(`queue position ${receipt.position}`)
    }

    await reloadAndOpen(page, session.sessionId)
    const afterReloadCaption = await rowCaption(page, marker)
    const afterReload = await ledgerRow(request, session.sessionId, marker)
    if (!afterReload) throw new Error('queued send disappeared during reload')

    if (ARM === 'parent') {
      expect(afterReload.queuePosition).toBeUndefined()
      expect(afterReloadCaption).not.toContain('queue position')
    } else {
      expect(afterReload.queuePosition).toEqual(receipt.position)
      expect(afterReloadCaption).toContain(`queue position ${receipt.position}`)
    }

    const delivered = await waitForDelivered(request, session.sessionId, marker)
    expect(delivered.status).toBe('delivered')
    readings.push({
      driver: driver.label,
      arm: ARM,
      receiptPosition: receipt.position ?? null,
      reloadPosition: afterReload.queuePosition ?? null,
      beforeReloadCaption,
      afterReloadCaption,
      deliveredStatus: delivered.status,
    })
  }

  expect(readings).toHaveLength(2)
  expect(readings.map((reading) => reading.driver)).toEqual([
    'codex-headless',
    'claude-pty',
  ])
  if (ARM === 'parent') {
    expect(readings.every((reading) => reading.receiptPosition === null)).toBe(true)
    expect(readings.every((reading) => reading.reloadPosition === null)).toBe(true)
  } else {
    expect(readings.every((reading) => typeof reading.receiptPosition === 'number')).toBe(true)
    expect(readings.every((reading) => typeof reading.reloadPosition === 'number')).toBe(true)
  }
  console.log(`[pod-2920] ${JSON.stringify({ arm: ARM, readings })}`)
})
