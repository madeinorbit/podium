/**
 * Superagent pane (POD-4732): from-scratch cover against the CURRENT pane.
 *
 * ca0370028 replaced the engraved-column home (super-bar, tray cards) with a
 * dock pane that is only the superagent: the dock-top, one global conversation
 * and its composer. The two suites pinning the old surface were deleted under
 * POD-4701, so nothing at browser level proved the first message fires
 * `superagent.sendTurn` on the global thread. This suite re-covers that, plus
 * what POD-4806 just changed: a turn whose machine is offline is refused by
 * name, and the failed message plus its error survive a reload with a retry.
 *
 * Selectors are discovered from the running pane, not from the deleted tests:
 * - open: the right rail's Superagent cell (role button, accessible name
 *   "Superagent" inside `[data-testid="right-rail"]`);
 * - pane: `[data-testid="superagent-pane"]` (SuperagentView's own section);
 * - composer: `[data-superagent-composer] textarea` + the Send button
 *   `button[title="Send (Enter)"]` (ChatComposer);
 * - conversation rows: the shared `.transcript-row` / `.chat-md` feed;
 * - durable failure: `[data-testid="dead-lettered-chat-message"]` plus the
 *   `button[title="Retry failed message"]` (TranscriptFeed).
 * No new data-testid was added: every assertion rides a role, label, title,
 * placeholder or testid the pane already renders.
 *
 * The harness runs no LLM backend, so the happy path does NOT await a model
 * reply (same stance as the deleted concierge suite): it proves the mutation
 * fired on the global thread with the typed text, the server accepted it, and
 * the optimistic user bubble rendered in the one conversation. The durable
 * `superagent_messages` history stays empty for dispatched turns by design
 * (it is frozen legacy state plus POD-4806 failure rows), so history is only
 * asserted on the offline path, where the failure rows are the product.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { makeTrpc } from '../../../apps/web/src/app/trpc'
import { harnessEnv } from '../harness-env'
import { openHome } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop dock pane only')

function trpc() {
  const port = Number(process.env.PORT ?? 8799)
  return makeTrpc(`http://localhost:${port}`)
}

async function dismissOverlays(page: Page): Promise<void> {
  const update = page.getByRole('dialog', { name: 'Podium update' })
  if (await update.isVisible().catch(() => false)) {
    await update.getByRole('button', { name: 'Hide' }).click()
  }
  const repos = page.getByRole('dialog', { name: 'Find repositories' })
  if (await repos.isVisible().catch(() => false)) {
    await repos.getByRole('button', { name: 'Close' }).click()
  }
}

/** Open the app home, then the Superagent dock pane via its rail cell. The
 *  thread is global, so no workspace entry is needed (and the empty-workspace
 *  entry path is unrelated to this pane). */
async function openSuperagentPane(page: Page): Promise<void> {
  await openHome(page)
  await dismissOverlays(page)
  await ensureSuperagentPaneOpen(page)
}

/** Ensure the pane is open once the app shell is already loaded (e.g. after a
 *  reload, where navigating home again would throw away the restored state). */
async function ensureSuperagentPaneOpen(page: Page): Promise<void> {
  const cell = page.getByTestId('right-rail').getByRole('button', { name: 'Superagent' })
  await expect(cell).toBeVisible({ timeout: 30_000 })
  if ((await cell.getAttribute('aria-pressed')) !== 'true') {
    await cell.click()
  }
  await expect(page.getByTestId('superagent-pane')).toBeVisible({ timeout: 30_000 })
}

function composer(page: Page) {
  return page.locator('[data-superagent-composer] textarea:visible')
}

function sendButton(page: Page) {
  return page.locator('[data-superagent-composer] button[title="Send (Enter)"]:visible')
}

test.describe.configure({ timeout: 180_000 })

test.afterEach(async () => {
  // Safety net: a failing offline test must never leave the daemon parked
  // offline for the next suite on the shared harness. The test's own finally
  // is the primary release; this covers a crash before it runs.
  try {
    const { stateDir } = harnessEnv(Number(process.env.PORT ?? 8799))
    rmSync(join(stateDir, 'daemon-offline-hold'), { force: true })
  } catch {}
})

test('first superagent message fires sendTurn on the global thread and renders in the one conversation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  // Start clean: abandon any in-flight turn and drop prior messages so this
  // send is the thread's first turn on a fresh binding.
  await trpc()
    .superagent.clear.mutate({ threadId: 'global' } as never)
    .catch(() => {})
  await openSuperagentPane(page)

  const pane = page.getByTestId('superagent-pane')
  await expect(pane).toBeVisible()
  // ONE conversation, ONE composer: a second box is the regression POD-782
  // removed, and it would show up here as a second composer mount.
  await expect(page.locator('[data-superagent-composer]:visible')).toHaveCount(1)
  const input = composer(page)
  await expect(input).toBeVisible({ timeout: 30_000 })
  await expect(input).toHaveAttribute('placeholder', 'Ask across all tasks…')

  const marker = `SUPERAGENT_PANE_SEND ${Date.now().toString(36)}`
  const turnCall = page.waitForRequest(
    (req) => req.url().includes('superagent.sendTurn') && req.method() === 'POST',
    { timeout: 30_000 },
  )
  const turnResponse = page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().includes('superagent.sendTurn'),
    { timeout: 30_000 },
  )
  await input.fill(marker)
  await expect(sendButton(page)).toBeEnabled({ timeout: 10_000 })
  await sendButton(page).click()

  // The mutation fired on the global thread carrying the typed text. The
  // tRPC batch encodes input as JSON in the query param or the POST body, so
  // check both the URL and the body rather than assuming one transport shape.
  const req = await turnCall
  const carried = `${req.url()} ${req.postData() ?? ''}`
  expect(carried, 'sendTurn carries the typed text').toContain(marker)
  expect(carried, 'sendTurn targets the global thread').toContain('global')

  // And the server accepted it (dispatched the turn rather than refusing).
  const res = await turnResponse
  expect(res.ok(), 'sendTurn is accepted while the machine is online').toBe(true)

  // The message renders in the one conversation: the optimistic user bubble.
  // The harness has no LLM backend, so (as the old concierge suite did) we do
  // not await a model reply — the accepted mutation plus this bubble is the
  // proof the front door works.
  const bubble = pane.locator('.transcript-row').filter({ hasText: marker }).first()
  await expect(bubble).toBeVisible({ timeout: 30_000 })
  await expect(bubble.locator('.chat-md').first()).toContainText(marker)

  // Leave the lane clean for the next suite on the shared harness.
  await trpc()
    .superagent.clear.mutate({ threadId: 'global' } as never)
    .catch(() => {})
})

