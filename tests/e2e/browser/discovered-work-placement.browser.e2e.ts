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
 * A started spin-off is a departure, while a proposed spin-off has one final
 * proposal row. The same isolated flow checks nested dependency navigation and
 * reload restoration at the browser history boundary.
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
      ? await request.get(`${HTTP}/trpc/${proc}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`)
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
  await rpc(request, 'issues.depAdd', {
    fromId: onSpine.id,
    toId: departed.id,
    type: 'blocks',
  })

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

  const accepted = deck.getByTestId('flight-deck-rows').locator('[data-flight-issue]')
  await expect(accepted.filter({ hasText: `Sub-task on the spine ${stamp}` })).toHaveCount(1)
  await expect(accepted.filter({ hasText: `Untriaged spin-off ${stamp}` })).toHaveCount(0)
  await expect(accepted.filter({ hasText: `Departed spin-off ${stamp}` })).toHaveCount(0)
  const proposals = deck.getByTestId('flight-proposed')
  await expect(proposals).toHaveCount(1)
  await expect(proposals.locator('[data-flight-issue]')).toHaveCount(1)
  await expect(proposals).toContainText(`Untriaged spin-off ${stamp}`)

  // 2: it is a tick instead — one line, and a link back to the work.
  const tick = deck.getByTestId('flight-departure')
  await expect(tick).toHaveCount(1)
  await expect(tick).toContainText(`Departed spin-off ${stamp}`)

  await expect(deck.getByTestId('flight-coordinator')).toBeVisible()
  const markerBeforeReload = await page.evaluate(() => window.history.state?.podiumWorkspaceMirror)
  expect(markerBeforeReload).toMatchObject({ key: `mission:${root.id}` })
  await page.reload()
  await expect(deck.getByRole('heading', { name: `Placement mission ${stamp}` })).toBeVisible({ timeout: 30_000 })
  expect(await page.evaluate(() => window.history.state?.podiumWorkspaceMirror)).toEqual(markerBeforeReload)

  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'placement-deck.png'), fullPage: true })

  // The dependency link is nested in the accepted task row. Its own dispatch
  // re-roots the deck onto the target rather than opening the row's agent.
  await deck.getByRole('button', { name: 'Dependencies' }).click()
  await expect(deck.getByTestId('flight-dependencies')).toBeVisible()
  await deck.locator(`[data-flight-issue="${onSpine.id}"]`).getByRole('button', { name: new RegExp(`Departed spin-off ${stamp}`) }).click()
  await expect(
    deck.getByRole('heading', { name: `Departed spin-off ${stamp}` }),
  ).toBeVisible({ timeout: 20_000 })
})

/** The setup is deliberately a principal-local v1 workspace blob. It gives the
 * real client a nested layout which the ordinary UI can then edit and persist.
 * Native worker data comes from the opt-in harness daemon frame, never from a
 * fabricated browser entity. */
