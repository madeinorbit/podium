import { asIssueId, asSessionId, type IssueProjection } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionView } from '../session-values'
import { routeDefaults } from '../ui-state'
import { emptyWorkspace, openTab, splitPane } from '../viewmodels'
import { createEngineActions } from './actions'
import { planNavigation } from './navigation'
import { Reactions } from './reactions'
import {
  type EngineState,
  loadingNavigationProvider,
  NAVIGATION_LOADING,
  type NavigationProvider,
  navigationStats,
  resolvedWorkspaceKey,
  workspaceKeyForState,
} from './state'

const stamp = '2026-09-18T00:00:00.000Z'
const context = { visible: true, now: stamp }
const root = { id: asIssueId('root'), updatedAt: stamp } as IssueProjection
const child = { id: asIssueId('child'), parentId: root.id, updatedAt: stamp } as IssueProjection
const seat = {
  sessionId: asSessionId('seat'),
  issueId: child.id,
  cwd: '/repo',
  lastActiveAt: stamp,
  unread: true,
} as SessionView
const provider: NavigationProvider = {
  issue: (id) => (id === root.id ? root : id === child.id ? child : undefined),
  missionRoot: () => root.id,
  missionMembers: () => new Set([root.id, child.id]),
  session: (id) => (id === seat.sessionId ? seat : undefined),
  activityAt: () => stamp,
  issueReadAt: () => null,
}
const state = (navigation?: NavigationProvider) =>
  ({
    navigation,
    issueProjections: [root, child],
    issueUserStates: [],
    issueDeps: [],
    sessions: [seat],
    repos: [],
    selectedIssueId: null,
    selectedWorktree: '/repo',
    workspaces: {},
    paneA: null,
    paneB: null,
    focusedPane: 'A',
    split: false,
    fileTabs: [],
    recentFiles: [],
    view: 'issues',
    settingsTab: null,
    openIssueId: null,
    issueVisitBaseline: null,
  }) as unknown as EngineState
afterEach(() => {
  navigationStats.disable()
  navigationStats.reset()
})

