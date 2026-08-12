/**
 * POD-679 — discovered work leaves the mission it came from.
 *
 * The cross-boundary claim this spec exists for: a `discovered-from` EDGE
 * written on the server changes what the Flight Deck renders on the client. A
 * unit test can assert the derivation and a component test can assert the
 * markup, but only this lane proves the two meet — and the failure it guards
 * against shipped for months precisely because nothing joined them: mission
 * membership followed `startedBySession`, which the server stamps on every
 * agent create, so a spin-off was dragged back onto its origin's spine and the
 * origin could never read as finished.
 *
 * Three facts, one screen:
 *   1. a STARTED spin-off is not a strip on the spine;
 *   2. it is a departure tick under it instead;
 *   3. a spin-off still PROPOSED stays on the spine, and its strip says where
 *      starting it would put it.
 */
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(({ isMobile }) => isMobile, 'desktop Flight Deck')
test.setTimeout(180_000)

const HTTP = RELAY.replace(/^ws/, 'http')
const ARTIFACT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.artifacts/POD-679')

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
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

test('a started spin-off leaves the spine and keeps a way back', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mkdir(ARTIFACT_DIR, { recursive: true })
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos[0]
  if (!repoPath) throw new Error('harness registered no repo')

  const stamp = Date.now().toString(36)
  const root = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    title: `Placement mission ${stamp}`,
    description: 'A mission that discovers work while it runs.',
    startNow: true,
  })
  const onSpine = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    parentId: root.id,
    title: `Sub-task on the spine ${stamp}`,
    startNow: false,
  })
  await rpc(request, 'issues.update', { id: onSpine.id, patch: { stage: 'in_progress' } })

  // Filed by the mission, not yet triaged: this one STAYS, and says what it is.
  const proposal = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    title: `Untriaged spin-off ${stamp}`,
    startNow: false,
  })
  await rpc(request, 'issues.depAdd', {
    fromId: proposal.id,
    toId: root.id,
    type: 'discovered-from',
  })
  await rpc(request, 'issues.update', { id: proposal.id, patch: { stage: 'proposed' } })

  // Already started on its own: this one is GONE from the spine.
  const departed = await rpc<{ id: string }>(request, 'issues.create', {
    repoPath,
    title: `Departed spin-off ${stamp}`,
    startNow: false,
  })
  await rpc(request, 'issues.depAdd', {
    fromId: departed.id,
    toId: root.id,
    type: 'discovered-from',
  })
  await rpc(request, 'issues.update', { id: departed.id, patch: { stage: 'in_progress' } })

  await openShell(page)
  const issueRow = page
    .getByTestId('unified-issue-row')
    .filter({ hasText: `Placement mission ${stamp}` })
    .first()
  await expect(issueRow).toBeVisible({ timeout: 30_000 })
  await issueRow.locator('button.flex-1').first().click()

  const deck = page.locator('aside[aria-label="Flight Deck"]')
  await expect(deck).toBeVisible({ timeout: 20_000 })
  await expect(deck.getByRole('heading', { name: `Placement mission ${stamp}` })).toBeVisible()

  // 1 + 3: the spine carries the sub-task and the untriaged proposal, and NOT
  // the work that has already left.
  const strips = deck.locator('[data-flight-issue]')
  await expect(strips.filter({ hasText: `Sub-task on the spine ${stamp}` })).toHaveCount(1)
  await expect(strips.filter({ hasText: `Untriaged spin-off ${stamp}` })).toHaveCount(1)
  await expect(strips.filter({ hasText: `Departed spin-off ${stamp}` })).toHaveCount(0)

  // 2: it is a tick instead — one line, and a link back to the work.
  const tick = deck.getByTestId('flight-departure')
  await expect(tick).toHaveCount(1)
  await expect(tick).toContainText(`Departed spin-off ${stamp}`)

  // 3: the proposal's strip states the consequence of starting it as it stands.
  const shape = deck.locator('[data-testid="flight-issue-note"][data-note="shape-own"]')
  await expect(shape).toHaveCount(1)
  await expect(shape).toContainText('on its own')
  await expect(shape).toHaveAttribute('title', /can close without it/)

  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'placement-deck.png'), fullPage: true })

  // The tick re-roots the deck onto the departed work rather than doing nothing.
  await tick.click()
  await expect(
    deck.getByRole('heading', { name: `Departed spin-off ${stamp}` }),
  ).toBeVisible({ timeout: 20_000 })
})
