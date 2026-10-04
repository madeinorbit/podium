import { fixtureNavigation } from '@podium/client-core/test-support/navigation'
import type { IssueProjection } from '@podium/model'
import { issueActivityAt } from '@podium/client-graph/diagnostics/reference-state'
import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
import {
  type EngineState,
  knownTabIdsForWorkspace,
  loadingNavigationProvider,
  NAVIGATION_LOADING,
  resolvedWorkspaceKey,
  workspaceKeyForState,
} from '@podium/client-core/engine'
import type { SessionView } from '@podium/client-core/session-values'
import { routeDefaults } from '@podium/client-core/ui-state'
import {
  allTabIds,
  emptyWorkspace,
  indexMissionSessions,
  missionIssueIds,
  missionLegacyStats,
  openTab,
  type WorkspaceKey,
} from '@podium/client-core/values'
import { MobxPool } from '@podium/client-graph'
import { preparePoolScreens, screenOptions } from '@podium/client-graph/host'
import { MISSION_SUMMARIES } from '@podium/client-graph/mission-schema'
import { computed } from '@podium/client-graph/react'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import { asIssueId } from '@podium/model/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { planNavigation } from '../../../../packages/client-core/src/engine/navigation'
import { Reactions } from '../../../../packages/client-core/src/engine/reactions'
import {
  startScenarioEngine,
  upsert,
} from '../../../../packages/worklist-proto/shared/src/scenarios'
import { NAVIGATION_SUMMARIES, panePoolScreen } from './pane-pool-screen'
import { createPoolNavigationProvider } from './pool-navigation-provider'
import { attachWorklistPool } from './store-worklist-pool'

afterEach(() => {
  missionLegacyStats.disable()
  missionLegacyStats.reset()
  vi.restoreAllMocks()
})
const stamp = '2026-09-18T00:00:00.000Z'
const tracked = <T>(read: () => T): T => computed(read).get()
const issue = (id: string, patch: Partial<SliceIssue> = {}): SliceIssue => ({
  id,
  seq: 1,
  title: 'Synthetic task',
  stage: 'backlog',
  repoPath: '/repo',
  createdAt: stamp,
  updatedAt: stamp,
  ...patch,
})
const legacyActivity = (rows: SliceIssue[], sessions: SessionView[]) =>
  issueActivityAt(
    { ...rows[0]!, id: asIssueId(rows[0]!.id) },
    sessions,
    rows.map((row) => ({
      ...row,
      id: asIssueId(row.id),
      parentId: row.parentId ? asIssueId(row.parentId) : undefined,
    })),
  )

