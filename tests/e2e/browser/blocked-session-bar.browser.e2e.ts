import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { loginTestClient } from '../../../apps/server/src/test-support/client-auth'
import { harnessEnv } from '../harness-env'
import { podium, RELAY } from './_harness'

/**
 * POD-2414 — THE BLOCKED-SESSION BAR, DRIVEN END TO END.
 *
 * Spec §4's claim is that a blocked session is enumerable and answerable
 * WITHOUT attaching a terminal. Two halves of that claim had never met a
 * browser: a needs-human failure that is not auth-shaped never became an
 * interaction at all, and no shell rendered the aggregate even when it did.
 *
 * This walks the whole path with nothing faked between the ends: a real agent
 * session, its REAL Claude hook endpoint (the same URL the harness writes into
 * the session's settings file, which is how the product learns an agent's
 * state), the real daemon → server → interaction aggregate → durable feed →
 * replica, and the real card in the real chat surface. Then it answers from the
 * card and watches the row leave.
 *
 * `StopFailure` with a non-retryable, non-auth class is the case POD-2414 is
 * about. Before it, this produced a session sitting in `errored` with NOTHING
 * on any surface saying so.
 */

const HTTP = RELAY.replace(/^ws/, 'http')
const HOOKS_DIR = join(harnessEnv(Number(process.env.PORT ?? 8799)).stateDir, 'hooks')

test.skip(({ isMobile }) => isMobile, 'the chat-surface bar is verified on desktop here')

async function rpc<T>(
  request: APIRequestContext,
  proc: string,
  input?: unknown,
  method: 'post' | 'get' = 'post',
): Promise<T> {
  const res =
    method === 'post'
      ? await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
      : await request.get(
          `${HTTP}/trpc/${proc}${input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`,
        )
  if (!res.ok()) throw new Error(`${proc} → ${res.status()}: ${await res.text()}`)
  const body = (await res.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

async function hookSettingsFiles(): Promise<Set<string>> {
  const entries = await readdir(HOOKS_DIR, { withFileTypes: true }).catch(() => [])
  return new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name))
}

/** The hook endpoint the harness wrote for the session it just spawned. */
async function newHookUrl(existing: Set<string>): Promise<string | undefined> {
  const files = await hookSettingsFiles()
  const settingsFile = [...files].find((file) => !existing.has(file))
  if (!settingsFile) return undefined
  const settings = await readFile(join(HOOKS_DIR, settingsFile), 'utf8')
  return settings.match(/"url":\s*"([^"]+\/hooks\/[^"]+)"/)?.[1]
}

async function openChat(page: Page): Promise<void> {
  // Do not pin a presentation in localStorage: the journey will use the visible
  // panel control to enter Chat after opening the session, exactly as a person
  // does from the desktop's default CLI presentation.
  const password = process.env.PODIUM_PASSWORD?.trim()
  if (password) {
    const login = await loginTestClient({ origin: HTTP, password })
    await page.context().addCookies([
      {
        name: login.cookieName,
        value: login.cookieValue,
        url: HTTP,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ])
  }
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
  // The harness box routinely has an edge build available, and the update
  // dialog is modal — it covers the sidebar this spec navigates from. Hide it
  // (never "Update Podium": that would restart the thing under test).
  const update = page.getByRole('dialog', { name: 'Podium update' })
  if (await update.isVisible().catch(() => false)) {
    await update.getByRole('button', { name: 'Hide' }).click()
    await update.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {})
  }
  const repoDialog = page.getByRole('dialog', { name: 'Find repositories' })
  if (await repoDialog.isVisible().catch(() => false)) {
    await repoDialog.getByRole('button', { name: 'Close' }).click()
  }
}

