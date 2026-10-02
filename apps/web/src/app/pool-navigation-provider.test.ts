import { type EngineState, loadingNavigationProvider, NAVIGATION_LOADING, navigationStats, resolvedWorkspaceKey, workspaceKeyForState } from '@podium/client-core/engine'
import { planNavigation } from '../../../../packages/client-core/src/engine/navigation'
import { routeDefaults } from '@podium/client-core/ui-state'
import { MobxPool } from '@podium/client-graph'
import { MISSION_SUMMARIES } from '@podium/client-graph/mission-schema'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import { asIssueId } from '@podium/model/browser'
import { computed } from '@podium/client-graph/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startScenarioEngine } from '../../../../packages/worklist-proto/shared/src/scenarios'
import { createPoolNavigationProvider } from './pool-navigation-provider'
import { panePoolScreen } from './pane-pool-screen'
import { preparePoolScreens, screenOptions } from './pool-screen-registry'
import { attachWorklistPool } from './store-worklist-pool'

const choice = vi.hoisted(() => ({ mode: 'pool' }))
vi.mock('@/lib/pane-data-layer', () => ({ initializePaneDataLayer() {}, paneDataLayer: () => choice.mode }))
vi.mock('@/lib/sidebar-data-layer', () => ({ initializeSidebarDataLayer() {}, sidebarDataLayer: () => 'legacy', sidebarCheckRequested: () => false }))
afterEach(() => { navigationStats.disable(); navigationStats.reset(); choice.mode = 'pool' })
const stamp = '2026-09-18T00:00:00.000Z'
const tracked = <T>(read: () => T): T => computed(read).get()
const issue = (id: string, patch: Partial<SliceIssue> = {}): SliceIssue => ({
  id, seq: 1, title: 'Synthetic task', stage: 'backlog', repoPath: '/repo', createdAt: stamp, updatedAt: stamp, ...patch,
})