describe('web pool navigation', () => {
  it('counts legacy membership entries even on memo hits and direct session indexing', () => {
    const rows = [{ id: asIssueId('root'), stage: 'backlog' as const, archived: false }],
      sessions: SessionView[] = []
    missionIssueIds(rows, 'root', sessions)
    missionLegacyStats.enable()
    missionLegacyStats.reset()
    for (let i = 0; i < 3; i++) missionIssueIds(rows, 'root', sessions)
    indexMissionSessions(sessions)
    expect(missionLegacyStats.read()).toEqual({ missionIssueIds: 3, indexMissionSessions: 1 })
  })

  it('matches legacy mission tab pruning using pool membership and declared cold worktrees', () => {
    const rows = [
      issue('root', { worktreePath: '/wt/root' }),
      issue('child', { parentId: 'root', worktreePath: '/wt/child' }),
      issue('started', { startedBySession: 'owner', worktreePath: '/wt/started', archived: true }),
      issue('grafted', { parentId: 'started', worktreePath: '/wt/grafted' }),
      issue('spin', {
        startedBySession: 'owner',
        stage: 'in_progress',
        worktreePath: '/wt/spin',
        deps: [{ id: 'child', type: 'discovered-from' }],
      }),
      issue('other', { worktreePath: '/wt/other' }),
    ]
    const sessions = [
      { sessionId: 'owner', issueId: 'child', cwd: '/wt/child', archived: true, headless: true },
      { sessionId: 'started', issueId: 'started', cwd: '/wt/started' },
      { sessionId: 'spin', issueId: 'spin', cwd: '/wt/spin' },
      { sessionId: 'grafted', issueId: 'grafted', cwd: '/wt/grafted' },
      { sessionId: 'loose-root', cwd: '/wt/root/src' },
      { sessionId: 'loose-started', cwd: '/wt/started/src' },
      { sessionId: 'loose-other', cwd: '/wt/other' },
      { sessionId: 'near-miss', cwd: '/wt/rooted' },
    ] as SessionView[]
    const fileTabs = [
      {
        id: 'file',
        scope: { kind: 'worktree', worktreePath: '/wt/root' },
        path: 'README.md',
        worktreePath: '/wt/root',
      },
    ]
    const legacy = {
      issueProjections: rows,
      issueDeps: [{ id: 'departure', fromId: 'spin', toId: 'child', type: 'discovered-from' }],
      sessions,
      pendingSpawnIds: new Set(['spawn']),
      fileTabs,
    } as unknown as EngineState & { issueProjections: SliceIssue[]; sessions: SessionView[]; issueUserStates: object[]; pendingSpawnIds: ReadonlySet<string> } & { issueProjections: SliceIssue[]; sessions: SessionView[]; issueUserStates: object[]; pendingSpawnIds: ReadonlySet<string> }
    const keys: WorkspaceKey[] = ['mission:root', 'mission:other', 'mission:absent']
    legacy.navigation = fixtureNavigation({ issues: () => rows as unknown as IssueProjection[], sessions: () => sessions })
    const expected = keys.map((key) => [...knownTabIdsForWorkspace(legacy, key)].sort())
    const load = vi.fn((_kind: string, id: string) => rows.find((row) => row.id === id))
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
      load,
      summaries: NAVIGATION_SUMMARIES,
      schedule: () => () => {},
    })
    pool.apply({
      type: 'replace',
      rows: [
        ...rows.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
        ...sessions.map((value) => ({ kind: 'session' as const, id: value.sessionId, value })),
      ],
    })
    const navigation = createPoolNavigationProvider(pool)
    // The pool is authoritative even when the legacy issue/dependency slices
    // are stale or empty. Session and file liveness keep their original owner.
    const state = { ...legacy, navigation, issueProjections: [], issueDeps: [] }
    const layouts = Object.fromEntries(
      keys.map((key) => [
        key,
        [...sessions.map((row) => row.sessionId), 'file', 'spawn', 'ghost'].reduce(
          (ws, id) => openTab(ws, id, { permanent: true }),
          emptyWorkspace(key),
        ),
      ]),
    )
    const prune = (st: EngineState) => {
      const reactions = new Reactions({
        state: () => st,
        publish: (patch) => Object.assign(st, patch),
        hub: {} as never,
        notices: {} as never,
        isVisible: () => true,
        markSessionRead: vi.fn(),
        markIssueRead: vi.fn(),
      })
      try {
        reactions.pruneWorkspaces()
        return st.workspaces
      } finally {
        reactions.dispose()
      }
    }
    const expectedLayouts = prune({ ...legacy, workspaces: layouts })
    missionLegacyStats.enable()
    missionLegacyStats.reset()
    try {
      for (const [i, key] of keys.entries())
        expect([...knownTabIdsForWorkspace(state, key)].sort()).toEqual(expected[i])
      const actualLayouts = prune({ ...state, workspaces: layouts })
      expect(actualLayouts).toEqual(expectedLayouts)
      expect(allTabIds(actualLayouts['mission:root']!)).toEqual(
        expect.arrayContaining([
          'owner',
          'started',
          'loose-root',
          'loose-started',
          'file',
          'spawn',
          'ghost',
        ]),
      )
      expect(allTabIds(actualLayouts['mission:root']!)).not.toContain('spin')
      expect(allTabIds(actualLayouts['mission:root']!)).not.toContain('grafted')
      expect(missionLegacyStats.read()).toEqual({ missionIssueIds: 0, indexMissionSessions: 0 })
      expect(pool.hydrate()).toBe(0)
      expect(load).not.toHaveBeenCalled()
      // Topology and worktree changes come from the pool, without a legacy
      // slice update or a second membership index owned by the engine.
      pool.apply({
        type: 'update',
        rows: [
          {
            kind: 'issue',
            id: 'child',
            value: issue('child', { parentId: 'other', worktreePath: '/wt/new' }),
          },
        ],
      })
      expect(knownTabIdsForWorkspace(state, 'mission:root').has('owner')).toBe(false)
      expect(knownTabIdsForWorkspace(state, 'mission:other').has('owner')).toBe(true)
      expect(knownTabIdsForWorkspace(state, 'mission:root').has('loose-started')).toBe(false)
      expect(missionLegacyStats.read()).toEqual({ missionIssueIds: 0, indexMissionSessions: 0 })
    } finally {
      pool.dispose()
    }
  })

  it('keeps mission tabs while the pool membership or member worktree is loading without legacy reads', () => {
    const sessions = [
      { sessionId: 'bound', issueId: 'child', cwd: '/repo' },
      { sessionId: 'foreign', issueId: 'other', cwd: '/repo' },
      { sessionId: 'loose', cwd: '/wt/child/src' },
    ] as SessionView[]
    const state = {
      navigation: loadingNavigationProvider,
      issueProjections: [],
      issueDeps: [],
      sessions,
      pendingSpawnIds: new Set(),
      fileTabs: [],
    } as unknown as EngineState & { issueProjections: SliceIssue[]; sessions: SessionView[]; issueUserStates: object[]; pendingSpawnIds: ReadonlySet<string> } & { issueProjections: SliceIssue[]; sessions: SessionView[]; issueUserStates: object[]; pendingSpawnIds: ReadonlySet<string> }
    missionLegacyStats.enable()
    missionLegacyStats.reset()
    expect([...knownTabIdsForWorkspace(state, 'mission:root')]).toEqual([
      'bound',
      'foreign',
      'loose',
    ])
    let ready = false
    state.navigation = {
      ...loadingNavigationProvider,
      missionMembers: () => new Set(['child']),
      issue: (id) =>
        ready
          ? { id: asIssueId(id), updatedAt: stamp, archived: false, worktreePath: '/wt/elsewhere' }
          : NAVIGATION_LOADING,
    }
    expect([...knownTabIdsForWorkspace(state, 'mission:root')]).toEqual(['bound', 'loose'])
    ready = true
    expect([...knownTabIdsForWorkspace(state, 'mission:root')]).toEqual(['bound'])
    expect(missionLegacyStats.read()).toEqual({ missionIssueIds: 0, indexMissionSessions: 0 })
  })

  it('switches sessions with identical layouts and no legacy mission entries while pruning runs', async () => {
    const prune = vi.spyOn(Reactions.prototype, 'pruneWorkspaces')
    {
      const ctx = await startScenarioEngine(1, { ownRows: true })
      const runtime = ctx.engine
      const { createRuntimeWorklistPool } = await import('@podium/client-graph/runtime-pool')
      const handle = createRuntimeWorklistPool(runtime, { summaries: NAVIGATION_SUMMARIES })
      try {
        if (handle) {

          runtime.setNavigationProvider(createPoolNavigationProvider(handle.pool))
        }
        const before = referenceState(runtime)
        before.navigation = fixtureNavigation({ issues: () => before.issueProjections, sessions: () => before.sessions })
        const seats = before.sessions.filter(
          (row) =>
            !row.archived &&
            row.issueId &&
            before.issueProjections.some(
              (issue) => issue.id === row.issueId && !issue.archived && !issue.deletedAt,
            ),
        )
        const first = seats[0]!
        const firstKey = workspaceKeyForState({ ...before, selectedIssueId: first.issueId! })
        const next = seats.find(
          (row) => workspaceKeyForState({ ...before, selectedIssueId: row.issueId! }) !== firstKey,
        )!
        referenceState(runtime).navigateToSession(first.sessionId)
        await vi.waitFor(() => expect(referenceState(runtime).paneA).toBe(first.sessionId))
        prune.mockClear()
        missionLegacyStats.enable()
        missionLegacyStats.reset()
        referenceState(runtime).navigateToSession(next.sessionId)
        await vi.waitFor(() => expect(referenceState(runtime).paneA).toBe(next.sessionId))
        expect(prune).toHaveBeenCalled()
        expect(missionLegacyStats.read()).toEqual({ missionIssueIds: 0, indexMissionSessions: 0 })
        const st = referenceState(runtime)
        expect(st.selectedIssueId).toBe(next.issueId)
        expect(st.paneA).toBe(next.sessionId)
        expect(st.workspaceKey()).toBe(workspaceKeyForState({ ...before, selectedIssueId: next.issueId! }))
      } finally {
        missionLegacyStats.disable()
        runtime.setNavigationProvider(loadingNavigationProvider)
        handle?.dispose()
        runtime.destroy()
      }
    }
  })

  it('agrees with legacy keys for hidden ancestors, drafts, absent parents and direct missing ids', () => {
    const rows = [
      issue('root'),
      issue('child', { parentId: 'root' }),
      issue('archived', { parentId: 'root', archived: true }),
      issue('below-archived', { parentId: 'archived' }),
      issue('deleted', { parentId: 'root', deletedAt: stamp }),
      issue('below-deleted', { parentId: 'deleted' }),
      issue('orphan', { parentId: 'absent' }),
      issue('draft', { isDraftVessel: true }),
      issue('draft-child', { parentId: 'draft' }),
    ]
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
    pool.apply({
      type: 'replace',
      rows: rows.map((value) => ({ kind: 'issue', id: value.id, value })),
    })
    const provider = createPoolNavigationProvider(pool)
    try {
      for (const id of [...rows.map((row) => row.id), 'absent', null]) {
        const st = {
          navigation: fixtureNavigation({ issues: () => rows as unknown as IssueProjection[], sessions: () => [] }),
          issueProjections: rows,
          selectedIssueId: id,
          selectedWorktree: '/repo',
        } as unknown as EngineState & { issueProjections: SliceIssue[]; sessions: SessionView[]; issueUserStates: object[]; pendingSpawnIds: ReadonlySet<string> } & { issueProjections: SliceIssue[]; sessions: SessionView[]; issueUserStates: object[]; pendingSpawnIds: ReadonlySet<string> }
        expect(
          tracked(() => workspaceKeyForState({ ...st, navigation: provider })),
          String(id),
        ).toBe(workspaceKeyForState(st))
      }
      const selected = {
        issueProjections: rows,
        selectedIssueId: 'child',
        selectedWorktree: '/repo',
        navigation: provider,
      } as unknown as EngineState & { issueProjections: SliceIssue[]; sessions: SessionView[]; issueUserStates: object[]; pendingSpawnIds: ReadonlySet<string> } & { issueProjections: SliceIssue[]; sessions: SessionView[]; issueUserStates: object[]; pendingSpawnIds: ReadonlySet<string> }
      expect(tracked(() => workspaceKeyForState(selected))).toBe('mission:root')
      pool.apply({
        type: 'update',
        rows: [{ kind: 'issue', id: 'child', value: issue('child', { parentId: 'draft' }) }],
      })
      // The legacy array stayed identical: pool topology owns invalidation.
      expect(tracked(() => workspaceKeyForState(selected))).toBe('mission:draft')
    } finally {
      pool.dispose()
    }
  })

  it('answers cold rows with LOADING and the batched loader, then resolves the real root', () => {
    const rows = [
      issue('root', { archived: true }),
      issue('child', { parentId: 'root', archived: true }),
    ]
    const byId = new Map(rows.map((row) => [row.id, row]))
    const load = vi.fn((_kind: string, id: string) => byId.get(id))
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
      load,
      summaries: MISSION_SUMMARIES,
      schedule: () => () => {},
    })
    pool.apply({
      type: 'replace',
      rows: rows.map((value) => ({ kind: 'issue', id: value.id, value })),
    })
    const provider = createPoolNavigationProvider(pool)
    try {
      expect(tracked(() => provider.issue('child'))).toBe(NAVIGATION_LOADING)
      expect(load).not.toHaveBeenCalled()
      pool.hydrate()
      expect(load).toHaveBeenCalledTimes(1)
      expect(tracked(() => provider.issue('child'))).toMatchObject({ id: 'child' })
      expect(tracked(() => provider.missionRoot('child'))).toBe('child')
    } finally {
      pool.dispose()
    }
  })

  it('uses declared cold navigation summaries without loading full issue rows', () => {
    const row = issue('cold', { archived: true, worktreePath: '/repo/branch' })
    const load = vi.fn(() => row)
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
      load,
      summaries: NAVIGATION_SUMMARIES,
      schedule: () => () => {},
    })
    pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: row.id, value: row }] })
    const provider = createPoolNavigationProvider(pool)
    try {
      expect(tracked(() => provider.issue(row.id))).toMatchObject({
        id: row.id,
        updatedAt: stamp,
        archived: true,
        worktreePath: '/repo/branch',
      })
      expect(tracked(() => provider.activityAt(row.id))).toBe(stamp)
      expect(pool.hydrate()).toBe(0)
      expect(load).not.toHaveBeenCalled()
    } finally {
      pool.dispose()
    }
  })

  it('matches read activity through hidden descendants and explicit archived or headless sessions', () => {
    const later = '2026-09-24T00:00:00.000Z',
      outside = '2026-09-30T00:00:00.000Z'
    const rows = [
      issue('root'),
      issue('hidden', { parentId: 'root', archived: true }),
      issue('deleted', { parentId: 'hidden', deletedAt: stamp }),
      issue('leaf', { parentId: 'deleted' }),
      issue('archived-owner', { parentId: 'root', archived: true }),
      issue('spin-off', { startedBySession: 'owner', updatedAt: outside }),
      issue('unrelated', { updatedAt: outside }),
    ]
    const seats = [
      { sessionId: 'owner', issueId: 'root', lastActiveAt: stamp, cwd: '/repo' },
      {
        sessionId: 'archived-seat',
        issueId: 'archived-owner',
        lastActiveAt: later,
        archived: true,
        status: 'exited',
        stoppedAt: later,
        cwd: '/repo',
      },
      {
        sessionId: 'headless-seat',
        issueId: 'leaf',
        lastActiveAt: later,
        headless: true,
        cwd: '/repo',
      },
      { sessionId: 'cwd-only', lastActiveAt: outside, cwd: '/repo' },
    ] as SessionView[]
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
      load: () => undefined,
      summaries: NAVIGATION_SUMMARIES,
      schedule: () => () => {},
    })
    pool.apply({
      type: 'replace',
      rows: [
        ...rows.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
        ...seats.map((value) => ({ kind: 'session' as const, id: value.sessionId, value })),
      ],
    })
    const provider = createPoolNavigationProvider(pool)
    try {
      expect(tracked(() => provider.activityAt('root'))).toBe(legacyActivity(rows, seats))
      expect(tracked(() => provider.activityAt('root'))).toBe(later)
      expect(tracked(() => provider.activityAt('leaf'))).toBe(later)
      expect(tracked(() => provider.activityAt('archived-owner'))).toBe(later)
      expect(tracked(() => provider.activityAt('absent'))).toBeUndefined()
      expect(pool.hydrate()).toBe(0)
      const newest = '2026-09-25T00:00:00.000Z'
      pool.apply({
        type: 'update',
        rows: [{ kind: 'issue', id: 'leaf', value: { ...rows[3]!, updatedAt: newest } }],
      })
      expect(tracked(() => provider.activityAt('root'))).toBe(newest)
    } finally {
      pool.dispose()
    }
  })

  it('loads missing cold activity facts in the ordinary batch', () => {
    const rows = [
      issue('root'),
      issue('hidden', { parentId: 'root', archived: true, updatedAt: '2026-09-25T00:00:00.000Z' }),
    ]
    const load = vi.fn((_kind: string, id: string) => rows.find((row) => row.id === id))
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
      load,
      summaries: MISSION_SUMMARIES,
      schedule: () => () => {},
    })
    pool.apply({
      type: 'replace',
      rows: rows.map((value) => ({ kind: 'issue', id: value.id, value })),
    })
    const provider = createPoolNavigationProvider(pool)
    try {
      expect(tracked(() => provider.activityAt('root'))).toBe(NAVIGATION_LOADING)
      expect(load).not.toHaveBeenCalled()
      expect(pool.hydrate()).toBe(1)
      expect(tracked(() => provider.activityAt('root'))).toBe(legacyActivity(rows, []))
      expect(load).toHaveBeenCalledExactlyOnceWith('issue', 'hidden')
    } finally {
      pool.dispose()
    }
  })

  it('always prepares navigation and combines declared cold fields with other screens', () => {
    const setNavigationProvider = vi.fn(),
      prepare = vi.fn(),
      stop = vi.fn()
    const screens = [
      {
        options: () => ({ settings: true }),
        prepare: () => {
          prepare()
          return stop
        },
      },
      panePoolScreen,
    ]
    const runtime = { setNavigationProvider } as never
    const detach = preparePoolScreens(screens, runtime)
    expect(screenOptions(screens, runtime)).toEqual({
      settings: true,
      summaries: NAVIGATION_SUMMARIES,
    })
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(setNavigationProvider).toHaveBeenCalledExactlyOnceWith(loadingNavigationProvider)
    detach()
    detach()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('installs the loading port before import and resumes navigation without any legacy read', async () => {
    const ctx = await startScenarioEngine(1, { start: false, ownRows: true })
    const runtime = ctx.engine
    const before = referenceState(runtime)
    before.navigation = fixtureNavigation({ issues: () => before.issueProjections, sessions: () => before.sessions })
    const seat = before.sessions.find(
      (session) =>
        !session.archived &&
        session.issueId &&
        before.issueProjections.some(
          (row) => row.id === session.issueId && !row.archived && !row.deletedAt,
        ),
    )!
    const target = before.issueProjections.find((row) => row.id === seat.issueId)!
    const expectedKey = workspaceKeyForState({ ...before, selectedIssueId: target.id })
    const errors = vi.fn()
    const detach = attachWorklistPool(runtime, errors)
    try {
      expect(resolvedWorkspaceKey({ ...referenceState(runtime), selectedIssueId: target.id })).toBe(
        NAVIGATION_LOADING,
      )
      expect(referenceState(runtime).navigateWorkspace({ selectedIssueId: target.id })).toBe(false)
      expect(referenceState(runtime).selectedIssueId).toBe(before.selectedIssueId)
      referenceState(runtime).navigateToSession(seat.sessionId)
      expect(referenceState(runtime).selectedIssueId).toBe(before.selectedIssueId)
      await vi.waitFor(() => {
        expect(errors).not.toHaveBeenCalled()
        expect(referenceState(runtime).selectedIssueId).toBe(target.id)
      })
      expect(referenceState(runtime).paneA).toBe(seat.sessionId)
      expect(referenceState(runtime).workspaceKey()).toBe(expectedKey)
      if (seat.displayRef) {
        referenceState(runtime).navigateToSession(seat.displayRef)
        expect(referenceState(runtime).paneA).toBe(seat.sessionId)
      }
      // The notice's Open chat action and eager read reaction use the same port.
      referenceState(runtime).navigateToSession(seat.sessionId)
      await vi.waitFor(() => expect(referenceState(runtime).paneA).toBe(seat.sessionId))
      expect(runtime.router.current().pane).toBe(seat.sessionId)
      expect(referenceState(runtime).workspaceKey()).toBe(expectedKey)
      expect(errors).not.toHaveBeenCalled()
    } finally {
      detach()
      runtime.destroy()
    }
  })

  it.each([
    1, 4,
  ])('keeps local birth refs canonical, including a cold ref through its declared summary (%ix history)', (scale) => {
    const seat = {
      sessionId: 'seat',
      displayRef: 'POD-529-A',
      archived: true,
      status: 'exited',
      cwd: '/repo',
      createdAt: stamp,
      lastActiveAt: stamp,
      stoppedAt: stamp,
      agentKind: 'codex',
    }
    const load = vi.fn((_kind: string, id: string) => (id === seat.sessionId ? seat : undefined))
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
      load,
      summaries: { session: ['displayRef'] },
      schedule: () => () => {},
    })
    pool.apply({
      type: 'replace',
      rows: [
        { kind: 'session', id: seat.sessionId, value: seat },
        ...Array.from({ length: 128 * scale }, (_, n) => ({
          kind: 'session' as const,
          id: `unrelated-${n}`,
          value: { ...seat, sessionId: `unrelated-${n}`, displayRef: `POD-${1000 + n}-A` },
        })),
      ],
    })
    const provider = createPoolNavigationProvider(pool)
    const questions = vi.spyOn(pool.coldIndex(), 'readerIds')
    const residentKeys = vi.spyOn(pool.tables.session, 'keys')
    try {
      expect(tracked(() => provider.session(seat.displayRef))).toBe(NAVIGATION_LOADING)
      expect(tracked(() => provider.session(`  ${seat.displayRef}  `))).toBe(NAVIGATION_LOADING)
      expect(load).not.toHaveBeenCalled()
      expect(questions).toHaveBeenCalledWith({ kind: 'sessionReference', ref: seat.displayRef })
      expect(questions.mock.calls.every(([question]) => question.kind === 'sessionReference')).toBe(
        true,
      )
      expect(residentKeys).not.toHaveBeenCalled()
      pool.hydrate()
      expect(load).toHaveBeenCalledTimes(1)
      expect(tracked(() => provider.session(`  ${seat.displayRef}  `))).toMatchObject({
        sessionId: seat.sessionId,
      })
      expect(tracked(() => provider.session('POD-530-A'))).toBeUndefined()
    } finally {
      pool.dispose()
    }
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
      expect(
        setNavigationProvider.mock.calls.every(
          ([provider]) => provider === loadingNavigationProvider,
        ),
      ).toBe(true)
    } finally {
      stopNext()
      pool.dispose()
    }
  })

  it('a newer navigation cancels the selection waiting for the pool import', async () => {
    const ctx = await startScenarioEngine(1, { start: false, ownRows: true })
    const runtime = ctx.engine
    const target = referenceState(runtime).issueProjections[0]!.id
    const detach = preparePoolScreens([panePoolScreen], runtime)
    try {
      referenceState(runtime).navigateWorkspace({ selectedIssueId: target })
      referenceState(runtime).setView('settings')
      const { createRuntimeWorklistPool } = await import('@podium/client-graph/runtime-pool')
      const handle = createRuntimeWorklistPool(runtime, { summaries: MISSION_SUMMARIES })
      try {
        runtime.setNavigationProvider(createPoolNavigationProvider(handle.pool))
        expect(referenceState(runtime).view).toBe('settings')
        expect(referenceState(runtime).selectedIssueId).not.toBe(target)
      } finally {
        runtime.setNavigationProvider(loadingNavigationProvider)
        handle.dispose()
      }
    } finally {
      detach()
      runtime.destroy()
    }
  })

  it('restores the current visit when the loading provider becomes ready', async () => {
    const ctx = await startScenarioEngine(1, { start: false, ownRows: true })
    const runtime = ctx.engine
    const { createRuntimeWorklistPool } = await import('@podium/client-graph/runtime-pool')
    const handle = createRuntimeWorklistPool(runtime, { summaries: MISSION_SUMMARIES })
    const target = asIssueId(ctx.targets.visibleRootId)
    const initial = referenceState(runtime)
    runtime.setNavigationProvider(fixtureNavigation({ issues: () => initial.issueProjections, sessions: () => initial.sessions, markers: () => initial.issueUserStates }))
    referenceState(runtime).setView('workspace')
    referenceState(runtime).setSelectedIssueId(target)
    expect(referenceState(runtime).issueVisitBaseline?.issueId).toBe(target)
    const detach = preparePoolScreens([panePoolScreen], runtime)
    try {
      expect(referenceState(runtime).issueVisitBaseline).toBeNull()
      runtime.setNavigationProvider(createPoolNavigationProvider(handle.pool))
      expect(referenceState(runtime).issueVisitBaseline?.issueId).toBe(target)
    } finally {
      detach()
      handle.dispose()
      runtime.destroy()
    }
  })

  it('follows a session rehome after pool delivery and preserves the active tab', async () => {
    {
      const ctx = await startScenarioEngine(1, { ownRows: true })
      const runtime = ctx.engine
      const { createRuntimeWorklistPool } = await import('@podium/client-graph/runtime-pool')
      const handle = createRuntimeWorklistPool(runtime, { summaries: MISSION_SUMMARIES })
      try {
        if (handle) runtime.setNavigationProvider(createPoolNavigationProvider(handle.pool))
        const st = referenceState(runtime)
        const seat = st.sessions.find(
          (row) =>
            !row.archived &&
            row.issueId &&
            st.issueProjections.some(
              (issue) => issue.id === row.issueId && !issue.archived && !issue.deletedAt,
            ),
        )!
        const sourceKey = workspaceKeyForState({ ...st, selectedIssueId: seat.issueId! })
        const target = st.issueProjections.find(
          (issue) =>
            !issue.archived &&
            !issue.deletedAt &&
            workspaceKeyForState({ ...st, selectedIssueId: issue.id }) !== sourceKey,
        )!
        referenceState(runtime).navigateToSession(seat.sessionId)
        await vi.waitFor(() => expect(referenceState(runtime).paneA).toBe(seat.sessionId))
        const raw = ctx.cache.read('session', seat.sessionId)!.value as object
        upsert(ctx, 'session', seat.sessionId, { ...raw, issueId: target.id })
        await vi.waitFor(() => expect(referenceState(runtime).selectedIssueId).toBe(target.id))
        expect(referenceState(runtime).paneA).toBe(seat.sessionId)
        expect(runtime.router.current().pane).toBe(seat.sessionId)
        expect(
          Object.values(referenceState(runtime).workspaces[sourceKey]?.panes ?? {}).flatMap(
            (pane) => pane.tabs,
          ),
        ).not.toContain(seat.sessionId)
      } finally {
        runtime.setNavigationProvider(loadingNavigationProvider)
        handle?.dispose()
        runtime.destroy()
      }
    }
  })

  it('watches navigation fields without waking for display metadata', async () => {
    const ctx = await startScenarioEngine(1, { start: false, ownRows: true })
    const runtime = ctx.engine
    const target = asIssueId(ctx.targets.visibleRootId)
    referenceState(runtime).navigateWorkspace({ selectedIssueId: target })
    const { createRuntimeWorklistPool } = await import('@podium/client-graph/runtime-pool')
    const handle = createRuntimeWorklistPool(runtime, { summaries: MISSION_SUMMARIES })
    runtime.setNavigationProvider(createPoolNavigationProvider(handle.pool))
    const turn = () => new Promise((resolve) => setTimeout(resolve, 0))
    await turn()
    const reactions = (
      runtime as unknown as {
        reactions: {
          updateIssueVisitBaseline(): void
          updateIssueMarkReadTimer(): void
          updateMarkReadTimer(): void
        }
      }
    ).reactions
    const spies = [
      'updateIssueVisitBaseline',
      'updateIssueMarkReadTimer',
      'updateMarkReadTimer',
    ].map((name) => vi.spyOn(reactions, name as keyof typeof reactions))
    try {
      const row = tracked(() => handle.pool.row('issue', target)) as SliceIssue
      handle.pool.apply({
        type: 'update',
        rows: [{ kind: 'issue', id: target, value: { ...row, title: 'Changed display title' } }],
      })
      await turn()
      expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0])
      handle.pool.apply({
        type: 'update',
        rows: [{ kind: 'issue', id: target, value: { ...row, updatedAt: ctx.stamp() } }],
      })
      await vi.waitFor(() => expect(spies[0]).toHaveBeenCalled())
    } finally {
      spies.forEach((spy) => {
        spy.mockRestore()
      })
      runtime.setNavigationProvider(loadingNavigationProvider)
      handle.dispose()
      runtime.destroy()
    }
  })

  it('matches navigation plans for every issue in the operator-sized synthetic corpus', async () => {
    const ctx = await startScenarioEngine(1, { start: false, ownRows: true })
    const runtime = ctx.engine
    const { createRuntimeWorklistPool } = await import('@podium/client-graph/runtime-pool')
    const handle = createRuntimeWorklistPool(runtime, { summaries: NAVIGATION_SUMMARIES })
    const provider = createPoolNavigationProvider(handle.pool)
    try {
      const st = referenceState(runtime)
      st.navigation = fixtureNavigation({ issues: () => st.issueProjections, sessions: () => st.sessions, markers: () => st.issueUserStates })
      const check = (id: string) =>
        tracked(() =>
          planNavigation(
            { ...st, navigation: provider },
            routeDefaults('issues'),
            { view: 'workspace', selectedIssueId: asIssueId(id) },
            { visible: true, now: stamp },
          ),
        )
      for (const issue of st.issueProjections) check(issue.id)
      for (let i = 0; i < 32 && handle.pool.hydrate() > 0; i++) {
        for (const issue of st.issueProjections) check(issue.id)
      }
      let differences = 0
      for (const issue of st.issueProjections) {
        const expected = planNavigation(
          st,
          routeDefaults('issues'),
          { view: 'workspace', selectedIssueId: issue.id },
          { visible: true, now: stamp },
        )
        const actual = check(issue.id)
        if (JSON.stringify(actual) !== JSON.stringify(expected)) differences++
        if (
          tracked(() => provider.activityAt(issue.id)) !==
          issueActivityAt(issue, st.sessions, st.issueProjections)
        )
          differences++
        expect(tracked(() => provider.issueReadAt(issue.id)) ?? null).toBe(
          st.issueUserStates.find((row) => row.entityId === issue.id)?.readAt ?? null,
        )
      }
      expect(differences).toBe(0)
    } finally {
      handle.dispose()
      runtime.destroy()
    }
  }, 60_000)
})
