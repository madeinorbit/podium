import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type APIRequestContext, expect, test } from '@playwright/test'
import { harnessEnv } from '../harness-env'
import { newSession, openApp, RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop compact-reference surfaces')

const HTTP = RELAY.replace(/^ws/, 'http')
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '')
const BUCKET = join(
  homedir(),
  '.claude',
  'projects',
  REPO_ROOT.replace(/[^a-zA-Z0-9]/g, '-'),
)
const HOOKS_DIR = join(harnessEnv(Number(process.env.PORT ?? 8799)).stateDir, 'hooks')

async function rpc<T>(request: APIRequestContext, proc: string, input?: unknown): Promise<T> {
  const response = await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
  if (!response.ok()) throw new Error(`${proc} -> ${response.status()}: ${await response.text()}`)
  const body = (await response.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

async function bindTranscript(sessionId: string, transcriptPath: string): Promise<void> {
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
  const response = await fetch(hookUrl, {
    method: 'POST',
    body: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: basename(transcriptPath, '.jsonl'),
      transcript_path: transcriptPath,
      cwd: REPO_ROOT,
    }),
  })
  expect(response.ok).toBe(true)
}

test.afterEach(async () => {
  await rm(BUCKET, { recursive: true, force: true }).catch(() => {})
})

test('Tray and command palette use the live issue-reference glyph', async ({ page, request }) => {
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

test('chat issue references show and live-update their stage glyph', async ({ page, request }) => {
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
        content: [{ type: 'text', text: `${issue.displayRef} is ready for review` }],
      },
    }),
  ]
  await mkdir(BUCKET, { recursive: true })
  await writeFile(transcriptPath, `${transcript.join('\n')}\n`, 'utf8')

  await page.setViewportSize({ width: 1280, height: 900 })
  await openApp(page)
  await newSession(page, 'Claude')
  const sessionId = await page
    .locator('.flex.min-h-0 > div[data-session]:visible')
    .first()
    .getAttribute('data-session')
  if (!sessionId) throw new Error('active harness session missing')
  await bindTranscript(sessionId, transcriptPath)

  await page.getByRole('tab', { name: 'Chat', exact: true }).locator('visible=true').click()
  const chatRef = page
    .locator(`.chat-md:visible a.ref-link--issue[data-ref="${issue.displayRef}"]`)
    .first()
  await expect(chatRef).toHaveAttribute('data-issue-stage', 'review', { timeout: 20_000 })
  await expect
    .poll(() => chatRef.evaluate((element) => getComputedStyle(element, '::before').maskImage))
    .not.toBe('none')

  await rpc(request, 'issues.update', { id: issue.id, patch: { stage: 'done' } })
  await expect(chatRef).toHaveAttribute('data-issue-stage', 'done')
})
