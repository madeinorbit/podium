import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type APIRequestContext, expect, test } from '@playwright/test'
import { harnessEnv } from '../harness-env'
import { gotoWorkspace, newSession, openApp, RELAY } from './_harness'

const HTTP = RELAY.replace(/^ws/, 'http')
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '')
const BUCKET = join(homedir(), '.claude', 'projects', REPO_ROOT.replace(/[^a-zA-Z0-9]/g, '-'))
const HOOKS_DIR = join(harnessEnv(Number(process.env.PORT ?? 8799)).stateDir, 'hooks')

test.describe.configure({ timeout: 180_000 })

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

async function bindTranscript(
  sessionId: string,
  transcriptPath: string,
): Promise<{ hookUrl: string; binding: Record<string, string> }> {
  let baseUrl: string | undefined
  await expect
    .poll(async () => {
      for (const file of await readdir(HOOKS_DIR).catch(() => [])) {
        const settings = await readFile(join(HOOKS_DIR, file), 'utf8').catch(() => null)
        baseUrl = settings?.match(/"url":\s*"([^"]+\/hooks\/[^"]+)"/)?.[1]
        if (baseUrl) break
      }
      return baseUrl
    })
    .toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\//)
  const hookUrl = baseUrl?.replace(/\/hooks\/[^/]+$/, `/hooks/${sessionId}`)
  if (!hookUrl) throw new Error('hook endpoint unavailable')
  const binding = {
    session_id: basename(transcriptPath, '.jsonl'),
    transcript_path: transcriptPath,
    cwd: REPO_ROOT,
  }
  const response = await fetch(hookUrl, {
    method: 'POST',
    body: JSON.stringify({
      hook_event_name: 'SessionStart',
      ...binding,
    }),
  })
  expect(response.ok).toBe(true)
  return { hookUrl, binding }
}

/** The daemon publishes harness inventory after server boot. Starting a session
 * before it lands makes sessions.create reject even though keyecho is ready. */
async function waitForClaudeInventory(request: APIRequestContext): Promise<void> {
  await expect
    .poll(
      async () => {
        const machines = await rpc<
          Array<{ inventory?: { agents: Array<{ kind: string; installed: boolean }> } }>
        >(request, 'machines.list', undefined, 'get')
        return machines.some((machine) =>
          machine.inventory?.agents.some(
            (agent) => agent.kind === 'claude-code' && agent.installed,
          ),
        )
      },
      { timeout: 20_000 },
    )
    .toBe(true)
}

test.afterEach(async () => {
  await rm(BUCKET, { recursive: true, force: true }).catch(() => {})
})

test('Tray and command palette use the live issue-reference glyph', async ({
  page,
  request,
  isMobile,
}) => {
  test.skip(isMobile, 'desktop compact-reference surfaces')
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

  const footerReference = page
    .getByTestId('status-strip')
    .getByRole('img', { name: `Review task ${issue.displayRef}: ${title}` })
  await expect(footerReference).toBeVisible()
  if (process.env.FOOTER_REFERENCE_SHOT) {
    await page.screenshot({ path: process.env.FOOTER_REFERENCE_SHOT })
  }
  await rpc(request, 'issues.update', { id: issue.id, patch: { stage: 'done' } })
  await expect(
    page
      .getByTestId('status-strip')
      .getByRole('img', { name: `Done task ${issue.displayRef}: ${title}` }),
  ).toBeVisible()
})