describe('web pool navigation', () => {
  it('agrees with legacy keys for hidden ancestors, drafts, absent parents and direct missing ids', () => {
    const rows = [issue('root'), issue('child', { parentId: 'root' }),
      issue('archived', { parentId: 'root', archived: true }), issue('below-archived', { parentId: 'archived' }),
      issue('deleted', { parentId: 'root', deletedAt: stamp }), issue('below-deleted', { parentId: 'deleted' }),
      issue('orphan', { parentId: 'absent' }), issue('draft', { isDraftVessel: true }), issue('draft-child', { parentId: 'draft' })]
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
    pool.apply({ type: 'replace', rows: rows.map(value => ({ kind: 'issue', id: value.id, value })) })
    const provider = createPoolNavigationProvider(pool)
    try {
      for (const id of [...rows.map(row => row.id), 'absent', null]) {
        const st = { issueProjections: rows, selectedIssueId: id, selectedWorktree: '/repo' } as unknown as EngineState
        expect(tracked(() => workspaceKeyForState({ ...st, navigation: provider })), String(id)).toBe(workspaceKeyForState(st))
      }
      const selected = { issueProjections: rows, selectedIssueId: 'child', selectedWorktree: '/repo', navigation: provider } as unknown as EngineState
      expect(tracked(() => workspaceKeyForState(selected))).toBe('mission:root')
      pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'child', value: issue('child', { parentId: 'draft' }) }] })
      // The legacy array stayed identical: pool topology owns invalidation.
      expect(tracked(() => workspaceKeyForState(selected))).toBe('mission:draft')
    } finally { pool.dispose() }
  })

  it('answers cold rows with LOADING and the batched loader, then resolves the real root', () => {
    const rows = [issue('root', { archived: true }), issue('child', { parentId: 'root', archived: true })]
    const byId = new Map(rows.map(row => [row.id, row]))
    const load = vi.fn((_kind: string, id: string) => byId.get(id))
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined,
      { load, summaries: MISSION_SUMMARIES, schedule: () => () => {} })
    pool.apply({ type: 'replace', rows: rows.map(value => ({ kind: 'issue', id: value.id, value })) })
    const provider = createPoolNavigationProvider(pool)
    try {
      expect(tracked(() => provider.issue('child'))).toBe(NAVIGATION_LOADING)
      expect(load).not.toHaveBeenCalled()
      pool.hydrate()
      expect(load).toHaveBeenCalledTimes(1)
      expect(tracked(() => provider.issue('child'))).toMatchObject({ id: 'child' })
      expect(tracked(() => provider.missionRoot('child'))).toBe('child')
    } finally { pool.dispose() }
  })

  it('keeps existing screen options and preparation unchanged when the pane switch is off', () => {
    choice.mode = 'legacy'
    const setNavigationProvider = vi.fn(), prepare = vi.fn(), stop = vi.fn()
    const screens = [{ initialize() {}, enabled: () => true, options: () => ({ settings: true }), prepare: () => { prepare(); return stop } }, panePoolScreen]
    const runtime = { setNavigationProvider } as never
    const detach = preparePoolScreens(screens, runtime)
    expect(screenOptions(screens, runtime)).toEqual({ settings: true })
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(setNavigationProvider).not.toHaveBeenCalled()
    detach(); detach()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('installs the loading port before import and resumes navigation without any legacy read', async () => {
    const ctx = await startScenarioEngine(1, { start: false, ownRows: true })
    const runtime = ctx.engine
    const before = runtime.getSnapshot()
    const seat = before.sessions.find(session => !session.archived && session.issueId &&
      before.issueProjections.some(row => row.id === session.issueId && !row.archived && !row.deletedAt))!
    const target = before.issueProjections.find(row => row.id === seat.issueId)!
    const expectedKey = workspaceKeyForState({ ...before, selectedIssueId: target.id })
    const errors = vi.fn()
    navigationStats.enable(); navigationStats.reset()
    const detach = attachWorklistPool(runtime, errors)
    try {
      expect(resolvedWorkspaceKey({ ...runtime.getSnapshot(), selectedIssueId: target.id })).toBe(NAVIGATION_LOADING)
      expect(runtime.getSnapshot().navigateWorkspace({ selectedIssueId: target.id })).toBe(false)
      expect(runtime.getSnapshot().selectedIssueId).toBe(before.selectedIssueId)
      expect(navigationStats.read()).toEqual({ issuesFind: 0, missionRootFor: 0, sessionById: 0 })
      await vi.waitFor(() => expect(runtime.getSnapshot().selectedIssueId).toBe(target.id))
      expect(runtime.getSnapshot().workspaceKey()).toBe(expectedKey)
      // The notice's Open chat action and eager read reaction use the same port.
      runtime.getSnapshot().navigateToSession(seat.sessionId)
      await vi.waitFor(() => expect(runtime.getSnapshot().paneA).toBe(seat.sessionId))
      expect(runtime.router.current().pane).toBe(seat.sessionId)
      expect(runtime.getSnapshot().workspaceKey()).toBe(expectedKey)
      expect(navigationStats.read()).toEqual({ issuesFind: 0, missionRootFor: 0, sessionById: 0 })
      expect(errors).not.toHaveBeenCalled()
    } finally { detach(); runtime.destroy() }
  })

  it('a retired async attachment cannot replace a new generation with the old pool', async () => {
    const setNavigationProvider = vi.fn()
    const runtime = { setNavigationProvider, isDestroyed: false } as never
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
    const retire = preparePoolScreens([panePoolScreen], runtime)
    const attached = panePoolScreen.attach!(runtime, pool)
    retire()
    const stopNext = preparePoolScreens([panePoolScreen], runtime)
    try {
      expect(await attached).toBeUndefined()
      expect(setNavigationProvider.mock.calls.every(([provider]) => provider === loadingNavigationProvider)).toBe(true)
    } finally { stopNext(); pool.dispose() }
  })

  it('a newer navigation cancels the selection waiting for the pool import', async () => {
    const ctx = await startScenarioEngine(1, { start: false, ownRows: true })
    const runtime = ctx.engine
    const target = runtime.getSnapshot().issueProjections[0]!.id
    const detach = preparePoolScreens([panePoolScreen], runtime)
    try {
      runtime.getSnapshot().navigateWorkspace({ selectedIssueId: target })
      runtime.getSnapshot().setView('settings')
      const { createRuntimeWorklistPool } = await import('@podium/client-graph/runtime-pool')
      const handle = createRuntimeWorklistPool(runtime, { summaries: MISSION_SUMMARIES })
      try {
        runtime.setNavigationProvider(createPoolNavigationProvider(handle.pool))
        expect(runtime.getSnapshot().view).toBe('settings')
        expect(runtime.getSnapshot().selectedIssueId).not.toBe(target)
      } finally { runtime.setNavigationProvider(loadingNavigationProvider); handle.dispose() }
    } finally { detach(); runtime.destroy() }
  })

  it('matches navigation plans for every issue in the operator-sized synthetic corpus', async () => {
    const ctx = await startScenarioEngine(1, { start: false, ownRows: true })
    const runtime = ctx.engine
    const { createRuntimeWorklistPool } = await import('@podium/client-graph/runtime-pool')
    const handle = createRuntimeWorklistPool(runtime, { summaries: MISSION_SUMMARIES })
    const provider = createPoolNavigationProvider(handle.pool)
    try {
      const st: EngineState = runtime.getSnapshot()
      const check = (id: string) => tracked(() => planNavigation({ ...st, navigation: provider }, routeDefaults('issues'),
        { view: 'workspace', selectedIssueId: asIssueId(id) }, { visible: true, now: stamp }))
      for (const issue of st.issueProjections) check(issue.id)
      for (let i = 0; i < 32 && handle.pool.hydrate() > 0; i++) { for (const issue of st.issueProjections) check(issue.id) }
      let differences = 0
      for (const issue of st.issueProjections) {
        const expected = planNavigation(st, routeDefaults('issues'), { view: 'workspace', selectedIssueId: issue.id }, { visible: true, now: stamp })
        const actual = check(issue.id)
        if (JSON.stringify(actual) !== JSON.stringify(expected)) differences++
      }
      expect(differences).toBe(0)
    } finally { handle.dispose(); runtime.destroy() }
  }, 60_000)
})