describe('addressed workspace pruning', () => {
  const file = (id: string, sessionId: string) => ({
    id,
    scope: { kind: 'session' as const, sessionId: asSessionId(sessionId) },
    path: 'notes.txt',
    worktreePath: '/repo',
  })
  function reaction(st: EngineState) {
    return new Reactions({
      state: () => st,
      publish: (patch) => Object.assign(st, patch),
      hub: {} as never,
      notices: {} as never,
      isVisible: () => true,
      markSessionRead: vi.fn(),
      markIssueRead: vi.fn(),
      pruneGraceMs: 20,
    })
  }

  it('keeps the same membership, spawn and grace results without reading legacy lists', () => {
    vi.useFakeTimers()
    const foreign = { ...seat, sessionId: asSessionId('foreign'), issueId: asIssueId('other') }
    const rows = [seat, foreign, { ...seat, sessionId: asSessionId('unreferenced') }]
    const reads = vi.fn((id: string) => rows.find((row) => row.sessionId === id))
    const make = (navigation?: NavigationProvider) => {
      let ws = emptyWorkspace('mission:root')
      for (const id of [
        seat.sessionId,
        foreign.sessionId,
        'ghost',
        'pending',
        'file:live',
        'file:gone',
      ])
        ws = openTab(ws, id, { permanent: true })
      return {
        ...state(navigation),
        sessions: rows,
        pendingSpawnIds: new Set([asSessionId('pending')]),
        selectedIssueId: child.id,
        workspaces: { 'mission:root': ws },
        fileTabs: [file('file:live', seat.sessionId), file('file:gone', 'missing')],
      }
    }
    const legacy = make(),
      addressed = make({ ...provider, session: reads })
    for (const key of ['sessions', 'issueProjections', 'issueDeps'])
      Object.defineProperty(addressed, key, {
        get() {
          throw new Error(`Legacy pruning read: ${key}`)
        },
      })
    const eager = reaction(legacy),
      pool = reaction(addressed)
    try {
      eager.pruneWorkspaces()
      pool.pruneWorkspaces()
      expect(addressed.workspaces).toEqual(legacy.workspaces)
      expect(addressed.fileTabs).toEqual(legacy.fileTabs)
      expect(reads.mock.calls.flat()).not.toContain('unreferenced')
      vi.advanceTimersByTime(25)
      expect(addressed.workspaces).toEqual(legacy.workspaces)
      expect(addressed.fileTabs).toEqual([file('file:live', seat.sessionId)])
      expect(JSON.stringify(addressed.workspaces)).not.toContain('foreign')
      expect(JSON.stringify(addressed.workspaces)).not.toContain('ghost')
      expect(JSON.stringify(addressed.workspaces)).toContain('pending')
    } finally {
      eager.dispose()
      pool.dispose()
      vi.useRealTimers()
    }
  })

  it('holds cold sessions and their file scopes without starting the missing-row grace clock', () => {
    vi.useFakeTimers()
    let ready = false
    const cold = asSessionId('cold')
    const row = { ...seat, sessionId: cold }
    const st = {
      ...state({
        ...provider,
        session: (id) => (id === cold ? (ready ? row : NAVIGATION_LOADING) : undefined),
      }),
      pendingSpawnIds: new Set<ReturnType<typeof asSessionId>>(),
      selectedIssueId: child.id,
      workspaces: {
        'mission:root': openTab(
          openTab(emptyWorkspace('mission:root'), cold, { permanent: true }),
          'file:cold',
          { permanent: true },
        ),
      },
      fileTabs: [file('file:cold', cold)],
    }
    Object.defineProperty(st, 'sessions', {
      get() {
        throw new Error('Legacy cold pruning')
      },
    })
    const owner = reaction(st)
    try {
      const before = st.workspaces
      owner.pruneWorkspaces()
      vi.advanceTimersByTime(100)
      owner.pruneWorkspaces()
      expect(st.workspaces).toEqual(before)
      expect(st.fileTabs).toEqual([file('file:cold', cold)])
      ready = true
      owner.pruneWorkspaces()
      expect(st.workspaces).toEqual(before)
    } finally {
      owner.dispose()
      vi.useRealTimers()
    }
  })

  it('resolves an issue workspace through the provider, including unassigned sessions', () => {
    const unassigned = { ...seat, issueId: undefined }
    const st = {
      ...state({
        ...provider,
        issue: () => ({ ...root, worktreePath: '/repo' }),
        session: () => unassigned,
      }),
      pendingSpawnIds: new Set<ReturnType<typeof asSessionId>>(),
      workspaces: {
        'issue:root': openTab(emptyWorkspace('issue:root'), seat.sessionId, { permanent: true }),
      },
    }
    for (const key of ['sessions', 'issueProjections'])
      Object.defineProperty(st, key, {
        get() {
          throw new Error(`Legacy issue pruning: ${key}`)
        },
      })
    const owner = reaction(st)
    try {
      owner.pruneWorkspaces()
      expect(st.workspaces['issue:root']?.panes.p1?.tabs).toEqual([seat.sessionId])
    } finally {
      owner.dispose()
    }
  })
})