test('chat issue references remain stable across issue updates', async ({
  page,
  request,
  isMobile,
}) => {
  const repos = await request.get(`${HTTP}/trpc/repos.list`)
  const repoPath = ((await repos.json()) as { result?: { data?: string[] } }).result?.data?.[0]
  if (!repoPath) throw new Error('harness registered no repo')

  const stamp = Date.now().toString(36)
  const title = `Chat reference ${stamp}`
  const issue = await rpc<{ id: string; displayRef: string }>(request, 'issues.create', {
    repoPath,
    title,
    startNow: false,
  })
  await rpc(request, 'issues.update', { id: issue.id, patch: { stage: 'review' } })

  const transcriptId = '46946946-9469-4469-8469-469469469469'
  const transcriptPath = join(BUCKET, `${transcriptId}.jsonl`)
  const timestamp = '2026-08-06T12:00:00.000Z'
  const transcript = [
    JSON.stringify({
      type: 'user',
      uuid: 'issue-ref-user',
      timestamp,
      message: { role: 'user', content: `Please inspect ${issue.displayRef}` },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'issue-ref-answer',
      timestamp,
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: `${Array.from({ length: 60 }, (_, index) => `Stable transcript line ${index}`).join('\n\n')}\n\n${issue.displayRef} is ready for review`,
          },
        ],
      },
    }),
  ]
  await mkdir(BUCKET, { recursive: true })
  await writeFile(transcriptPath, `${transcript.join('\n')}\n`, 'utf8')

  await page.setViewportSize({ width: 1280, height: 900 })
  if (isMobile) {
    // The WebKit project carries a phone UA, which normally redirects to the
    // separate Expo app. Keep this web-transcript boundary on the web surface.
    await page.addInitScript(() => localStorage.setItem('podium.panelModeDefault', 'native'))
    await page.goto(`/?server=${RELAY}&e2e=1&desktop=1`)
    await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
      timeout: 45_000,
    })
    await gotoWorkspace(page)
  } else {
    await openApp(page)
  }
  await newSession(page, 'Claude')
  const sessionId = await page
    .locator('div[data-session].absolute:visible')
    .first()
    .getAttribute('data-session')
  if (!sessionId) throw new Error('active harness session missing')
  const hook = await bindTranscript(sessionId, transcriptPath)

  await page.getByRole('tab', { name: 'Chat', exact: true }).locator('visible=true').click()
  const chatRef = page
    .locator(
      `[data-feed-scroller]:visible .transcript-row a.ref-link--issue[data-ref="${issue.displayRef}"]`,
    )
    .last()
  await expect(chatRef).toBeVisible({ timeout: 20_000 })
  await expect(chatRef).toHaveAttribute('data-issue-stage', 'review')
  await expect(chatRef).toHaveAttribute('data-issue-availability', 'present')
  await expect(chatRef).toHaveAttribute('aria-label', `Review task ${issue.displayRef}: ${title}`)
  const original = await chatRef.elementHandle()
  if (!original) throw new Error('chat reference did not mount')
  const originalText = await chatRef.evaluateHandle((element) => element.firstChild)
  const originalRow = await chatRef.evaluateHandle((element) => element.closest('.transcript-row'))
  const scroller = page.locator('[data-feed-scroller]:visible').first()
  const distanceFromBottom = () =>
    scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
  await expect.poll(distanceFromBottom).toBeLessThan(3)

  await chatRef.evaluate((element) => {
    const row = element.closest('.transcript-row')
    if (!row) throw new Error('chat reference row missing')
    ;(window as Window & { __issueRefChildMutations?: number }).__issueRefChildMutations = 0
    new MutationObserver((records) => {
      const childChanges = records.filter((record) => record.type === 'childList').length
      const tracked = window as Window & { __issueRefChildMutations?: number }
      tracked.__issueRefChildMutations = (tracked.__issueRefChildMutations ?? 0) + childChanges
    }).observe(row, { attributes: true, childList: true, subtree: true })
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })

  await rpc(request, 'issues.update', { id: issue.id, patch: { stage: 'done' } })
  await expect(chatRef).toHaveAttribute('data-issue-stage', 'done')
  await expect(chatRef).toHaveAttribute('data-issue-availability', 'present')
  await expect(chatRef).toHaveAttribute('aria-label', `Done task ${issue.displayRef}: ${title}`)
  await expect.poll(distanceFromBottom).toBeLessThan(3)
  expect(await original.evaluate((element) => element.isConnected)).toBe(true)
  expect(await chatRef.evaluate((element, before) => element === before, original)).toBe(true)
  expect(
    await chatRef.evaluate((element, before) => element.firstChild === before, originalText),
  ).toBe(true)
  expect(
    await chatRef.evaluate(
      (element, before) => element.closest('.transcript-row') === before,
      originalRow,
    ),
  ).toBe(true)
  expect(
    await page.evaluate(
      () => (window as Window & { __issueRefChildMutations?: number }).__issueRefChildMutations,
    ),
  ).toBe(0)
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(issue.displayRef)

  // A real upward wheel releases bottom-follow. An issue delta may recolor the
  // selected chip but must not reclaim scroll authority or move the reader.
  const scrollerBox = await scroller.boundingBox()
  if (!scrollerBox) throw new Error('chat scroller has no layout box')
  if (isMobile) {
    // Playwright does not expose wheel input for mobile WebKit. Chromium covers
    // the real input boundary; this branch verifies the same escaped state.
    await scroller.evaluate((element) => {
      element.scrollTop -= 900
      element.dispatchEvent(new Event('scroll'))
    })
  } else {
    await page.mouse.move(scrollerBox.x + scrollerBox.width / 2, scrollerBox.y + 80)
    await page.mouse.wheel(0, -900)
  }
  await expect.poll(distanceFromBottom).toBeGreaterThan(300)
  const escapedTop = await scroller.evaluate((element) => element.scrollTop)
  await rpc(request, 'issues.update', { id: issue.id, patch: { stage: 'planning' } })
  await expect(chatRef).toHaveAttribute('data-issue-stage', 'planning')
  await expect
    .poll(async () =>
      Math.abs((await scroller.evaluate((element) => element.scrollTop)) - escapedTop),
    )
    .toBeLessThan(2)

  const jump = page.getByRole('button', { name: 'Jump to bottom' }).locator('visible=true')
  await expect(jump).toBeVisible()
  await jump.click()
  await expect.poll(distanceFromBottom).toBeLessThan(3)

  // One submit followed by a redundant Enter and an issue update still creates
  // one user row. The liveness leaf cannot perturb optimistic reconciliation.
  const marker = `ISSUE_UPDATE_SEND_${Date.now()}`
  const composer = page.locator('textarea:visible').last()
  await composer.fill(marker)
  await composer.press('Enter')
  await composer.press('Enter')
  await rpc(request, 'issues.update', { id: issue.id, patch: { stage: 'in_progress' } })
  const sentRows = page.locator('.transcript-row').filter({ hasText: marker })
  await expect(sentRows).toHaveCount(1, { timeout: 30_000 })
  await expect.poll(distanceFromBottom, { timeout: 15_000 }).toBeLessThan(3)

  // The working tail remains the same DOM object through another real issue
  // update, so live state and its elapsed-time continuity are independent.
  const working = await fetch(hook.hookUrl, {
    method: 'POST',
    body: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'issue update working continuity',
      ...hook.binding,
    }),
  })
  expect(working.ok).toBe(true)
  const tail = page.locator('[data-testid="feed-tail"][data-tail="working"]:visible').first()
  await expect(tail).toBeVisible({ timeout: 15_000 })
  const originalTail = await tail.elementHandle()
  if (!originalTail) throw new Error('working tail did not mount')
  await rpc(request, 'issues.update', { id: issue.id, patch: { stage: 'review' } })
  await expect(chatRef).toHaveAttribute('data-issue-stage', 'review')
  expect(await tail.evaluate((element, before) => element === before, originalTail)).toBe(true)
  await expect(tail).toHaveAttribute('data-tail', 'working')
  await expect.poll(distanceFromBottom).toBeLessThan(3)

  if (process.env.ISSUE_CHIP_BETA_SHOT) {
    await page.screenshot({ path: process.env.ISSUE_CHIP_BETA_SHOT })
  }

  const stopped = await fetch(hook.hookUrl, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'Stop', ...hook.binding }),
  })
  expect(stopped.ok).toBe(true)

  // A stable issue/session world is already present before ChatView remounts.
  // The decorator must still run once: it cannot rely on a later replica delta
  // to retry after the feed-region host ref attaches.
  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  await gotoWorkspace(page)
  await page.getByRole('tab', { name: 'Chat', exact: true }).locator('visible=true').click()
  const reloadedRef = page
    .locator(
      `[data-feed-scroller]:visible .transcript-row a.ref-link--issue[data-ref="${issue.displayRef}"]`,
    )
    .last()
  await expect(reloadedRef).toHaveAttribute('data-issue-stage', 'review', { timeout: 20_000 })
  await expect(reloadedRef).toHaveAttribute('data-issue-availability', 'present')
})

