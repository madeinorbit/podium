import { expect, type Page, test } from '@playwright/test'
import { newSession, openApp, podium } from './_harness'

/**
 * Real-agent verification — runs ONLY when the harness launches the real claude CLI
 * (PODIUM_E2E_REAL_AGENTS=1; uses your claude account/quota).
 *
 * #1 long-paste-not-submitted: sending a chat message wraps it in a bracketed paste
 * then a CR. The new Claude renderer (2.1.x) swallows a CR fused to the paste-end
 * marker — the message types into the composer but the turn never starts. The fix
 * delays the CR into a separate PTY read (relay.ts sendText / SUBMIT_CR_DELAY_MS).
 * Ground truth is claude's native TUI (podium.screen): the answer only appears if
 * the turn actually ran. Answers are arithmetic absent from the prompt.
 */
test.skip(() => process.env.PODIUM_E2E_REAL_AGENTS !== '1', 'real-agent run only')
test.skip(({ isMobile }) => isMobile, 'desktop only')

async function waitReady(page: Page): Promise<void> {
  await expect
    .poll(async () => podium.screen(page), { timeout: 90_000, intervals: [1000] })
    .toMatch(/auto mode|❯ Try|for shortcuts/i)
}

async function sendChat(page: Page, text: string): Promise<void> {
  const ta = page.getByPlaceholder('Message the agent…')
  await ta.click()
  await ta.fill(text)
  await ta.press('Control+Enter') // chat composer: ⌘/Ctrl+Enter submits
}

/** Wait until `answer` shows in claude's native TUI — i.e. the turn actually ran. */
async function nativeHasAnswer(page: Page, answer: string, timeout: number): Promise<void> {
  await expect
    .poll(async () => podium.screen(page), { timeout, intervals: [1500] })
    .toContain(answer)
}

test('real claude: chat send submits both a short and a long (paste-sized) message', async ({
  page,
}) => {
  test.setTimeout(300_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  await openApp(page)
  await newSession(page, 'Claude')
  await waitReady(page)
  await page.locator('button[aria-label="Chat view"]').click()
  await expect(page.getByPlaceholder('Message the agent…')).toBeVisible({ timeout: 30_000 })

  // A normal chat message submits and claude replies (137+246=383). Before the fix
  // this sat unsubmitted in the composer.
  await sendChat(page, 'Compute 137 + 246 and reply with only the number, nothing else.')
  await nativeHasAnswer(page, '383', 120_000)

  // A LONG message (40 lines — claude shows it as "[Pasted text]") must STILL submit
  // and start a turn (521+138=659, absent from the filler/prompt).
  const filler = Array.from(
    { length: 40 },
    (_, i) => `Context line ${i}: lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
  ).join('\n')
  await sendChat(
    page,
    `${filler}\n\nIgnore the lines above. Compute 521 + 138 and reply with only the number.`,
  )
  await nativeHasAnswer(page, '659', 150_000)
})