describe('addressed worktree reactions', () => {
  const rows = [
    { ...seat, name: 'Foreground' },
    { ...seat, sessionId: asSessionId('background'), name: 'Background' },
    { ...seat, sessionId: asSessionId('subdir'), name: 'Subdirectory' },
  ]
  const make = (sessions: SessionView[], navigation?: NavigationProvider) => ({
    ...state(navigation),
    sessions,
    pendingSpawnIds: new Set<ReturnType<typeof asSessionId>>(),
    reposLoaded: true,
    view: 'workspace' as const,
    repos: [{ path: '/repo', kind: 'repository' as const, worktrees: [{ path: '/dest' }] }],
  })
  const owner = (st: EngineState, info = vi.fn()) =>
    new Reactions({
      state: () => st,
      publish: (patch) => Object.assign(st, patch),
      hub: {} as never,
      notices: { info } as never,
      isVisible: () => true,
      markSessionRead: vi.fn(),
      markIssueRead: vi.fn(),
    })
  const forbidSessions = (st: EngineState) =>
    Object.defineProperty(st, 'sessions', {
      get() {
        throw new Error('Legacy worktree list read')
      },
    })

  it('keeps third-pane following and background notices equal using only pool summaries', () => {
    const moved = rows.map((row, at) => ({ ...row, cwd: at === 2 ? '/repo/nested' : '/dest' }))
    const legacy = make(moved),
      addressed = make(moved, { ...provider, worktreeSessions: () => moved })
    let ws = openTab(emptyWorkspace(workspaceKeyForState(legacy)), 'first', { permanent: true })
    ws = splitPane(ws, ws.focusedPaneId, 'row')
    ws = openTab(ws, 'second', { permanent: true })
    ws = splitPane(ws, ws.focusedPaneId, 'row')
    ws = openTab(ws, seat.sessionId, { permanent: true })
    legacy.workspaces = addressed.workspaces = { [ws.key]: ws }
    const eagerNotices = vi.fn(),
      poolNotices = vi.fn()
    const eager = owner(legacy, eagerNotices),
      pool = owner(addressed, poolNotices)
    eager.seedCwds(rows)
    pool.seedCwds(rows)
    forbidSessions(addressed)
    try {
      expect(eager.worktreeFollow()).toBe(true)
      expect(pool.worktreeFollow()).toBe(true)
      expect(addressed.selectedWorktree).toBe(legacy.selectedWorktree)
      expect(addressed.selectedWorktree).toBe('/dest')
      expect(poolNotices.mock.calls).toEqual(eagerNotices.mock.calls)
      expect(poolNotices).toHaveBeenCalledExactlyOnceWith('Background moved worktree', '/dest')
    } finally {
      eager.dispose()
      pool.dispose()
    }
  })

  it('preserves fallback containment, registered worktrees and absent selections without legacy reads', () => {
    for (const selectedWorktree of ['/repo', '/dest', '/unlisted', '/gone']) {
      const anchored = [{ ...seat, cwd: '/unlisted/nested' }]
      const legacy = { ...make(anchored), selectedWorktree }
      const addressed = {
        ...make(anchored, { ...provider, worktreeSessions: () => anchored }),
        selectedWorktree,
      }
      const eager = owner(legacy),
        pool = owner(addressed)
      forbidSessions(addressed)
      try {
        expect(eager.worktreeFallback()).toBe(true)
        expect(pool.worktreeFallback()).toBe(true)
        expect(addressed.selectedWorktree).toBe(legacy.selectedWorktree)
      } finally {
        eager.dispose()
        pool.dispose()
      }
    }
  })

  it('waits for cold summaries without losing a move or falling back while loading', () => {
    let ready = false
    const moved = [{ ...seat, cwd: '/dest', name: 'Foreground' }]
    const st = make(moved, {
      ...provider,
      worktreeSessions: () => (ready ? moved : NAVIGATION_LOADING),
    })
    st.paneA = seat.sessionId
    const pool = owner(st)
    pool.seedCwds(rows)
    forbidSessions(st)
    try {
      expect(pool.worktreeFollow()).toBe(false)
      expect(st.selectedWorktree).toBe('/repo')
      st.selectedWorktree = '/unlisted'
      expect(pool.worktreeFallback()).toBe(false)
      expect(st.selectedWorktree).toBe('/unlisted')
      st.selectedWorktree = '/repo'
      ready = true
      expect(pool.worktreeFollow()).toBe(true)
      expect(st.selectedWorktree).toBe('/dest')
    } finally {
      pool.dispose()
    }
  })
})

