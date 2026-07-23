import { execFileSync } from 'node:child_process'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { harnessEnv } from '../harness-env'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop verification: the sidebar is desktop-only')
test.setTimeout(120_000)

const HTTP = RELAY.replace(/^ws/, 'http')
const PORT = Number(process.env.PORT ?? 8799)
const HOOKS_DIR = join(harnessEnv(PORT).stateDir, 'hooks')

interface WireIssue {
  id: string
  title: string
  worktreePath?: string | null
  gitState?: { ahead?: number; merged?: boolean }
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

async function hookFiles(): Promise<Set<string>> {
  return new Set(await readdir(HOOKS_DIR).catch(() => []))
}

async function newHookUrl(existing: Set<string>): Promise<string | undefined> {
  const files = await hookFiles()
  for (const file of files) {
    if (existing.has(file)) continue
    const settings = await readFile(join(HOOKS_DIR, file), 'utf8').catch(() => undefined)
    if (!settings) continue
    const url = settings.match(/"url":\s*"([^"]+\/hooks\/[^"]+)"/)?.[1]
    if (url) return url
  }
  return undefined
}

async function openShell(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

test('done branch delta becomes still yellow ready-to-merge attention', async ({
  page,
  request,
}) => {
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos.find((repo) => basename(repo) === `zz-podium-e2e-repo-${PORT}`) ?? repos[0]
  if (!repoPath) throw new Error('harness registered no repo')

  const title = `Awaiting merge ${Date.now()}`
  const beforeHooks = await hookFiles()
  const created = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    title,
    startNow: true,
  })

  let issue: WireIssue | undefined
  let hookUrl: string | undefined
  await expect
    .poll(async () => {
      issue = (await rpc<WireIssue[]>(request, 'issues.list', { repoPath }, 'get')).find(
        (candidate) => candidate.id === created.id,
      )
      hookUrl = await newHookUrl(beforeHooks)
      return Boolean(issue?.worktreePath && hookUrl)
    })
    .toBe(true)

  const cwd = issue?.worktreePath
  if (!cwd || !hookUrl) throw new Error('issue worktree or hook did not materialize')
  const marker = 'pod182-awaiting-merge.txt'
  await fetch(hookUrl, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd }),
  })
  await writeFile(join(cwd, marker), 'review me\n')
  execFileSync('git', ['add', marker], { cwd })
  execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@podium', 'commit', '-q', '-m', title],
    { cwd },
  )
  await fetch(hookUrl, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd }),
  })

  await expect
    .poll(async () => {
      const current = (await rpc<WireIssue[]>(request, 'issues.list', { repoPath }, 'get')).find(
        (candidate) => candidate.id === created.id,
      )
      return current?.gitState
    })
    .toMatchObject({ ahead: 1 })
  await rpc(request, 'issues.update', { id: created.id, patch: { stage: 'done' } })

  await page.setViewportSize({ width: 1280, height: 900 })
  await openShell(page)
  const row = page.getByTestId('unified-issue-row').filter({ hasText: title }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row.locator('[data-issue-row]')).toHaveAttribute('data-phase', 'waiting')
  await expect(row.getByRole('img', { name: '1 waiting on you' })).toBeVisible()
  const chip = row.getByTestId('awaiting-merge-status')
  await expect(chip).toHaveText('ready to merge')
  await expect(chip.locator('svg')).toBeVisible()
  await expect(row.locator('.spb')).toHaveCount(0)
  const paint = await chip.evaluate((element) => {
    const style = getComputedStyle(element)
    return { color: style.color, background: style.backgroundColor, animation: style.animationName }
  })
  expect(paint.color).not.toBe(paint.background)
  expect(paint.animation).toBe('none')

  if (process.env.AWAITING_MERGE_SHOT) {
    await page.locator('aside').first().screenshot({ path: process.env.AWAITING_MERGE_SHOT })
  }
})
