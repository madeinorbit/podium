import { expect, type Browser, type Page, test } from '@playwright/test'
import { makeTrpc } from '../../../apps/web/src/app/trpc'
import { openHome, podium } from './_harness'

test.skip(() => process.env.PODIUM_E2E_REAL_AGENTS !== '1', 'real Codex only')
test.skip(({ isMobile }) => isMobile, 'desktop recording')
test.use({
  video: { mode: 'on', size: { width: 1280, height: 800 } },
  viewport: { width: 1280, height: 800 },
})

const beat = (page: Page, ms = 1_200): Promise<void> => page.waitForTimeout(ms)
const composer = (page: Page) => page.getByPlaceholder('Message the agent…').locator('visible=true')

async function dismissChrome(page: Page): Promise<void> {
  for (const [dialogName, buttonName] of [
    ['Podium update', 'Hide'],
    ['Find repositories', 'Close'],
  ] as const) {
    const dialog = page.getByRole('dialog', { name: dialogName })
    if (await dialog.isVisible().catch(() => false)) {
      await dialog
        .getByRole('button', { name: buttonName })
        .click()
        .catch(() => {})
    }
  }
}

async function startBusyCodex(page: Page, label: string): Promise<void> {
  await openHome(page)
  await dismissChrome(page)

  const intake = page.getByRole('textbox', { name: 'What do you want to work on?' })
  await expect(intake).toBeVisible({ timeout: 60_000 })
  await intake.fill(`Run the shell command sleep 120 now. Only after it finishes, reply ${label}.`)
  await dismissChrome(page)
  await page.getByRole('button', { name: 'Start work' }).click({ timeout: 30_000 })
  await expect(page.locator('button[aria-label="New panel"]:visible').first()).toBeVisible({
    timeout: 60_000,
  })

  await page.getByTestId('mode-chat').locator('visible=true').click()
  const trpc = makeTrpc(`http://localhost:${Number(process.env.PORT ?? 8799)}`)
  await expect
    .poll(async () => {
      const sessions = (await trpc.sessions.list.query()) as Array<{
        createdAt: string
        agentState?: { phase?: string }
      }>
      return [...sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.agentState
        ?.phase
    }, { timeout: 60_000 })
    .toBe('working')
  await expect(page.getByTestId('composer-stop').locator('visible=true')).toBeVisible({
    timeout: 60_000,
  })
  await beat(page)
}

async function queuePrompt(page: Page, prompt: string, holdAfterSendMs = 0): Promise<void> {
  const input = composer(page)
  await expect(input).toBeVisible({ timeout: 30_000 })
  await input.click()
  await input.pressSequentially(prompt, { delay: 15 })
  await beat(page, 700)
  await input.press('Control+Enter')
  if (holdAfterSendMs > 0) await beat(page, holdAfterSendMs)
}

async function openNativeMirror(
  browser: Browser,
  label: string,
  videoDir: string,
): Promise<{ context: Awaited<ReturnType<Browser['newContext']>>; page: Page }> {
  const context = await browser.newContext({
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()
  await openHome(page)
  await dismissChrome(page)

  const issue = page
    .getByRole('complementary')
    .first()
    .getByRole('button')
    .filter({ hasText: label })
    .first()
  await expect(issue).toBeVisible({ timeout: 60_000 })
  await issue.click()
  const nativeTab = page.getByTestId('mode-native').locator('visible=true')
  await expect(nativeTab).toBeVisible({ timeout: 60_000 })
  await nativeTab.click()
  await page.waitForFunction(
    () => Boolean((window as unknown as { __podium?: unknown }).__podium),
    undefined,
    { timeout: 30_000 },
  )
  await page.locator('.xterm-helper-textarea:visible').last().focus()
  return { context, page }
}

async function proveCancelled(page: Page, prompt: string, forbiddenAnswer: string): Promise<void> {
  const bubble = page.locator('.transcript-pending').filter({ hasText: prompt })
  await expect(bubble.getByText('interrupted', { exact: true })).toBeVisible({ timeout: 30_000 })
  await beat(page, 6_000)
  await expect(bubble.getByText('interrupted', { exact: true })).toBeVisible()
  await expect(page.locator('.chat-md').filter({ hasText: new RegExp(`^${forbiddenAnswer}$`) })).toHaveCount(
    0,
  )
  await beat(page, 1_500)
}

test('video: terminal Escape cancels the queued chat message', async ({ page, browser }, testInfo) => {
  test.setTimeout(300_000)
  const prompt = 'CANCEL VIA TERMINAL: Add 713 and 289. Reply with only the result.'

  await startBusyCodex(page, 'CLI_ESCAPE_SETUP_FINISHED')
  const mirror = await openNativeMirror(
    browser,
    'CLI_ESCAPE_SETUP_FINISHED',
    testInfo.outputPath('terminal-angle'),
  )
  const mirrorVideo = mirror.page.video()
  try {
    await queuePrompt(page, prompt)
    await mirror.page.keyboard.press('Escape')
    await expect.poll(() => podium.screen(mirror.page), { timeout: 30_000 }).toMatch(/interrupted/i)
    await proveCancelled(page, prompt, '1002')
  } finally {
    await mirror.context.close()
    if (mirrorVideo) {
      await testInfo.attach('terminal Escape angle', {
        path: await mirrorVideo.path(),
        contentType: 'video/webm',
      })
    }
  }
})

test('video: chat stop cancels the queued chat message', async ({ page }) => {
  test.setTimeout(300_000)
  const prompt = 'CANCEL VIA CHAT STOP: Add 811 and 193. Reply with only the result.'

  await startBusyCodex(page, 'CHAT_STOP_SETUP_FINISHED')
  await queuePrompt(page, prompt)

  await page.getByTestId('composer-stop').locator('visible=true').click()
  await proveCancelled(page, prompt, '1004')
})
