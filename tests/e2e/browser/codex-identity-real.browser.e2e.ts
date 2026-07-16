import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { harnessEnv } from '../harness-env'
import { newSession, openApp, podium, waitForCodexReady } from './_harness'

const PORT = Number(process.env.PORT ?? 8799)

test.skip(() => process.env.PODIUM_E2E_REAL_AGENTS !== '1', 'real-agent run only')
test.skip(({ isMobile }) => isMobile, 'desktop only')

async function selectIssueLessWorktree(page: Page): Promise<void> {
  await page.keyboard.press('Control+K')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const input = palette.getByRole('combobox')
  await input.fill('e2e-feat')
  const option = palette
    .getByRole('option')
    .filter({ hasText: `zz-podium-e2e-repo-${PORT}` })
    .first()
  await expect(option).toBeVisible({ timeout: 15_000 })
  await option.click()
  await expect(palette).toBeHidden({ timeout: 15_000 })
  await expect(page.locator('button[aria-label="New panel"]:visible').first()).toBeVisible()
}

async function activeSessionId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const panels = [...document.querySelectorAll<HTMLElement>('[data-session]')]
    const active = panels.find(
      (element) => element.offsetParent !== null && element.querySelector('.xterm'),
    )
    return active?.dataset.session ?? ''
  })
}

async function selectSidebarSession(page: Page, sessionId: string): Promise<void> {
  const row = page.locator(`aside [data-session="${sessionId}"]:visible`).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.locator('button').first().click()
  await expect.poll(() => activeSessionId(page), { timeout: 30_000 }).toBe(sessionId)
}

async function typeNativeDraft(page: Page, text: string, visibleKey: string): Promise<void> {
  const input = page.locator('.xterm-helper-textarea:visible').last()
  await input.focus()
  await page.keyboard.type(text, { delay: 3 })
  await expect.poll(() => podium.screen(page)).toContain(visibleKey)
}

async function submitNativeDraft(page: Page): Promise<void> {
  await page.locator('.xterm-helper-textarea:visible').last().focus()
  await page.keyboard.press('Enter')
}

test('real codex: promptless panes keep drafts through restart and bind first messages', async ({
  page,
}) => {
  test.setTimeout(480_000)
  await page.setViewportSize({ width: 1400, height: 900 })
  await openApp(page)
  await selectIssueLessWorktree(page)

  await newSession(page, 'Codex')
  await waitForCodexReady(page)
  const paneA = await activeSessionId(page)
  expect(paneA).not.toBe('')
  // Codex has not created a native thread id yet. The live pane is identified
  // solely by its stable Podium id while this first draft remains unsubmitted.
  const draftAKey = 'Compute seventy-three plus eighteen.'
  const draftA = `${draftAKey} Reply with only the decimal digits, nothing else.`
  await typeNativeDraft(page, draftA, draftAKey)

  await newSession(page, 'Codex')
  await waitForCodexReady(page)
  const paneB = await activeSessionId(page)
  expect(paneB).not.toBe('')
  expect(paneB).not.toBe(paneA)
  const draftBKey = 'Compute sixty-four plus fifty-seven.'
  const draftB = `${draftBKey} Reply with only the decimal digits, nothing else.`
  await typeNativeDraft(page, draftB, draftBKey)

  // Both panes still have no submitted user message. Real sidebar clicks must
  // attach by stable Podium ID to the exact TUI process holding each private draft.
  await selectSidebarSession(page, paneA)
  expect(await podium.screen(page)).toContain(draftAKey)
  expect(await podium.screen(page)).not.toContain(draftBKey)
  await selectSidebarSession(page, paneB)
  expect(await podium.screen(page)).toContain(draftBKey)
  expect(await podium.screen(page)).not.toContain(draftAKey)

  // Replace the daemon without reaping the durable Codex processes. Their launch
  // env retains the instance-scoped socket name; the new daemon binds the same name.
  const { stateDir } = harnessEnv(PORT)
  const pid = Number(readFileSync(join(stateDir, 'harness.pid'), 'utf8'))
  const serialPath = join(stateDir, 'daemon-restart-serial')
  const serialBefore = readFileSync(serialPath, 'utf8')
  process.kill(pid, 'SIGUSR2')
  await expect
    .poll(() => readFileSync(serialPath, 'utf8'), { timeout: 60_000 })
    .not.toBe(serialBefore)

  // Reattachment must preserve both unsent native drafts under the same Podium IDs.
  await selectSidebarSession(page, paneA)
  expect(await podium.screen(page)).toContain(draftAKey)
  await selectSidebarSession(page, paneB)
  expect(await podium.screen(page)).toContain(draftBKey)

  // Submit both first messages back-to-back. Codex creates each native thread id
  // now; the official hook/fallback attaches it to the originating Podium id.
  await selectSidebarSession(page, paneA)
  await submitNativeDraft(page)
  await selectSidebarSession(page, paneB)
  await submitNativeDraft(page)

  await selectSidebarSession(page, paneA)
  await expect
    .poll(() => podium.screen(page), { timeout: 180_000, intervals: [1500] })
    .toContain('91')
  await expect(page.locator('button[title^="Hibernate"]:visible')).toBeEnabled({ timeout: 60_000 })
  const screenA = await podium.screen(page)
  expect(screenA).not.toContain('121')

  await selectSidebarSession(page, paneB)
  await expect
    .poll(() => podium.screen(page), { timeout: 180_000, intervals: [1500] })
    .toContain('121')
  await expect(page.locator('button[title^="Hibernate"]:visible')).toBeEnabled({ timeout: 60_000 })
  const screenB = await podium.screen(page)
  expect(screenB).not.toContain('91')

  // Re-click after both native IDs have settled: the live rows remain independent.
  await selectSidebarSession(page, paneA)
  expect(await podium.screen(page)).toContain('91')
  await selectSidebarSession(page, paneB)
  expect(await podium.screen(page)).toContain('121')
})
