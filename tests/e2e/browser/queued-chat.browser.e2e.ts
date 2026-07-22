/**
 * Busy chat messages are held in the durable message ledger until the agent's
 * next turn boundary. A fresh ChatView must restore that accepted user intent,
 * not rely on the pre-refresh optimistic bubble.
 */
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { makeTrpc } from '../../../apps/web/src/app/trpc'
import { openApp } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop chat-panel test')
test.setTimeout(120_000)

test('queued chat message remains visible after a page reload', async ({ page }) => {
  await openApp(page)
  await page.locator('button[aria-label="New panel"]:visible').first().click()
  const newCodex = page.getByRole('menuitem', { name: 'New Codex' })
  await newCodex.waitFor({ state: 'visible', timeout: 15_000 })
  await newCodex.dispatchEvent('click')
  const chatToggle = page.getByRole('tab', { name: 'Chat', exact: true })
  await chatToggle.waitFor({ state: 'visible', timeout: 60_000 })

  const port = Number(process.env.PORT ?? 8799)
  const trpc = makeTrpc(`http://localhost:${port}`)
  let sessions: Array<{ sessionId: string; createdAt: string }> = []
  await expect
    .poll(async () => {
      sessions = (await trpc.sessions.list.query()) as typeof sessions
      return sessions.length
    })
    .toBeGreaterThan(0)
  const session = [...sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (!session) throw new Error('harness session was not created')

  await chatToggle.click()
  const composer = page.locator('textarea:visible').last()
  await composer.fill('unsent draft keeps queued delivery safe')
  await page.waitForTimeout(500)

  const sent = (await trpc.messages.send.mutate({
    to: session.sessionId,
    body: 'E2E_QUEUED_CHAT survives refresh',
    urgency: 'fyi',
  })) as { disposition: string }
  expect(sent.disposition).toBe('queued')

  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })

  const queued = page.getByTestId('queued-chat-message').filter({
    hasText: 'E2E_QUEUED_CHAT survives refresh',
  })
  await expect(queued).toBeVisible({ timeout: 15_000 })
  await expect(queued).toContainText('queued')
  await expect(page.getByText('1 message queued — delivers when the agent is ready')).toBeVisible()
  await page.screenshot({
    path: fileURLToPath(
      new URL('../../../docs/design/queued-chat-persistence-runtime.png', import.meta.url),
    ),
    fullPage: false,
  })
})
