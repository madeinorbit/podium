import { asIssueId, asSessionId, type IssueProjection } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureNavigation } from '../../test-support/navigation'
import { MarkReadService } from '../runtime-root/services/mark-read-service'
import { planNavigation } from '../ui/navigation'
import { routeDefaults } from '../ui-state'
import { emptyWorkspace, openTab, splitPane } from '../values'
import { type RuntimeState, workspaceMirrorPatch } from './state'

const context = { visible: true, now: '2026-09-18T00:00:00.000Z' }
const issue = { id: asIssueId('issue'), archived: false } as IssueProjection
function state(): RuntimeState {
  return {
    navigation: fixtureNavigation({ issues: () => [issue], sessions: () => [] }),
    issueProjections: [issue],
    issueUserStates: [],
    issueDeps: [],
    sessions: [],
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
  } as unknown as RuntimeState
}

describe('pure navigation plan', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(context.now)
  })
  afterEach(() => vi.useRealTimers())
  it('computes selection, layout, canonical URL and pre-read baseline without mutating the input', () => {
    const before = state()
    const { navigation, ...data } = before
    const copy = { ...structuredClone(data), navigation }
    const plan = planNavigation(
      before,
      routeDefaults('issues'),
      {
        view: 'workspace',
        selectedIssueId: issue.id,
        tabId: 'session',
        firstPane: true,
      },
      context,
    )
    expect(before).toEqual(copy)
    expect(plan.patch).toMatchObject({
      selectedIssueId: issue.id,
      paneA: 'session',
      split: false,
    })
    expect(plan.route).toMatchObject({ view: 'workspace', worktree: '/repo', pane: 'session' })
    expect(plan.replace).toBe(false)
    const final = { ...before, ...plan.patch }
    // The mark-read service writes the baseline into UiStore. Check the same
    // cursor and timestamp after applying the real planner's result.
    const visits = new MarkReadService({
      state: () => final,
      publishBaseline: (baseline) => {
        final.issueVisitBaseline = baseline
      },
      isVisible: () => true,
      markSessionRead: vi.fn(),
      markIssueRead: vi.fn(),
    })
    try {
      visits.updateIssueVisitBaseline()
      expect(final.issueVisitBaseline).toEqual({
        issueId: issue.id,
        readAt: null,
        openedAt: context.now,
      })
    } finally {
      visits.dispose()
    }
    const repeat = planNavigation(
      final,
      plan.route,
      {
        view: 'workspace',
        selectedIssueId: issue.id,
        tabId: 'session',
        firstPane: true,
      },
      context,
    )
    expect(
      Object.entries(repeat.patch).every(([key, value]) =>
        Object.is(final[key as keyof RuntimeState], value),
      ),
    ).toBe(true)
  })

  it('restores a sessionless issue workspace without persisting an empty layout', () => {
    const before = state()
    const plan = planNavigation(
      before,
      routeDefaults('workspace'),
      {
        view: 'workspace',
        selectedIssueId: issue.id,
      },
      context,
    )
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
    const plan = planNavigation(
      before,
      routeDefaults('issues'),
      {
        view: 'workspace',
        tabId: 'right',
        history: 'push',
      },
      context,
    )
    expect(plan.patch).toMatchObject({
      paneA: 'left',
      paneB: 'right',
      focusedPane: second,
      split: true,
    })
    expect(plan.route.pane).toBe('left')
    expect(workspaceMirrorPatch(plan.patch.workspaces!['wt:/repo']!)).toMatchObject({
      paneA: 'left',
      paneB: 'right',
    })
  })

  it('retains the original visit cursor and clears it when leaving the foreground', () => {
    const before = state()
    before.selectedIssueId = issue.id
    before.issueVisitBaseline = { issueId: issue.id, readAt: null, openedAt: context.now }
    before.view = 'workspace'
    const baseline = before.issueVisitBaseline
    let visible = true
    const visits = new MarkReadService({
      state: () => before,
      publishBaseline: (baseline) => {
        before.issueVisitBaseline = baseline
      },
      isVisible: () => visible,
      markSessionRead: vi.fn(),
      markIssueRead: vi.fn(),
    })
    try {
      before.issueVisitBaseline = baseline
      Object.assign(
        before,
        planNavigation(before, routeDefaults('workspace'), { view: 'workspace' }, context).patch,
      )
      visits.updateIssueVisitBaseline()
      expect(before.issueVisitBaseline).toBe(baseline)
      Object.assign(
        before,
        planNavigation(before, routeDefaults('workspace'), { view: 'settings' }, context).patch,
      )
      visits.updateIssueVisitBaseline()
      expect(before.issueVisitBaseline).toBeNull()
      before.view = 'workspace'
      before.issueVisitBaseline = baseline
      visible = false
      Object.assign(
        before,
        planNavigation(
          before,
          routeDefaults('workspace'),
          { view: 'workspace' },
          { ...context, visible },
        ).patch,
      )
      visits.updateIssueVisitBaseline()
      expect(before.issueVisitBaseline).toBeNull()
    } finally {
      visits.dispose()
    }
  })

  it('plans a preview replacement and file retirement together', () => {
    const before = state()
    const first = {
      id: 'file:old',
      scope: { kind: 'session' as const, sessionId: asSessionId('s') },
      path: 'old',
      worktreePath: '/repo',
    }
    const next = { ...first, id: 'file:new', path: 'new' }
    before.fileTabs = [first]
    before.workspaces = {
      'wt:/repo': openTab(emptyWorkspace('wt:/repo'), first.id, { permanent: false }),
    }
    const plan = planNavigation(
      before,
      routeDefaults('issues'),
      {
        view: 'workspace',
        tabId: next.id,
        fileTab: next,
        permanent: false,
        retireOrphanFiles: true,
      },
      context,
    )
    expect(plan.patch.fileTabs).toEqual([next])
    expect(plan.patch.paneA).toBe(next.id)
    expect(before.fileTabs).toEqual([first])
  })
})