test('offline machine refusal names the machine and survives reload with a retry', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await trpc()
    .superagent.clear.mutate({ threadId: 'global' } as never)
    .catch(() => {})
  await openSuperagentPane(page)

  const pane = page.getByTestId('superagent-pane')
  const input = composer(page)
  await expect(input).toBeVisible({ timeout: 30_000 })

  // The machine name the refusal must carry. Read while online: after the
  // daemon drops there is no one to ask.
  const machines = (await trpc()
    .machines.list.query()
    .catch(() => [])) as Array<{
    id: string
    name?: string
    online?: boolean
  }>
  const machineId = machines[0]?.id
  const machineName = machines[0]?.name ?? machineId
  expect(machineId, 'harness registered a machine').toBeTruthy()
  expect(machineName, 'harness machine has a name').toBeTruthy()

  // Deterministic offline (POD-4732 review): the hold file parks the
  // replacement daemon inside restartDaemon, so there is no detach window to
  // race. SIGUSR2 detaches, the poll waits until the server reports the
  // machine offline — the same presence `requireOnlineSession` reads — and
  // only then is the one send clicked. No retry loop.
  const port = Number(process.env.PORT ?? 8799)
  const { stateDir } = harnessEnv(port)
  const pid = Number(readFileSync(join(stateDir, 'harness.pid'), 'utf8'))
  const serialPath = join(stateDir, 'daemon-restart-serial')
  const holdPath = join(stateDir, 'daemon-offline-hold')

  const marker = `SUPERAGENT_PANE_OFFLINE ${Date.now().toString(36)}`
  // Never start held by a stale file from a crashed earlier run: that would
  // park this run's daemon offline before it even detaches.
  rmSync(holdPath, { force: true })
  writeFileSync(holdPath, 'hold')
  const serialBefore = readFileSync(serialPath, 'utf8')
  try {
    process.kill(pid, 'SIGUSR2')
    // The listing's `online` trails the detach by the server's 30s presence
    // grace (machines service), while `requireOnlineSession` reads the live
    // socket via `hasDaemon` — so this poll takes just over 30s by design.
    await expect
      .poll(
        async () => {
          const rows = (await trpc()
            .machines.list.query()
            .catch(() => [])) as Array<{
            id: string
            name?: string
            online?: boolean
          }>
          return rows.find((row) => row.id === machineId)?.online
        },
        { timeout: 90_000 },
      )
      .toBe(false)

    await input.fill(marker)
    await expect(sendButton(page)).toBeEnabled({ timeout: 15_000 })
    await sendButton(page).click()

    const notice = pane.locator('[data-notice="error"]')
    await expect(notice.first()).toBeVisible({ timeout: 15_000 })
    const offlineError = (await notice.first().textContent()) ?? ''
    expect(offlineError).toContain('is offline')
    expect(offlineError).toContain(machineName as string)
    expect(offlineError).not.toContain('SessionBinding')
    // The refused words render as the failed bubble.
    await expect(pane.locator('.transcript-row').filter({ hasText: marker }).first()).toBeVisible({
      timeout: 15_000,
    })

    // The failed message and its error survive a reload with a retry. The
    // live turn-end error is gone after a reload; what renders is the durable
    // pair POD-4806 persists (user row + TURN_FAILED row via
    // latestTurnFailure). The hold stays held throughout: the restore reads
    // server state, which needs no daemon.
    await page.reload()
    await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
      timeout: 45_000,
    })
    await dismissOverlays(page)
    await ensureSuperagentPaneOpen(page)
    const failed = page.getByTestId('dead-lettered-chat-message').filter({ hasText: marker })
    await expect(failed.first()).toBeVisible({ timeout: 30_000 })
    await expect(failed.first()).toContainText('is offline')
    await expect(failed.first()).toContainText(machineName as string)
    await expect(page.locator('text=SessionBinding')).toHaveCount(0)
    await expect(failed.first().getByRole('button', { name: 'Retry failed message' })).toBeVisible({
      timeout: 15_000,
    })

    // The typed read agrees with the screen: the failure is found by column
    // server-side, never by matching prose client-side.
    const failure = (await trpc()
      .superagent.latestTurnFailure.query({ threadId: 'global' } as never)
      .catch(() => null)) as { userText?: string | null; error?: string } | null
    expect(failure?.userText ?? '').toContain(marker)
    expect(failure?.error ?? '').toContain('is offline')
  } finally {
    // Release the replacement daemon, wait for its reattach ack, and leave
    // the lane clean for the next suite on the shared harness.
    rmSync(holdPath, { force: true })
    await expect
      .poll(() => readFileSync(serialPath, 'utf8'), { timeout: 60_000 })
      .not.toBe(serialBefore)
    await trpc()
      .superagent.clear.mutate({ threadId: 'global' } as never)
      .catch(() => {})
  }
})