test('a needs-human failure becomes a card in chat, and answering it clears the card', async ({
  page,
  request,
}) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1280, height: 900 })

  // THE HARNESS SCRATCH REPO BY NAME, NEVER `repos[0]`.
  //
  // This is what made the journey unrunnable for two days, and the symptom named
  // nothing: `repos[0]` is whatever repo the box happens to have registered
  // first, which on a developer machine is a deep issue worktree. The harness
  // then creates the spawned session's own worktree INSIDE it, and the abduco
  // control socket for that session — a unix path, capped at 107 bytes by
  // `sun_path` — overflows. The session dies at spawn with
  // `create-session: File name too long`, NO AGENT EVER STARTS, and every later
  // assertion fails on a missing card that was never going to appear. The same
  // limit is why this spec must not run under a long TMPDIR.
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const port = Number(process.env.PORT ?? 8799)
  const repoPath = repos.find((repo) => basename(repo) === `zz-podium-e2e-repo-${port}`)
  if (!repoPath) {
    throw new Error(
      `harness scratch repo zz-podium-e2e-repo-${port} is not registered; saw ${repos.join(', ')}`,
    )
  }
  const stamp = Date.now().toString(36)
  const title = `Blocked session ${stamp}`

  const preexistingHooks = await hookSettingsFiles()
  await rpc(request, 'issues.create', { repoPath, title, startNow: true })
  // The hook URL carries the session id in its path — the same id the aggregate
  // keys its rows on, so the assertions below can scope to THIS session.
  let sessionId = ''
  let hookUrl: string | undefined
  await expect
    .poll(async () => {
      hookUrl = await newHookUrl(preexistingHooks)
      return hookUrl
    })
    .toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\//)
  const exactHookUrl = hookUrl as string
  sessionId = exactHookUrl.split('/hooks/')[1] ?? ''
  expect(sessionId).not.toBe('')

  const session = (
    await rpc<Array<{ sessionId: string; cwd?: string }>>(
      request,
      'sessions.list',
      undefined,
      'get',
    )
  ).find((candidate) => candidate.sessionId === sessionId)
  if (!session?.cwd) throw new Error('spawned session has no driveable cwd')

  // Claude's causal observer accepts a terminal event only inside a real turn:
  // an exact provider binding, a transcript-backed prompt, and the matching
  // UserPromptSubmit must precede StopFailure. A bare StopFailure from idle is an
  // impossible provider sequence and is correctly discarded as a stale replay.
  const providerSessionId = `blocked-${stamp}`
  const transcriptPath = join(
    harnessEnv(Number(process.env.PORT ?? 8799)).stateDir,
    `${providerSessionId}.jsonl`,
  )
  const prompt = 'E2E turn that stops on a needs-human failure'
  await writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: 'user',
      uuid: `${providerSessionId}-prompt`,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: prompt },
    })}\n`,
    'utf8',
  )
  const binding = {
    session_id: providerSessionId,
    transcript_path: transcriptPath,
    cwd: session.cwd,
  }
  const postHook = async (payload: Record<string, unknown>): Promise<void> => {
    const response = await fetch(exactHookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(response.ok).toBe(true)
  }
  await postHook({ hook_event_name: 'SessionStart', ...binding })
  await postHook({ hook_event_name: 'UserPromptSubmit', prompt, ...binding })
  // A REAL SPAWN, so the default 5s poll is not enough — and if the session died
  // at spawn instead of reaching `working`, say so with the reason rather than
  // letting an undefined field read time out anonymously.
  await expect
    .poll(
      async () => {
        const sessions = await rpc<
          Array<{
            sessionId: string
            status?: string
            spawnFailure?: string
            agentState?: { phase: string }
          }>
        >(request, 'sessions.list', undefined, 'get')
        const found = sessions.find((candidate) => candidate.sessionId === sessionId)
        if (found?.spawnFailure) throw new Error(`session never started: ${found.spawnFailure}`)
        return found?.agentState?.phase
      },
      { timeout: 60_000 },
    )
    .toBe('working')

  await openChat(page)
  const row = page
    .locator('aside')
    .first()
    .getByTestId('unified-issue-row')
    .filter({ hasText: title })
    .first()
  await expect(row).toBeVisible({ timeout: 45_000 })
  await row.locator('button.flex-1').first().click()

  // A terminal-capable Claude session opens in CLI on desktop. The interaction
  // bar currently belongs to Chat, so exercise the product's real mode switch
  // before asking the page to observe it. POD-2580 separately owns discoverability
  // while a person remains outside Chat.
  const chat = page.getByRole('tab', { name: 'Chat', exact: true }).locator('visible=true')
  await expect(chat).toBeVisible({ timeout: 45_000 })
  await chat.click()
  await expect(chat).toHaveAttribute('aria-selected', 'true')

  // ---- The failure the product used to swallow. ----
  // Non-retryable and NOT auth-shaped: before POD-2414 the synthesizer's only
  // failure arm was an auth regex, so this produced no interaction at all.
  await postHook({
    hook_event_name: 'StopFailure',
    error_type: 'billing_error',
    ...binding,
  })

  // Split materialization from rendering in the failure report: the row must
  // first exist durably, and then the live Chat replica must surface it.
  await expect
    .poll(async () => {
      const rows = await rpc<Array<{ status: string }>>(
        request,
        'interactions.forSession',
        { sessionId },
        'get',
      )
      return rows[0]?.status
    })
    .toBe('asked')

  const card = page.getByTestId('pending-interaction').first()
  await expect(card).toBeVisible({ timeout: 45_000 })
  await expect(card).toContainText('Session blocked')
  const evidencePath = process.env.PODIUM_BLOCKED_SESSION_SHOT
  if (evidencePath) await card.screenshot({ path: evidencePath })
  // The prompt names the cause rather than proposing a course of action.
  await expect(card).toContainText('billing_error')

  // ONE offered choice, and it is one the answer path can actually perform.
  // `abandon` is deliberately absent: Podium has no verb that dismisses without
  // waking the session it claims to stop.
  await expect(card.getByTestId('pending-interaction-action-full-resume')).toBeVisible()
  await expect(card.getByTestId('pending-interaction-action-abandon')).toHaveCount(0)

  // ---- Answering from the card resolves it, and the answer LANDS. ----
  //
  // THE DISAPPEARANCE IS NOT THE ASSERTION (POD-2414 review, P2/7). The feed
  // carries the open set only, so the card also vanishes when an answer was
  // recorded and never delivered — the precise failure this journey is supposed
  // to catch. So: watch it go, then read the durable row back and require proof
  // of delivery, scoped to THIS session rather than to a global count that any
  // other spec's session could satisfy.
  await card.getByTestId('pending-interaction-action-full-resume').click()
  await expect(page.getByTestId('pending-interaction')).toHaveCount(0, { timeout: 30_000 })

  await expect
    .poll(
      async () =>
        (await rpc<{ sessionId: string }[]>(request, 'interactions.list', undefined, 'get')).filter(
          (row) => row.sessionId === sessionId,
        ).length,
      { timeout: 20_000 },
    )
    .toBe(0)

  const resolved = await rpc<
    { status: string; answeredBy?: string; deliveredVia?: string; answer?: { choice?: string } }[]
  >(request, 'interactions.forSession', { sessionId }, 'get')
  const settled = resolved[0]
  expect(settled?.status).toBe('answered')
  expect(settled?.answeredBy).toBe('human')
  expect(settled?.answer?.choice).toBe('full-resume')
  // `unverified` would mean the aggregate recorded a decision it could not
  // prove reached the agent — a green test over a still-blocked session.
  expect(settled?.deliveredVia).not.toBe('unverified')

  // The smallest real external effect: the exact resume prose reached the
  // far-end process through server -> daemon -> PTY. This deterministic lane
  // launches keyecho, so `transcriptRead` still reads the seeded Claude JSONL
  // above; keyecho's own screen is the honest live-agent boundary.
  const cli = page.getByRole('tab', { name: 'CLI', exact: true }).locator('visible=true')
  await cli.click()
  await expect
    .poll(() => podium.screen(page), { timeout: 30_000 })
    .toContain('Continue where you left off')
})
