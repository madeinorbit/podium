import { type EngineState, issueActivityAt, loadingNavigationProvider, NAVIGATION_LOADING, navigationStats, resolvedWorkspaceKey, workspaceKeyForState } from '@podium/client-core/engine'
import type { SessionView } from '@podium/client-core/session-values'
import { planNavigation } from '../../../../packages/client-core/src/engine/navigation'
import { routeDefaults } from '@podium/client-core/ui-state'
import { MobxPool } from '@podium/client-graph'
import { MISSION_SUMMARIES } from '@podium/client-graph/mission-schema'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import { asIssueId } from '@podium/model/browser'
import { computed } from '@podium/client-graph/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startScenarioEngine, upsert } from '../../../../packages/worklist-proto/shared/src/scenarios'
import { createPoolNavigationProvider } from './pool-navigation-provider'
import { NAVIGATION_SUMMARIES, panePoolScreen } from './pane-pool-screen'
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

  it('uses declared cold navigation summaries without loading full issue rows', () => {
    const row = issue('cold', { archived: true, worktreePath: '/repo/branch' })
    const load = vi.fn(() => row)
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined,
      { load, summaries: NAVIGATION_SUMMARIES, schedule: () => () => {} })
    pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: row.id, value: row }] })
    const provider = createPoolNavigationProvider(pool)
    try {
      expect(tracked(() => provider.issue(row.id))).toMatchObject({ id: row.id, updatedAt: stamp, archived: true, worktreePath: '/repo/branch' })
      expect(tracked(() => provider.activityAt(row.id))).toBe(stamp)
      expect(pool.hydrate()).toBe(0)
      expect(load).not.toHaveBeenCalled()
    } finally { pool.dispose() }
  })

  it('matches read activity through hidden descendants and explicit archived or headless sessions', () => {
    const later = '2026-09-24T00:00:00.000Z', outside = '2026-09-30T00:00:00.000Z'
    const rows = [issue('root'), issue('hidden', { parentId: 'root', archived: true }),
      issue('deleted', { parentId: 'hidden', deletedAt: stamp }), issue('leaf', { parentId: 'deleted' }),
      issue('spin-off', { startedBySession: 'owner', updatedAt: outside }), issue('unrelated', { updatedAt: outside })]
    const seats = [
      { sessionId: 'owner', issueId: 'root', lastActiveAt: stamp, cwd: '/repo' },
      { sessionId: 'archived-seat', issueId: 'hidden', lastActiveAt: later, archived: true, status: 'exited', stoppedAt: later, cwd: '/repo' },
      { sessionId: 'headless-seat', issueId: 'leaf', lastActiveAt: later, headless: true, cwd: '/repo' },
      { sessionId: 'cwd-only', lastActiveAt: outside, cwd: '/repo' },
    ] as SessionView[]
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined,
      { summaries: NAVIGATION_SUMMARIES, schedule: () => () => {} })
    pool.apply({ type: 'replace', rows: [...rows.map(value => ({ kind: 'issue' as const, id: value.id, value })),
      ...seats.map(value => ({ kind: 'session' as const, id: value.sessionId, value }))] })
    const provider = createPoolNavigationProvider(pool)
    try {
      expect(tracked(() => provider.activityAt('root'))).toBe(issueActivityAt(rows[0]!, seats, rows))
      expect(tracked(() => provider.activityAt('root'))).toBe(later)
      expect(tracked(() => provider.activityAt('absent'))).toBeUndefined()
      expect(pool.hydrate()).toBe(0)
      const newest = '2026-09-25T00:00:00.000Z'
      pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'leaf', value: { ...rows[3]!, updatedAt: newest } }] })
      expect(tracked(() => provider.activityAt('root'))).toBe(newest)
    } finally { pool.dispose() }
  })

  it('loads missing cold activity facts in the ordinary batch', () => {
    const rows = [issue('root'), issue('hidden', { parentId: 'root', archived: true, updatedAt: '2026-09-25T00:00:00.000Z' })]
    const load = vi.fn((_kind: string, id: string) => rows.find(row => row.id === id))
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined,
      { load, summaries: MISSION_SUMMARIES, schedule: () => () => {} })
    pool.apply({ type: 'replace', rows: rows.map(value => ({ kind: 'issue', id: value.id, value })) })
    const provider = createPoolNavigationProvider(pool)
    try {
      expect(tracked(() => provider.activityAt('root'))).toBe(NAVIGATION_LOADING)
      expect(load).not.toHaveBeenCalled()
      expect(pool.hydrate()).toBe(1)
      expect(tracked(() => provider.activityAt('root'))).toBe(issueActivityAt(rows[0]!, [], rows))
      expect(load).toHaveBeenCalledExactlyOnceWith('issue', 'hidden')
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
      runtime.getSnapshot().navigateToSession(seat.sessionId)
      expect(runtime.getSnapshot().selectedIssueId).toBe(before.selectedIssueId)
      await vi.waitFor(() => expect(runtime.getSnapshot().selectedIssueId).toBe(target.id))
      expect(runtime.getSnapshot().paneA).toBe(seat.sessionId)
      expect(runtime.getSnapshot().workspaceKey()).toBe(expectedKey)
      if (seat.displayRef) {
        runtime.getSnapshot().navigateToSession(seat.displayRef)
        expect(runtime.getSnapshot().paneA).toBe(seat.sessionId)
      }
      // The notice's Open chat action and eager read reaction use the same port.
      runtime.getSnapshot().navigateToSession(seat.sessionId)
      await vi.waitFor(() => expect(runtime.getSnapshot().paneA).toBe(seat.sessionId))
      expect(runtime.router.current().pane).toBe(seat.sessionId)
      expect(runtime.getSnapshot().workspaceKey()).toBe(expectedKey)
      expect(navigationStats.read()).toEqual({ issuesFind: 0, missionRootFor: 0, sessionById: 0 })
      expect(errors).not.toHaveBeenCalled()
    } finally { detach(); runtime.destroy() }
  })

  it('keeps local birth refs canonical, including a cold ref through its declared summary', () => {
    const seat = { sessionId: 'seat', displayRef: 'POD-529-A', archived: true, status: 'exited',
      cwd: '/repo', createdAt: stamp, lastActiveAt: stamp, stoppedAt: stamp, agentKind: 'codex' }
    const load = vi.fn(() => seat)
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined,
      { load, summaries: { session: ['displayRef'] }, schedule: () => () => {} })
    pool.apply({ type: 'replace', rows: [{ kind: 'session', id: seat.sessionId, value: seat }] })
    const provider = createPoolNavigationProvider(pool)
    try {
      expect(tracked(() => provider.session(seat.displayRef))).toBe(NAVIGATION_LOADING)
      expect(load).not.toHaveBeenCalled()
      pool.hydrate()
      expect(load).toHaveBeenCalledTimes(1)
      expect(tracked(() => provider.session(`  ${seat.displayRef}  `))).toMatchObject({ sessionId: seat.sessionId })
      expect(tracked(() => provider.session('POD-530-A'))).toBeUndefined()
    } finally { pool.dispose() }
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

  it('restores the current visit when the loading provider becomes ready', async () => {
    const ctx = await startScenarioEngine(1, { start: false, ownRows: true })
    const runtime = ctx.engine
    const target = asIssueId(ctx.targets.visibleRootId)
    runtime.getSnapshot().setView('workspace')
    runtime.getSnapshot().setSelectedIssueId(target)
    expect(runtime.getSnapshot().issueVisitBaseline?.issueId).toBe(target)
    const detach = preparePoolScreens([panePoolScreen], runtime)
    const { createRuntimeWorklistPool } = await import('@podium/client-graph/runtime-pool')
    const handle = createRuntimeWorklistPool(runtime, { summaries: MISSION_SUMMARIES })
    try {
      expect(runtime.getSnapshot().issueVisitBaseline).toBeNull()
      runtime.setNavigationProvider(createPoolNavigationProvider(handle.pool))
      expect(runtime.getSnapshot().issueVisitBaseline?.issueId).toBe(target)
    } finally { detach(); handle.dispose(); runtime.destroy() }
  })

  it('follows a session rehome after pool delivery and preserves the active tab', async () => {
    for (const enabled of [false, true]) {
      const ctx = await startScenarioEngine(1, { ownRows: true })
      const runtime = ctx.engine
      const { createRuntimeWorklistPool } = await import('@podium/client-graph/runtime-pool')
      const handle = enabled ? createRuntimeWorklistPool(runtime, { summaries: MISSION_SUMMARIES }) : undefined
      try {
        if (handle) runtime.setNavigationProvider(createPoolNavigationProvider(handle.pool))
        const st = runtime.getSnapshot()
        const seat = st.sessions.find(row => !row.archived && row.issueId &&
          st.issueProjections.some(issue => issue.id === row.issueId && !issue.archived && !issue.deletedAt))!
        const sourceKey = workspaceKeyForState({ ...st, selectedIssueId: seat.issueId! })
        const target = st.issueProjections.find(issue => !issue.archived && !issue.deletedAt &&
          workspaceKeyForState({ ...st, selectedIssueId: issue.id }) !== sourceKey)!
        runtime.getSnapshot().navigateToSession(seat.sessionId)
        await vi.waitFor(() => expect(runtime.getSnapshot().paneA).toBe(seat.sessionId))
        navigationStats.enable(); navigationStats.reset()
        const raw = ctx.cache.read('session', seat.sessionId)!.value as object
        upsert(ctx, 'session', seat.sessionId, { ...raw, issueId: target.id })
        await vi.waitFor(() => expect(runtime.getSnapshot().selectedIssueId).toBe(target.id))
        expect(runtime.getSnapshot().paneA).toBe(seat.sessionId)
        expect(runtime.router.current().pane).toBe(seat.sessionId)
        expect(Object.values(runtime.getSnapshot().workspaces[sourceKey]?.panes ?? {}).flatMap(pane => pane.tabs)).not.toContain(seat.sessionId)
        if (enabled) expect(navigationStats.read()).toEqual({ issuesFind: 0, missionRootFor: 0, sessionById: 0 })
      } finally { runtime.setNavigationProvider(loadingNavigationProvider); handle?.dispose(); runtime.destroy() }
    }
  })

  it('watches navigation fields without waking for display metadata', async () => {
    const ctx = await startScenarioEngine(1, { start: false, ownRows: true })
    const runtime = ctx.engine
    const target = asIssueId(ctx.targets.visibleRootId)
    runtime.getSnapshot().navigateWorkspace({ selectedIssueId: target })
    const { createRuntimeWorklistPool } = await import('@podium/client-graph/runtime-pool')
    const handle = createRuntimeWorklistPool(runtime, { summaries: MISSION_SUMMARIES })
    runtime.setNavigationProvider(createPoolNavigationProvider(handle.pool))
    const turn = () => new Promise(resolve => setTimeout(resolve, 0))
    await turn()
    const reactions = (runtime as unknown as { reactions: {
      updateIssueVisitBaseline(): void; updateIssueMarkReadTimer(): void; updateMarkReadTimer(): void
    } }).reactions
    const spies = ['updateIssueVisitBaseline', 'updateIssueMarkReadTimer', 'updateMarkReadTimer'].map(name =>
      vi.spyOn(reactions, name as keyof typeof reactions))
    try {
      const row = tracked(() => handle.pool.row('issue', target)) as SliceIssue
      handle.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: target, value: { ...row, title: 'Changed display title' } }] })
      await turn()
      expect(spies.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0])
      handle.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: target, value: { ...row, updatedAt: ctx.stamp() } }] })
      await vi.waitFor(() => expect(spies[0]).toHaveBeenCalled())
    } finally {
      spies.forEach(spy => { spy.mockRestore() })
      runtime.setNavigationProvider(loadingNavigationProvider); handle.dispose(); runtime.destroy()
    }
  })

  it('matches navigation plans for every issue in the operator-sized synthetic corpus', async () => {
    const ctx = await startScenarioEngine(1, { start: false, ownRows: true })
    const runtime = ctx.engine
    const { createRuntimeWorklistPool } = await import('@podium/client-graph/runtime-pool')
    const handle = createRuntimeWorklistPool(runtime, { summaries: NAVIGATION_SUMMARIES })
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
        if (tracked(() => provider.activityAt(issue.id)) !== issueActivityAt(issue, st.sessions, st.issueProjections)) differences++
        expect(tracked(() => provider.issueReadAt(issue.id)) ?? null).toBe(st.issueUserStates.find(row => row.entityId === issue.id)?.readAt ?? null)
      }
      expect(differences).toBe(0)
    } finally { handle.dispose(); runtime.destroy() }
  }, 60_000)
})