describe('navigation with an injected pool provider', () => {
  it('preserves selection, mission tabs, URL, history and visit baseline across switches', () => {
    let legacy = state(),
      pool = state(provider),
      route = routeDefaults('issues')
    const intents = [
      {
        view: 'workspace' as const,
        selectedIssueId: child.id,
        tabId: seat.sessionId,
        firstPane: true,
      },
      { view: 'workspace' as const, selectedIssueId: root.id, tabId: 'second' },
      { view: 'workspace' as const, selectedIssueId: asIssueId('sessionless') },
      { view: 'workspace' as const, selectedIssueId: child.id },
      { view: 'settings' as const },
      { view: 'workspace' as const, selectedIssueId: root.id, history: 'push' as const },
    ]
    for (const intent of intents) {
      const expected = planNavigation(legacy, route, intent, context)
      const actual = planNavigation(pool, route, intent, context)
      expect(actual).toEqual(expected)
      legacy = { ...legacy, ...expected.patch }
      pool = { ...pool, ...actual.patch }
      route = expected.route
    }
    expect(pool.workspaces['mission:root']?.panes).toEqual(legacy.workspaces['mission:root']?.panes)
  })

  it('keeps split focus and pane-A URL while replacing a preview and retiring a file', () => {
    const file = {
      id: 'file:old',
      scope: { kind: 'session' as const, sessionId: seat.sessionId },
      path: 'old',
      worktreePath: '/repo',
    }
    const next = { ...file, id: 'file:new', path: 'new' }
    let ws = openTab(emptyWorkspace('mission:root'), 'left', { permanent: true })
    ws = splitPane(ws, ws.focusedPaneId, 'row')
    ws = { ...ws, focusedPaneId: Object.keys(ws.panes)[1]! }
    ws = openTab(ws, file.id, { permanent: false })
    const legacy = {
      ...state(),
      selectedIssueId: child.id,
      workspaces: { 'mission:root': ws },
      fileTabs: [file],
    }
    const intent = {
      view: 'workspace' as const,
      tabId: next.id,
      fileTab: next,
      permanent: false,
      retireOrphanFiles: true,
    }
    const expected = planNavigation(legacy, routeDefaults('issues'), intent, context)
    const actual = planNavigation(
      { ...legacy, navigation: provider },
      routeDefaults('issues'),
      intent,
      context,
    )
    expect(actual).toEqual(expected)
    expect(actual.patch).toMatchObject({
      paneA: 'left',
      paneB: next.id,
      focusedPane: 'B',
      split: true,
      fileTabs: [next],
    })
    expect(actual.route.pane).toBe('left')
  })

  it('counts zero legacy reads even when an optimistic overlay replaces the issue array', () => {
    navigationStats.enable()
    const st = state(provider)
    st.selectedIssueId = child.id
    for (let i = 0; i < 3; i++) {
      st.issueProjections = [...st.issueProjections]
      const find = vi.spyOn(st.issueProjections, 'find').mockImplementation(() => {
        throw new Error('legacy issue scan')
      })
      expect(workspaceKeyForState(st)).toBe('mission:root')
      expect(
        planNavigation(
          st,
          routeDefaults('workspace'),
          { view: 'workspace', tabId: seat.sessionId },
          context,
        ).pending,
      ).toBe(false)
      expect(find).not.toHaveBeenCalled()
    }
    expect(navigationStats.read()).toEqual({ issuesFind: 0, missionRootFor: 0, sessionById: 0 })
    workspaceKeyForState({ ...state(), selectedIssueId: child.id })
    expect(navigationStats.read()).toMatchObject({ issuesFind: 1, missionRootFor: 1 })
  })

  it('never commits a cold or pre-import selection to a fallback workspace', () => {
    navigationStats.enable()
    const st = state(loadingNavigationProvider)
    const intent = { view: 'workspace' as const, selectedIssueId: child.id, tabId: seat.sessionId }
    const route = routeDefaults('issues')
    expect(resolvedWorkspaceKey({ ...st, selectedIssueId: child.id })).toBe(NAVIGATION_LOADING)
    expect(planNavigation(st, route, intent, context)).toMatchObject({
      pending: true,
      patch: {},
      route,
    })
    expect(navigationStats.read()).toEqual({ issuesFind: 0, missionRootFor: 0, sessionById: 0 })
  })

  it('marks an opened session read through the provider, including the timer guard', () => {
    navigationStats.enable()
    const st = {
      ...state(provider),
      view: 'workspace' as const,
      selectedIssueId: child.id,
      paneA: seat.sessionId,
    }
    const markSessionRead = vi.fn()
    const reactions = new Reactions({
      state: () => st,
      publish: (patch) => Object.assign(st, patch),
      hub: {} as never,
      notices: {} as never,
      isVisible: () => true,
      markSessionRead,
      markIssueRead: vi.fn(),
    })
    try {
      reactions.updateMarkReadTimer()
      expect(markSessionRead).toHaveBeenCalledExactlyOnceWith(seat.sessionId)
      expect(navigationStats.read()).toEqual({ issuesFind: 0, missionRootFor: 0, sessionById: 0 })
    } finally {
      reactions.dispose()
    }
  })

  it('uses pool read cursors and waits for cold activity without scanning legacy rows', () => {
    let ready = false
    const cursor = '2026-09-17T00:00:00.000Z'
    const st = {
      ...state({
        ...provider,
        activityAt: () => (ready ? stamp : NAVIGATION_LOADING),
        issueReadAt: () => cursor,
      }),
      view: 'workspace' as const,
      selectedIssueId: child.id,
    }
    vi.spyOn(st.issueProjections, Symbol.iterator).mockImplementation(() => {
      throw new Error('legacy activity issues')
    })
    vi.spyOn(st.sessions, Symbol.iterator).mockImplementation(() => {
      throw new Error('legacy activity sessions')
    })
    vi.spyOn(st.issueUserStates, 'find').mockImplementation(() => {
      throw new Error('legacy read cursor')
    })
    const markIssueRead = vi.fn()
    const reactions = new Reactions({
      state: () => st,
      publish: (patch) => Object.assign(st, patch),
      hub: {} as never,
      notices: {} as never,
      isVisible: () => true,
      markSessionRead: vi.fn(),
      markIssueRead,
    })
    try {
      const plan = planNavigation(st, routeDefaults('workspace'), { view: 'workspace' }, context)
      expect(plan.patch.issueVisitBaseline?.readAt).toBe(cursor)
      reactions.updateIssueVisitBaseline()
      expect(st.issueVisitBaseline?.readAt).toBe(cursor)
      reactions.updateIssueMarkReadTimer()
      expect(markIssueRead).not.toHaveBeenCalled()
      ready = true
      reactions.updateIssueMarkReadTimer()
      expect(markIssueRead).toHaveBeenCalledExactlyOnceWith(child.id)
    } finally {
      reactions.dispose()
    }
  })

  it('keeps a rehome pending until its pool mission root is loaded', () => {
    navigationStats.enable()
    const target = { ...root, id: asIssueId('destination') }
    const moved = { ...seat, issueId: target.id }
    let ready = false
    const navigation: NavigationProvider = {
      ...provider,
      issue: (id) => (id === target.id ? target : provider.issue(id)),
      missionRoot: (id) => (id === target.id ? (ready ? target.id : NAVIGATION_LOADING) : root.id),
      session: () => moved,
    }
    const st = {
      ...state(navigation),
      sessions: [moved],
      selectedIssueId: child.id,
      paneA: seat.sessionId,
    }
    const reactions = new Reactions({
      state: () => st,
      publish: (patch) => Object.assign(st, patch),
      hub: {} as never,
      notices: {} as never,
      isVisible: () => true,
      markSessionRead: vi.fn(),
      markIssueRead: vi.fn(),
    })
    reactions.seedIssueIds([seat])
    Object.defineProperty(st, 'sessions', {
      get() {
        throw new Error('Legacy focused ownership list')
      },
    })
    try {
      expect(reactions.sessionIssueFollow()).toBe(false)
      expect(st.selectedIssueId).toBe(child.id)
      expect(st.paneA).toBe(seat.sessionId)
      ready = true
      expect(reactions.sessionIssueFollow()).toBe(true)
      expect(st.selectedIssueId).toBe(target.id)
      expect(st.paneA).toBe(seat.sessionId)
      expect(workspaceKeyForState(st)).toBe(`mission:${target.id}`)
      expect(navigationStats.read()).toEqual({ issuesFind: 0, missionRootFor: 0, sessionById: 0 })
    } finally {
      reactions.dispose()
    }
  })

  it('resumes a server-resolved short session link when its pool row is cold', async () => {
    navigationStats.enable()
    let ready = false
    const st = state({
      ...provider,
      session: (id) => (id === seat.sessionId ? (ready ? seat : NAVIGATION_LOADING) : undefined),
    })
    const navigate = vi.fn(),
      waitForSessionNavigation = vi.fn()
    const resolve = vi.fn().mockResolvedValue({ kind: 'session', sessionId: seat.sessionId })
    const actions = createEngineActions({
      state: () => st,
      navigate,
      waitForSessionNavigation,
      api: { sessions: { resolve: { query: resolve } } },
      notices: { error: vi.fn() },
    } as never)
    actions.navigateToSession('abcdef')
    await vi.waitFor(() =>
      expect(waitForSessionNavigation).toHaveBeenCalledExactlyOnceWith(seat.sessionId),
    )
    expect(navigate).not.toHaveBeenCalled()
    ready = true
    actions.navigateToSession(seat.sessionId)
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: seat.sessionId, selectedIssueId: child.id }),
    )
    expect(navigationStats.read()).toEqual({ issuesFind: 0, missionRootFor: 0, sessionById: 0 })
  })
})
