import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type APIRequestContext, expect, test } from '@playwright/test'
import { harnessEnv } from '../harness-env'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop verification: nested session rows are desktop-only')

const HTTP = RELAY.replace(/^ws/, 'http')
const HOOKS_DIR = join(harnessEnv(Number(process.env.PORT ?? 8799)).stateDir, 'hooks')

async function rpc<T>(
  request: APIRequestContext,
  proc: string,
  input?: unknown,
  method: 'post' | 'get' = 'post',
): Promise<T> {
  const res =
    method === 'get'
      ? await request.get(`${HTTP}/trpc/${proc}`)
      : await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
  if (!res.ok()) throw new Error(`${proc} -> ${res.status()}: ${await res.text()}`)
  const body = (await res.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

async function hookSettingsFiles(): Promise<Set<string>> {
  return new Set(await readdir(HOOKS_DIR).catch(() => []))
}

async function newHookUrl(existing: Set<string>): Promise<string | undefined> {
  const files = await hookSettingsFiles()
  const settingsFile = [...files].find((file) => !existing.has(file))
  if (!settingsFile) return undefined
  const settings = await readFile(join(HOOKS_DIR, settingsFile), 'utf8')
  return settings.match(/"url":\s*"([^"]+\/hooks\/[^"]+)"/)?.[1]
}

test('non-retryable usage errors remain explicit on nested session rows', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 900 })

  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos[0]
  if (!repoPath) throw new Error('harness registered no repo')

  const beforeFirst = await hookSettingsFiles()
  const title = `Usage-limit display ${Date.now()}`
  const issue = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    title,
    startNow: true,
  })
  await expect.poll(() => newHookUrl(beforeFirst)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\//)

  const sessions = await rpc<Array<{ cwd: string; issueId?: string }>>(
    request,
    'sessions.list',
    undefined,
    'get',
  )
  const first = sessions.find((session) => session.issueId === issue.id)
  if (!first) throw new Error('started issue has no attached harness session')

  const beforeSecond = await hookSettingsFiles()
  const second = await rpc<{ sessionId: string }>(request, 'sessions.create', {
    agentKind: 'claude-code',
    cwd: first.cwd,
    issueId: issue.id,
    title: 'POD-966-A facsimile',
  })
  let hookUrl: string | undefined
  await expect
    .poll(async () => {
      hookUrl = await newHookUrl(beforeSecond)
      return hookUrl
    })
    .toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\//)

  const failed = await fetch(hookUrl as string, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'StopFailure', error_type: 'usage_limit' }),
  })
  expect(failed.ok).toBe(true)

  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  const aside = page.locator('aside').first()
  await aside.waitFor({ state: 'visible', timeout: 60_000 })
  const issueRow = aside.getByTestId('unified-issue-row').filter({ hasText: title }).first()
  await expect(issueRow).toBeVisible({ timeout: 30_000 })

  const sessionRow = issueRow.locator(`[data-session="${second.sessionId}"]`)
  await expect(sessionRow).toHaveAttribute('data-session', second.sessionId)
  await expect(sessionRow).toContainText('error: usage_limit')
  await expect(sessionRow.getByRole('button', { name: 'Continue' })).toHaveCount(0)
})
