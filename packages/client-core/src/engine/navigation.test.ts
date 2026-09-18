import { asIssueId, asSessionId, type IssueWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { routeDefaults } from '../ui-state'
import { emptyWorkspace, openTab, splitPane } from '../viewmodels'
import { planNavigation } from './navigation'
import { type EngineState, workspaceMirrorPatch } from './state'

const context = { visible: true, now: '2026-09-18T00:00:00.000Z' }
const issue = { id: asIssueId('issue'), readAt: null, archived: false } as IssueWire
function state(): EngineState {
  return { issues: [issue], selectedIssueId: null, selectedWorktree: '/repo', workspaces: {},
    paneA: null, paneB: null, focusedPane: 'A', split: false, fileTabs: [], recentFiles: [],
    view: 'issues', settingsTab: null, openIssueId: null, issueVisitBaseline: null } as unknown as EngineState
}

describe('pure navigation plan', () => {
  it('computes selection, layout, canonical URL and pre-read baseline without mutating the input', () => {
    const before = state()
    const copy = structuredClone(before)
    const plan = planNavigation(before, routeDefaults('issues'), {
      view: 'workspace', selectedIssueId: issue.id, tabId: 'session', firstPane: true,
    }, context)
    expect(before).toEqual(copy)
    expect(plan.patch).toMatchObject({ selectedIssueId: issue.id, paneA: 'session', split: false,
      issueVisitBaseline: { issueId: issue.id, readAt: null, openedAt: context.now } })
    expect(plan.route).toMatchObject({ view: 'workspace', worktree: '/repo', pane: 'session' })
    expect(plan.replace).toBe(false)
    const final = { ...before, ...plan.patch }
    const repeat = planNavigation(final, plan.route, {
      view: 'workspace', selectedIssueId: issue.id, tabId: 'session', firstPane: true,
    }, context)
    expect(Object.entries(repeat.patch).every(([key, value]) => Object.is(final[key as keyof EngineState], value))).toBe(true)
  })

  it('restores a sessionless issue workspace without persisting an empty layout', () => {
    const before = state()
    const plan = planNavigation(before, routeDefaults('workspace'), {
      view: 'workspace', selectedIssueId: issue.id,
    }, context)
    expect(plan.patch.workspaces).toBeUndefined()
    expect(plan.patch).toMatchObject({ paneA: null, paneB: null, split: false })
    expect(plan.replace).toBe(true)
  })

  it('opens into the focused split pane while the URL continues to mirror pane A', () => {
    const before = state()
    let ws = openTab(emptyWorkspace('wt:/repo'), 'left', { permanent: true })
    ws = splitPane(ws, ws.focusedPaneId, 'row')
    // Select the second leaf explicitly so the fixture is independent of split focus policy.
    const second = Object.keys(ws.panes)[1]!
    ws = { ...ws, focusedPaneId: second }
    before.workspaces = { 'wt:/repo': ws }
    const plan = planNavigation(before, routeDefaults('issues'), {
      view: 'workspace', tabId: 'right', history: 'push',
    }, context)
    expect(plan.patch).toMatchObject({ paneA: 'left', paneB: 'right', focusedPane: 'B', split: true })
    expect(plan.route.pane).toBe('left')
    expect(workspaceMirrorPatch(plan.patch.workspaces!['wt:/repo']!)).toMatchObject({ paneA: 'left', paneB: 'right' })
  })

  it('retains the original visit cursor and clears it when leaving the foreground', () => {
    const before = state()
    before.selectedIssueId = issue.id
    before.issueVisitBaseline = { issueId: issue.id, readAt: null, openedAt: context.now }
    expect(planNavigation(before, routeDefaults('workspace'), { view: 'workspace' }, context).patch.issueVisitBaseline).toBe(before.issueVisitBaseline)
    expect(planNavigation(before, routeDefaults('workspace'), { view: 'settings' }, context).patch.issueVisitBaseline).toBeNull()
    expect(planNavigation(before, routeDefaults('workspace'), { view: 'workspace' }, { ...context, visible: false }).patch.issueVisitBaseline).toBeNull()
  })

  it('plans a preview replacement and file retirement together', () => {
    const before = state()
    const first = { id: 'file:old', scope: { kind: 'session' as const, sessionId: asSessionId('s') }, path: 'old', worktreePath: '/repo' }
    const next = { ...first, id: 'file:new', path: 'new' }
    before.fileTabs = [first]
    before.workspaces = { 'wt:/repo': openTab(emptyWorkspace('wt:/repo'), first.id, { permanent: false }) }
    const plan = planNavigation(before, routeDefaults('issues'), { view: 'workspace', tabId: next.id,
      fileTab: next, permanent: false, retireOrphanFiles: true }, context)
    expect(plan.patch.fileTabs).toEqual([next])
    expect(plan.patch.paneA).toBe(next.id)
    expect(before.fileTabs).toEqual([first])
  })
})
