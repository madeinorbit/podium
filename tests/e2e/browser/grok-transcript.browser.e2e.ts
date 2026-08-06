import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type APIRequestContext, expect, test } from '@playwright/test'
import type { SessionMeta } from '@podium/model'
import { newSession, openApp, openHome, RELAY } from './_harness'

const REPO_ROOT = process.cwd()
const GROK_BUCKET = join(homedir(), '.grok', 'sessions', encodeURIComponent(REPO_ROOT))
const HTTP = RELAY.replace(/^ws/, 'http')
const fixtureDirs = new Set<string>()

async function rpc<T>(request: APIRequestContext, proc: string): Promise<T> {
  const response = await request.get(`${HTTP}/trpc/${proc}`)
  if (!response.ok()) throw new Error(`${proc} -> ${response.status()}: ${await response.text()}`)
  const body = (await response.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

async function seedGrokTranscript(uuid: string): Promise<void> {
  const sessionDir = join(GROK_BUCKET, uuid)
  fixtureDirs.add(sessionDir)
  await mkdir(sessionDir, { recursive: true })
  await Promise.all([
    writeFile(
      join(sessionDir, 'chat_history.jsonl'),
      `${[
        JSON.stringify({
          type: 'user',
          id: 'grok-user-visible',
          content: 'GROK_TRANSCRIPT_PROMPT_ALPHA inspect the binding',
        }),
        JSON.stringify({
          type: 'assistant',
          id: 'grok-assistant-visible',
          content: 'GROK_TRANSCRIPT_ANSWER_BRAVO the resume UUID resolved the JSONL',
        }),
      ].join('\n')}\n`,
      'utf8',
    ),
    writeFile(
      join(sessionDir, 'summary.json'),
      JSON.stringify({
        info: { id: uuid, cwd: REPO_ROOT },
        session_summary: 'Grok transcript fixture',
        num_chat_messages: 2,
      }),
      'utf8',
    ),
    writeFile(join(sessionDir, 'updates.jsonl'), '', 'utf8'),
  ])
}

test.setTimeout(120_000)

test.afterEach(async () => {
  for (const sessionDir of fixtureDirs) {
    await rm(sessionDir, { recursive: true, force: true }).catch(() => {})
  }
  fixtureDirs.clear()
})

test('a fresh Grok spawn renders its transcript from the resume UUID', async ({
  page,
  request,
  isMobile,
}) => {
  let activeId: string | null
  if (isMobile) {
    await openHome(page)
    await page.getByRole('button', { name: 'Work', exact: true }).last().click()
    await page.getByRole('button', { name: 'New work', exact: true }).click()
    await page.getByRole('button', { name: 'Grok', exact: true }).click()
    await page.getByRole('dialog').getByRole('button').first().click()
    await expect(page).toHaveURL(/\/mobile\/session\//, { timeout: 15_000 })
    activeId = new URL(page.url()).pathname.split('/').pop() ?? null
  } else {
    await openApp(page)
    await newSession(page, 'Grok')
    activeId = await page
      .locator('.flex.min-h-0 > div[data-session]:visible')
      .first()
      .getAttribute('data-session')
  }
  expect(activeId).not.toBeNull()

  let session: SessionMeta | undefined
  await expect
    .poll(
      async () => {
        session = (await rpc<SessionMeta[]>(request, 'sessions.list')).find(
          (candidate) => candidate.sessionId === activeId,
        )
        return session?.resume
      },
      { timeout: 20_000 },
    )
    .toMatchObject({ kind: 'grok-session', value: expect.any(String) })
  expect(session?.origin.kind).toBe('spawn')
  expect(session?.resume?.value).toBeTruthy()
  await seedGrokTranscript(session?.resume?.value as string)

  if (isMobile) await page.getByRole('button', { name: 'Chat view' }).click()
  else
    await page
      .locator('[role="tab"]:visible')
      .filter({ hasText: /^Chat$/ })
      .click()

  await expect(page.getByText('GROK_TRANSCRIPT_PROMPT_ALPHA inspect the binding')).toBeVisible({
    timeout: 15_000,
  })
  await expect(
    page.getByText('GROK_TRANSCRIPT_ANSWER_BRAVO the resume UUID resolved the JSONL'),
  ).toBeVisible()
  await expect(
    page.getByText('No transcript yet', { exact: false }).and(page.locator(':visible')),
  ).toHaveCount(0)
})
