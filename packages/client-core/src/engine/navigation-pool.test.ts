import { asIssueId, asSessionId, type IssueProjection } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionView } from '../session-values'
import { routeDefaults } from '../ui-state'
import { emptyWorkspace, openTab, splitPane } from '../viewmodels'
import { planNavigation } from './navigation'
import { Reactions } from './reactions'
import {
  type EngineState, type NavigationProvider, loadingNavigationProvider,
  NAVIGATION_LOADING, navigationStats, resolvedWorkspaceKey, workspaceKeyForState,
} from './state'

const stamp = '2026-09-18T00:00:00.000Z'
const context = { visible: true, now: stamp }
const root = { id: asIssueId('root'), updatedAt: stamp } as IssueProjection
const child = { id: asIssueId('child'), parentId: root.id, updatedAt: stamp } as IssueProjection
const seat = { sessionId: asSessionId('seat'), issueId: child.id, cwd: '/repo', lastActiveAt: stamp, unread: true } as SessionView
const provider: NavigationProvider = {
  issue: id => id === root.id ? root : id === child.id ? child : undefined,
  missionRoot: () => root.id,
  session: id => id === seat.sessionId ? seat : undefined,
}
const state = (navigation?: NavigationProvider) => ({
  navigation, issueProjections: [root, child], issueUserStates: [], issueDeps: [], sessions: [seat],
  selectedIssueId: null, selectedWorktree: '/repo', workspaces: {}, paneA: null, paneB: null,
  focusedPane: 'A', split: false, fileTabs: [], recentFiles: [], view: 'issues',
  settingsTab: null, openIssueId: null, issueVisitBaseline: null,
} as unknown as EngineState)
afterEach(() => { navigationStats.disable(); navigationStats.reset() })

describe('navigation with an injected pool provider', () => {
  it('preserves selection, mission tabs, URL, history and visit baseline across switches', () => {
    let legacy = state(), pool = state(provider), route = routeDefaults('issues')
    const intents = [
      { view: 'workspace' as const, selectedIssueId: child.id, tabId: seat.sessionId, firstPane: true },
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
    const file = { id: 'file:old', scope: { kind: 'session' as const, sessionId: seat.sessionId }, path: 'old', worktreePath: '/repo' }
    const next = { ...file, id: 'file:new', path: 'new' }
    let ws = openTab(emptyWorkspace('mission:root'), 'left', { permanent: true })
    ws = splitPane(ws, ws.focusedPaneId, 'row')
    ws = { ...ws, focusedPaneId: Object.keys(ws.panes)[1]! }
    ws = openTab(ws, file.id, { permanent: false })
    const legacy = { ...state(), selectedIssueId: child.id, workspaces: { 'mission:root': ws }, fileTabs: [file] }
    const intent = { view: 'workspace' as const, tabId: next.id, fileTab: next, permanent: false, retireOrphanFiles: true }
    const expected = planNavigation(legacy, routeDefaults('issues'), intent, context)
    const actual = planNavigation({ ...legacy, navigation: provider }, routeDefaults('issues'), intent, context)
    expect(actual).toEqual(expected)
    expect(actual.patch).toMatchObject({ paneA: 'left', paneB: next.id, focusedPane: 'B', split: true, fileTabs: [next] })
    expect(actual.route.pane).toBe('left')
  })

  it('counts zero legacy reads even when an optimistic overlay replaces the issue array', () => {
    navigationStats.enable()
    const st = state(provider)
    st.selectedIssueId = child.id
    for (let i = 0; i < 3; i++) {
      st.issueProjections = [...st.issueProjections]
      const find = vi.spyOn(st.issueProjections, 'find').mockImplementation(() => { throw new Error('legacy issue scan') })
      expect(workspaceKeyForState(st)).toBe('mission:root')
      expect(planNavigation(st, routeDefaults('workspace'), { view: 'workspace', tabId: seat.sessionId }, context).pending).toBe(false)
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
    expect(planNavigation(st, route, intent, context)).toMatchObject({ pending: true, patch: {}, route })
    expect(navigationStats.read()).toEqual({ issuesFind: 0, missionRootFor: 0, sessionById: 0 })
  })

  it('marks an opened session read through the provider, including the timer guard', () => {
    navigationStats.enable()
    const st = { ...state(provider), view: 'workspace' as const, selectedIssueId: child.id, paneA: seat.sessionId }
    const markSessionRead = vi.fn()
    const reactions = new Reactions({ state: () => st, publish: patch => Object.assign(st, patch),
      hub: {} as never, notices: {} as never, isVisible: () => true, markSessionRead, markIssueRead: vi.fn() })
    try {
      reactions.updateMarkReadTimer()
      expect(markSessionRead).toHaveBeenCalledExactlyOnceWith(seat.sessionId)
      expect(navigationStats.read()).toEqual({ issuesFind: 0, missionRootFor: 0, sessionById: 0 })
    } finally { reactions.dispose() }
  })

  it('keeps a rehome pending until its pool mission root is loaded', () => {
    navigationStats.enable()
    const target = { ...root, id: asIssueId('destination') }
    const moved = { ...seat, issueId: target.id }
    let ready = false
    const navigation: NavigationProvider = {
      issue: id => id === target.id ? target : provider.issue(id),
      missionRoot: id => id === target.id ? ready ? target.id : NAVIGATION_LOADING : root.id,
      session: () => moved,
    }
    const st = { ...state(navigation), sessions: [moved], selectedIssueId: child.id, paneA: seat.sessionId }
    const reactions = new Reactions({ state: () => st, publish: patch => Object.assign(st, patch),
      hub: {} as never, notices: {} as never, isVisible: () => true, markSessionRead: vi.fn(), markIssueRead: vi.fn() })
    reactions.seedIssueIds([seat])
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
    } finally { reactions.dispose() }
  })
})
