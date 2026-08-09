import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop Flight Deck')
test.setTimeout(180_000)

const HTTP = RELAY.replace(/^ws/, 'http')
const ARTIFACT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.artifacts/POD-630')

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

async function openShell(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('podium.panelModeDefault', 'native'))
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

async function widthSamples(page: Page, durationMs: number): Promise<number[]> {
  return page.evaluate(
    (duration) =>
      new Promise<number[]>((resolve) => {
        const shell = document.querySelector<HTMLElement>('[data-flight-deck-shell]')
        const samples: number[] = []
        const started = performance.now()
        const sample = (now: number): void => {
          samples.push(Math.round(shell?.getBoundingClientRect().width ?? 0))
          if (now - started >= duration) resolve(samples)
          else requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      }),
    durationMs,
  )
}

test('issue-first hierarchy, distinct live status, and animated open/close controls', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mkdir(ARTIFACT_DIR, { recursive: true })
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos[0]
  if (!repoPath) throw new Error('harness registered no repo')

  const stamp = Date.now().toString(36)
  const root = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    title: `Flight Deck hierarchy ${stamp}`,
    description: 'A mission with enough structure to verify issue grouping.',
    startNow: true,
  })
  const first = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    parentId: root.id,
    title: `Grouped active task ${stamp}`,
    startNow: false,
  })
  await rpc(request, 'issues.update', { id: first.id, patch: { stage: 'in_progress' } })
  const second = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    parentId: root.id,
    title: `Grouped attention task ${stamp}`,
    startNow: false,
  })
  await rpc(request, 'issues.setNeedsHuman', {
    id: second.id,
    question: 'Choose the grouping treatment?',
  })

  await openShell(page)
  const issueRow = page
    .getByTestId('unified-issue-row')
    .filter({ hasText: `Flight Deck hierarchy ${stamp}` })
    .first()
  await expect(issueRow).toBeVisible({ timeout: 30_000 })
  await issueRow.locator('button.flex-1').first().click()

  const deck = page.locator('aside[aria-label="Flight Deck"]')
  await expect(deck).toBeVisible({ timeout: 20_000 })
  await expect(deck.getByText('Flight Deck', { exact: true })).toHaveCount(0)
  await expect(deck.getByRole('heading', { name: `Flight Deck hierarchy ${stamp}` })).toBeVisible()

  const gauge = deck.getByTestId('mission-gauge')
  await expect(gauge).toHaveAttribute('data-running', 'true', { timeout: 20_000 })
  await expect(gauge.locator('.row-progress-sweep')).toBeVisible()
  const track = await gauge.getByTestId('mission-gauge-track').boundingBox()
  const live = await gauge.getByTestId('mission-live-chip').boundingBox()
  expect(track).not.toBeNull()
  expect(live).not.toBeNull()
  if (track && live) expect(live.x).toBeGreaterThan(track.x + track.width + 4)

  const taskGroups = deck.locator('[data-flight-issue]')
  await expect(taskGroups).toHaveCount(2)
  expect(await taskGroups.first().evaluate((el) => getComputedStyle(el).paddingBottom)).toBe('6px')
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'flight-deck-open.png'), fullPage: true })

  const shell = page.locator('[data-flight-deck-shell]')
  const openWidth = (await shell.boundingBox())?.width ?? 0
  await deck.getByRole('button', { name: 'Collapse Flight Deck' }).click()
  const closing = await widthSamples(page, 360)
  await expect(shell).toHaveAttribute('data-flight-deck-shell', 'folded')
  await expect.poll(async () => Math.round((await shell.boundingBox())?.width ?? 0)).toBe(44)
  const reducedMotion = await page.evaluate(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  expect(
    closing.some((width) => width > 48 && width < openWidth - 4),
    `closing widths ${JSON.stringify(closing)} from ${openWidth}; reduced motion=${reducedMotion}`,
  ).toBe(true)

  const activity = page.getByTestId('flight-deck-activity')
  const attention = page.getByTestId('flight-deck-attention')
  await expect(activity).toBeVisible()
  await expect(attention).toBeVisible()
  const activityBox = await activity.boundingBox()
  const attentionBox = await attention.boundingBox()
  expect(activityBox).not.toBeNull()
  expect(attentionBox).not.toBeNull()
  if (activityBox && attentionBox) expect(attentionBox.y).toBeGreaterThan(activityBox.y)
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'flight-deck-folded.png'), fullPage: true })

  await attention.click()
  const opening = await widthSamples(page, 360)
  await expect(shell).toHaveAttribute('data-flight-deck-shell', 'open')
  await expect(deck).toBeVisible()
  expect(opening.some((width) => width > 48 && width < openWidth - 4)).toBe(true)
})
