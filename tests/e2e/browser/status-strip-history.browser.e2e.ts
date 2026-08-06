import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { harnessEnv } from '../harness-env'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'the status strip is desktop-only')

const PORT = Number(process.env.PORT ?? 8799)
const HTTP = RELAY.replace(/^ws/, 'http')
const HOOKS_DIR = join(harnessEnv(PORT).stateDir, 'hooks')

interface HistoryResult {
  buckets: Array<{ count: number }>
}

interface SeededIssue {
  id: string
}

interface SeededSession {
  sessionId: string
  issueId?: string
  cwd?: string
}

async function rpc<T>(
  request: APIRequestContext,
  proc: string,
  input?: unknown,
  method: 'post' | 'get' = 'post',
): Promise<T> {
  const response =
    method === 'get'
      ? await request.get(
          `${HTTP}/trpc/${proc}${input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`,
        )
      : await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
  if (!response.ok()) throw new Error(`${proc} -> ${response.status()}: ${await response.text()}`)
  const body = (await response.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

async function hookSettingsFiles(): Promise<Set<string>> {
  return new Set(await readdir(HOOKS_DIR).catch(() => []))
}

async function newHookUrl(existing: Set<string>): Promise<string | undefined> {
  for (const file of await hookSettingsFiles()) {
    if (existing.has(file)) continue
    const settings = await readFile(join(HOOKS_DIR, file), 'utf8').catch(() => undefined)
    const url = settings?.match(/"url":\s*"([^"]+\/hooks\/[^"]+)"/)?.[1]
    if (url) return url
  }
  return undefined
}

async function openShell(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  const repoDialog = page.getByRole('dialog', { name: 'Find repositories' })
  if (await repoDialog.isVisible().catch(() => false)) {
    await repoDialog.getByRole('button', { name: 'Close' }).click()
  }
  await page.getByTestId('status-strip').waitFor({ state: 'visible', timeout: 60_000 })
}

test('shows 12-hour peaks beside the live state without duplicating the idle message', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)

  const strip = page.getByTestId('status-strip')
  const live = strip.getByTestId('status-strip-working')
  const graph = strip.getByTestId('agent-concurrency-history')

  await expect(live).toHaveText('no agents working')
  await expect(strip.getByText('0 agents working', { exact: true })).toHaveCount(0)
  await expect(strip.locator('.status-strip-spinner')).toHaveCount(0)
  await expect(graph).toBeVisible()
  await expect(graph.locator('.status-strip-history-stack')).toHaveCount(24)

  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos.find((repo) => basename(repo) === `zz-podium-e2e-repo-${PORT}`) ?? repos[0]
  if (!repoPath) throw new Error('harness registered no repo')
  const preexistingHooks = await hookSettingsFiles()
  const title = `E2E concurrency history ${Date.now()}`
  const created = await rpc<SeededIssue>(request, 'issues.create', {
    repoPath,
    title,
    startNow: true,
  })

  let hookUrl: string | undefined
  await expect
    .poll(async () => {
      hookUrl = await newHookUrl(preexistingHooks)
      return hookUrl
    })
    .toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\//)
  const row = page.getByTestId('unified-issue-row').filter({ hasText: title }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  let seededSession: SeededSession | undefined
  await expect
    .poll(async () => {
      const sessions = await rpc<SeededSession[]>(request, 'sessions.list', undefined, 'get')
      seededSession = sessions.find((session) => session.issueId === created.id)
      return seededSession?.sessionId
    })
    .toMatch(/^.+$/)
  if (!seededSession?.sessionId || !seededSession.cwd) {
    throw new Error('created issue has no driveable session')
  }
  // The settings file can be written before optimistic spawn reconciliation.
  // Drive the durable session id returned by the authoritative session read.
  hookUrl = (hookUrl as string).replace(/\/hooks\/[^/]+$/, `/hooks/${seededSession.sessionId}`)
  const providerSessionId = `concurrency-${Date.now()}`
  const transcriptPath = join(harnessEnv(PORT).stateDir, `${providerSessionId}.jsonl`)
  await writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: 'user',
      uuid: `${providerSessionId}-user`,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'e2e working' },
    })}\n`,
  )
  const binding = {
    session_id: providerSessionId,
    transcript_path: transcriptPath,
    cwd: seededSession.cwd,
  }
  const started = await fetch(hookUrl, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'SessionStart', ...binding }),
  })
  expect(started.ok).toBe(true)

  const working = await fetch(hookUrl, {
    method: 'POST',
    body: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'e2e working',
      ...binding,
    }),
  })
  expect(working.ok).toBe(true)
  await expect(live).toHaveText('1 agent working', { timeout: 15_000 })
  await expect(strip.locator('.status-strip-spinner')).toBeVisible()
  await expect(graph).toHaveAttribute('aria-label', /1 agent working now\. Peak 1\./)

  await graph.focus()
  await expect(strip.locator('.status-strip-history-tooltip')).toBeVisible()
  await expect(strip.locator('.status-strip-history-reading')).toContainText('1agent at peak')
  if (process.env.PODIUM_CONCURRENCY_SHOT) {
    await page.screenshot({ path: process.env.PODIUM_CONCURRENCY_SHOT, fullPage: true })
  }

  const stopped = await fetch(hookUrl, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'Stop', ...binding }),
  })
  expect(stopped.ok).toBe(true)
  await expect(live).toHaveText('no agents working', { timeout: 15_000 })
  await expect(strip.locator('.status-strip-spinner')).toHaveCount(0)
  await expect(strip.getByText('0 agents working', { exact: true })).toHaveCount(0)

  await expect
    .poll(async () => {
      const history = await rpc<HistoryResult>(
        request,
        'sessions.concurrencyHistory',
        undefined,
        'get',
      )
      return history.buckets.at(-1)?.count ?? 0
    })
    .toBeGreaterThanOrEqual(1)
  await expect(graph.locator('.status-strip-history-pixel').last()).toHaveCSS('height', '1px')
})