test('chat proposal reference opens reliable approval and harness controls', async ({
  page,
  request,
  isMobile,
}) => {
  test.skip(isMobile, 'desktop compact-reference surfaces')
  const repos = await request.get(`${HTTP}/trpc/repos.list`)
  const repoPath = ((await repos.json()) as { result?: { data?: string[] } }).result?.data?.[0]
  if (!repoPath) throw new Error('harness registered no repo')

  const stamp = Date.now().toString(36)
  const title = `Popup proposal ${stamp}`
  const issue = await rpc<{ id: string; displayRef: string }>(request, 'issues.create', {
    repoPath,
    title,
    startNow: false,
    defaultAgent: 'claude-code',
  })
  await rpc(request, 'issues.update', { id: issue.id, patch: { stage: 'proposed' } })

  // Plant the ref in an away-summary recap: this was the transcript kind whose
  // chat container omitted the shared ref activation handler.
  const transcriptId = '62662662-6626-4626-8626-626626626626'
  const transcriptPath = join(BUCKET, `${transcriptId}.jsonl`)
  const timestamp = '2026-08-09T12:00:00.000Z'
  const transcript = [
    JSON.stringify({
      type: 'user',
      uuid: 'issue-popup-user',
      timestamp,
      message: { role: 'user', content: 'Review the latest proposal recap.' },
    }),
    JSON.stringify({
      type: 'system',
      subtype: 'away_summary',
      uuid: 'issue-popup-recap',
      timestamp,
      content: `Proposal ${issue.displayRef} needs a decision`,
    }),
  ]
  await mkdir(BUCKET, { recursive: true })
  await writeFile(transcriptPath, `${transcript.join('\n')}\n`, 'utf8')

  await page.setViewportSize({ width: 1280, height: 900 })
  await openApp(page)
  await waitForClaudeInventory(request)
  await newSession(page, 'Claude')
  const sessionId = await page
    .locator('.flex.min-h-0 > div[data-session]:visible')
    .first()
    .getAttribute('data-session')
  if (!sessionId) throw new Error('active harness session missing')
  await bindTranscript(sessionId, transcriptPath)

  await page.getByRole('tab', { name: 'Chat', exact: true }).locator('visible=true').click()
  const recap = page.locator('.transcript-body').filter({ hasText: 'Recap' })
  const chatRef = recap.locator(`a.ref-link[data-ref="${issue.displayRef}"]`)
  await expect(chatRef).toBeVisible({ timeout: 20_000 })
  await chatRef.click()

  const popup = page.getByRole('dialog', { name: `Reference ${issue.displayRef}` })
  await expect(popup).toBeVisible()
  await expect(popup).toContainText(title)
  await expect(popup.getByRole('button', { name: 'Run now' })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Add to backlog' })).toBeVisible()
  await expect(popup.getByText('Copy ref')).toHaveCount(0)

  const harness = popup.getByRole('combobox', { name: 'Planned agent harness' })
  await expect(harness).toContainText('Claude Code')
  await harness.click()
  await page.getByRole('option', { name: 'Codex' }).click()
  await expect(harness).toContainText('Codex')

  if (process.env.ISSUE_POPUP_SHOT) {
    await popup.screenshot({ path: process.env.ISSUE_POPUP_SHOT })
  }

  const backlog = popup.getByRole('button', { name: 'Add to backlog' })
  await backlog.click()
  await expect(chatRef).toHaveAttribute('data-issue-stage', 'backlog')
  await expect(popup.getByRole('button', { name: 'Add to backlog' })).toHaveCount(0)
})