test('nested mission workspace keeps its exact setup across entry and URL boundaries', async ({ page, request }) => {
  test.skip(process.env.PODIUM_E2E_FLIGHT_DECK !== '1', 'requires the isolated flight-deck daemon fixture')
  test.setTimeout(300_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await openShell(page)
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos.find((path) => path.endsWith('/issue-1983-flight-deck-factory-interface'))
  if (!repoPath) throw new Error('flight-deck fixture repository not registered')
  const createIssue = async (title: string, parentId?: string): Promise<string> => {
    const row = await rpc<{ id: string }>(request, 'issues.create', {
      repoPath, title, startNow: false, ...(parentId ? { parentId } : {}),
    })
    await rpc(request, 'issues.update', { id: row.id, patch: { stage: 'in_progress' } })
    return row.id
  }
  const rootId = await createIssue('POD-1983 boundary mission')
  const inspectId = await createIssue('POD-1983 inspect task', rootId)
  const nativeId = await createIssue('POD-1983 native task', rootId)
  const incomingIssueId = await createIssue('POD-1983 incoming task', rootId)
  const awayId = await createIssue('POD-1983 away mission')
  const createSession = async (title: string, issueId: string): Promise<string> =>
    (await rpc<{ sessionId: string }>(request, 'sessions.create', {
      agentKind: 'claude-code', cwd: repoPath, issueId, title,
    })).sessionId
  const coordinatorId = await createSession('POD-1983 coordinator', rootId)
  const secondId = await createSession('POD-1983 second tab', rootId)
  const nativeLeadId = await createSession('POD-1983 native task lead', nativeId)
  const nativeOwnerId = await createSession('POD-1983 native owner', nativeId)
  const incomingId = await createSession('POD-1983 incoming target', incomingIssueId)
  await rpc(request, 'issues.setCoordinator', { id: rootId, sessionId: coordinatorId })
  await rpc(request, 'issues.setCoordinator', { id: nativeId, sessionId: nativeLeadId })
  const fileId = 'file:pod-1983-readme'
  const initial = {
    key: `mission:${rootId}`,
    panes: {
      p1: { id: 'p1', tabs: [coordinatorId], activeTabId: coordinatorId },
      p2: { id: 'p2', tabs: [secondId, fileId], activeTabId: fileId },
      p3: { id: 'p3', tabs: [], activeTabId: null },
    },
    root: {
      kind: 'split', axis: 'row', sizes: [0.37, 0.63],
      children: [
        { kind: 'leaf', paneId: 'p1' },
        { kind: 'split', axis: 'column', sizes: [0.62, 0.38], children: [
          { kind: 'leaf', paneId: 'p2' }, { kind: 'leaf', paneId: 'p3' },
        ] },
      ],
    },
    focusedPaneId: 'p3', previewTabId: null,
    deck: { focusedIssueId: inspectId, view: 'overview' },
  }
  await page.evaluate(({ initial, fileId, repoPath, rootId }) => {
    const key = Object.keys(localStorage).find((item) => item.endsWith('.uistate.v1') && item.includes('.principal.'))
    if (!key) throw new Error('principal-local ui-state cache unavailable')
    const ui = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, string>
    ui['podium.workspaces'] = JSON.stringify({ v: 1, workspaces: { [`mission:${rootId}`]: initial } })
    ui['podium.fileTabs'] = JSON.stringify([{
      id: fileId, scope: { kind: 'worktree', root: repoPath },
      path: `${repoPath}/README.md`, worktreePath: repoPath, issueId: rootId,
    }])
    localStorage.setItem(key, JSON.stringify(ui))
  }, { initial, fileId, repoPath, rootId })
  await page.reload()
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, { timeout: 60_000 })

  const enter = async (id: string, title: string): Promise<void> => {
    const row = page.getByTestId('unified-issue-row').filter({ hasText: title }).first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.locator('button.flex-1').first().click()
    await expect(page.locator('aside[aria-label="Flight Deck"]').getByRole('heading', { name: title })).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => (await afterstate()).selectedMission).toBe(id)
  }
  type Afterstate = {
    selectedMission: string | null
    panes: Record<string, { tabs: string[]; activeTabId: string | null }>
    focusedPaneId: string
    root: unknown
    previewTabId: string | null
    focusedIssueId: string | null
  }
  const afterstate = (): Promise<Afterstate> => page.evaluate((rootId) => {
    const key = Object.keys(localStorage).find((item) => item.endsWith('.uistate.v1') && item.includes('.principal.'))
    if (!key) throw new Error('principal-local ui-state cache unavailable')
    const ui = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, string>
    const blob = JSON.parse(ui['podium.workspaces'] ?? '{}') as { workspaces?: Record<string, Afterstate> }
    const ws = blob.workspaces?.[`mission:${rootId}`]
    if (!ws) throw new Error('mission workspace was not persisted')
    return {
      selectedMission: ui['podium.selectedIssueId'] ?? null,
      panes: ws.panes,
      focusedPaneId: ws.focusedPaneId,
      root: ws.root,
      previewTabId: ws.previewTabId,
      focusedIssueId: (ws as Afterstate & { deck?: { focusedIssueId?: string | null } }).deck?.focusedIssueId ?? null,
    }
  }, rootId)

  await enter(rootId, 'POD-1983 boundary mission')
  const deck = page.locator('aside[aria-label="Flight Deck"]')
  await expect(page.getByTestId('native-tab-strip')).toHaveCount(3)
  await expect(deck.getByRole('button', { name: `Open owning agent POD-1983 native owner · native-worker-1` })).toBeVisible()
  // The task row's lead is a DIFFERENT session, so this assertion proves the
  // nested native control dispatched to its owner rather than the task row.
  await deck.getByRole('button', { name: `Open owning agent POD-1983 native owner · native-worker-1` }).click()
  await expect.poll(async () => (await afterstate()).previewTabId).toBe(nativeOwnerId)
  expect((await afterstate()).panes.p3?.activeTabId).toBe(nativeOwnerId)
  expect((await afterstate()).panes.p3?.activeTabId).not.toBe(nativeLeadId)
  await deck.locator(`[data-flight-issue="${inspectId}"]`).getByRole('button', { name: /POD-1983 inspect task/ }).first().click()
  await expect.poll(async () => (await afterstate()).focusedIssueId).toBe(inspectId)
  expect((await afterstate()).previewTabId).toBe(nativeOwnerId)

  const divider = page.getByRole('separator', { name: 'Resize panes' }).first()
  const box = await divider.boundingBox()
  if (!box) throw new Error('nested workspace divider unavailable')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 64, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => ((await afterstate()).root as { sizes: number[] }).sizes[0]).not.toBe(0.37)
  const baseline = await afterstate()
  expect(baseline).toMatchObject({
    selectedMission: rootId, focusedPaneId: 'p3', previewTabId: nativeOwnerId,
    focusedIssueId: inspectId,
  })
  expect(baseline.panes.p1).toEqual({ tabs: [coordinatorId], activeTabId: coordinatorId })
  expect(baseline.panes.p2).toEqual({ tabs: [secondId, fileId], activeTabId: fileId })
  expect(baseline.panes.p3).toEqual({ tabs: [nativeOwnerId], activeTabId: nativeOwnerId })
  expect((baseline.root as { children: Array<{ axis?: string; sizes?: number[] }> }).children[1]).toMatchObject({ axis: 'column', sizes: [0.62, 0.38] })

  await enter(awayId, 'POD-1983 away mission')
  await enter(rootId, 'POD-1983 boundary mission')
  await expect.poll(afterstate).toEqual(baseline)
  await page.reload()
  await expect(deck.getByRole('heading', { name: 'POD-1983 boundary mission' })).toBeVisible({ timeout: 30_000 })
  await expect.poll(afterstate).toEqual(baseline)

  // A fresh incoming URL has no matching history marker. It must open its
  // explicit target after restore, replacing the preview in focused pane p3.
  await page.goto(`/workspace?server=${encodeURIComponent(RELAY)}&e2e=1&wt=${encodeURIComponent(repoPath)}&pane=${encodeURIComponent(incomingId)}`)
  await expect(deck.getByRole('heading', { name: 'POD-1983 boundary mission' })).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => (await afterstate()).panes.p3?.activeTabId).toBe(incomingId)
  const linked = await afterstate()
  expect(linked.selectedMission).toBe(rootId)
  expect(linked.root).toEqual(baseline.root)
  expect(linked.panes.p1).toEqual(baseline.panes.p1)
  expect(linked.panes.p2).toEqual(baseline.panes.p2)
  expect(linked.focusedPaneId).toBe('p3')
  expect(linked.panes.p3).toEqual({ tabs: [incomingId], activeTabId: incomingId })
  expect(linked.previewTabId).toBeNull()
  expect([inspectId, incomingIssueId]).toContain(linked.focusedIssueId)
  expect(nativeId).not.toBe(incomingIssueId)
})
