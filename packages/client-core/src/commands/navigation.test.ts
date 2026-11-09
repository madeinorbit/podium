import type { IssueProjection, SessionMeta } from '@podium/model'
import { asIssueId, asSessionId, layoutRowId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { COMMAND_ACTIONS, UI_LOCAL_ACTIONS } from '../../test-support/commands'
import { allTabIds, emptyWorkspace, openTab, splitPane, type WorkspaceLayout } from '../values'
import { harness, sessionId, ME } from './commands.test.fixture'
describe('engine action ownership boundary', () => {
  it('lets navigation suggest a panel mode without overwriting the operator’s pick', () => {
    // POD-1702. The native worker rows under a session focus it "in CLI", and
    // that wrote `native` over an explicit Chat pick — durably, so the session
    // reopened on the terminal too. A suggestion now yields to a pick and still
    // decides for a session nobody has decided about.
    const h = harness()
    const mode = (): unknown => h.ui.panelMode[sessionId]

    h.actions.preferPanelMode(sessionId, 'native')
    expect(h.queued).toEqual([
      {
        kind: 'recordEdit',
        input: {
          kind: 'userLayout',
          id: layoutRowId(ME, 'panelMode'),
          patch: { value: JSON.stringify({ [sessionId]: 'native' }) },
        },
      },
    ])
    h.seedLayout({ panelMode: JSON.stringify({ [sessionId]: 'native' }) })
    expect(mode()).toBe('native')

    h.actions.setPanelMode(sessionId, 'chat')
    h.seedLayout({ panelMode: JSON.stringify({ [sessionId]: 'chat' }) })
    h.actions.preferPanelMode(sessionId, 'native')
    expect(mode()).toBe('chat')
    expect(h.queued).toHaveLength(2)
  })
})
describe('engine action ownership boundary', () => {
  it('opens one permanent tab and delivers transcript reveal actions to the chat view', () => {
    const h = harness()
    h.actions.openSessionAtTranscript(sessionId, 'cursor-1', { permanent: true })
    h.actions.openSessionAtTranscript(sessionId, 'cursor-2', { permanent: true })
    expect(h.revealTranscript.mock.calls).toEqual([
      [sessionId, 'cursor-1'],
      [sessionId, 'cursor-2'],
    ])
    expect(h.state().paneA).toBe(sessionId)
    expect(allTabIds((h.state().workspaces as Record<string, WorkspaceLayout>).none!)).toEqual([
      sessionId,
    ])
  })
})
describe('engine action ownership boundary', () => {
  it('navigation, pane, selection, focus, and transient view changes never touch the Outbox', () => {
    const h = harness()
    h.actions.setView('workspace')
    h.actions.setSelectedWorktree('/worktree')
    h.actions.setSelectedIssueId(asIssueId('issue-1'))
    h.actions.setPane('A', sessionId)
    h.actions.setFocusedPane('B')
    h.actions.setDockShell('/worktree', sessionId)
    h.actions.toggleSplit()
    h.actions.setPaletteOpen(true)

    expect(h.queued).toEqual([])
    expect(h.navigated).toHaveLength(1)
  })
})

/**
 * The pane scalars are DERIVED from the layout (POD-710). Every case here is one
 * of the writers that used to disagree with it — and a disagreement is not
 * cosmetic: `paneA`/`paneB`/`split` drive the `?pane=` route, PTY-relay
 * priority, the warm set and what the flight deck highlights.
 */
describe('pane scalars follow the layout', () => {
  /** Two panes: p1 holds `a`, p2 holds `b` and has focus — the arrangement
   *  every "second pane" defect below needs. */
  const twoPanes = (a: string, b: string): WorkspaceLayout => {
    let ws = openTab(emptyWorkspace('none'), a, { permanent: true })
    ws = splitPane(ws, 'p1', 'row') // p2: empty, focused
    return openTab(ws, b, { permanent: true }) // …and it lands there
  }
  const meta = (id: string): SessionMeta =>
    ({ sessionId: asSessionId(id), cwd: '/wt', archived: false }) as unknown as SessionMeta

  it('killing the session in the second pane also collapses the split', async () => {
    const h = harness()
    h.seed({
      workspaces: { none: twoPanes('s-a', 'session-1') },
      paneA: asSessionId('s-a'),
      paneB: sessionId,
      split: true,
      focusedPane: 'p2',
    })

    await h.actions.killSession(sessionId)

    // The mirror computed `split: false` all along; killSession cherry-picked
    // `workspaces`/`paneA`/`paneB` out of the patch and dropped it, leaving a
    // phantom second pane that no later write could clear — the compatibility
    // clause saw one leaf both before and after and stopped writing `split`.
    const st = h.state()
    expect(st.split).toBe(false)
    expect(st.paneB).toBeNull()
    expect(st.focusedPane).toBe('p1')
    expect(st.paneA).toBe('s-a')
  })

  it('closing the file tab in the second pane collapses it too', () => {
    const h = harness()
    const fileId = 'file:s:s1:notes.md'
    h.seed({
      workspaces: { none: twoPanes('s-a', fileId) },
      fileTabs: [{ id: fileId, scope: { kind: 'session', sessionId }, path: 'notes.md' }],
      paneA: asSessionId('s-a'),
      paneB: fileId,
      split: true,
      focusedPane: 'p2',
    })

    h.actions.closeFileTab(fileId)

    const st = h.state()
    expect(st.split).toBe(false)
    expect(st.paneB).toBeNull()
    expect(st.fileTabs).toEqual([])
  })

  describe('tab release reports (POD-4435)', () => {
    it('closing a session tab reports its release to the server', () => {
      const reportTabRelease = vi.fn()
      const h = harness({}, { reportTabRelease })
      h.seed({
        workspaces: { none: openTab(emptyWorkspace('none'), 's-a', { permanent: true }) },
      })

      h.actions.closeWorkspaceTab(asSessionId('s-a'))

      expect(reportTabRelease).toHaveBeenCalledTimes(1)
      expect(reportTabRelease).toHaveBeenCalledWith(asSessionId('s-a'))
    })

    it('closing a file tab reports nothing (it carries no session)', () => {
      const reportTabRelease = vi.fn()
      const h = harness({}, { reportTabRelease })
      const fileId = 'file:s:s1:notes.md'
      h.seed({
        workspaces: { none: openTab(emptyWorkspace('none'), fileId, { permanent: true }) },
        fileTabs: [{ id: fileId, scope: { kind: 'session', sessionId }, path: 'notes.md' }],
      })

      h.actions.closeWorkspaceTab(fileId as never)

      expect(reportTabRelease).not.toHaveBeenCalled()
    })
  })

  it('navigating to a session opens it in the FOCUSED pane, not on top of pane A', () => {
    const h = harness()
    h.seed({
      sessions: [meta('s-a'), meta('session-1')],
      workspaces: { none: twoPanes('s-a', 's-b') },
    })

    h.actions.navigateToSession(sessionId)

    // `paneA: meta.sessionId` used to be spread AFTER the mirror, so a split
    // layout put one session in both panes and blanked the other half.
    const st = h.state()
    expect(st.paneB).toBe(sessionId)
    expect(st.paneA).toBe('s-a')
  })

  it('setPane(A, null) leaves the layout — and therefore the scalar — alone', () => {
    const h = harness()
    h.seed({
      workspaces: { none: openTab(emptyWorkspace('none'), 's-a', { permanent: true }) },
      paneA: asSessionId('s-a'),
    })

    h.actions.setPane('A', null)

    // Clearing a pane is not an operation the model has. Writing the scalar
    // anyway blanked the panel while the strip still listed the tab.
    expect(h.state().paneA).toBe('s-a')
  })

  it('setPane(B, …) against a single-leaf layout is inert, not a raw scalar write', () => {
    const h = harness()
    h.seed({
      workspaces: { none: openTab(emptyWorkspace('none'), 's-a', { permanent: true }) },
      paneA: asSessionId('s-a'),
    })

    h.actions.setPane('B', sessionId)

    expect(h.state().paneB).toBeNull()
    expect(h.state().split).toBe(false)
  })
})

/**
 * LANDING ON A LAUNCH (POD-1202). `issues.start` resolves when the SERVER has
 * spawned; the session row arrives a replica delta later, so a launch that only
 * selected the issue put the operator on an empty tab area and read as having
 * done nothing.
 */
describe('focusIssueSession waits for the session a launch started', () => {
  const issueId = asIssueId('issue-1')
  const issue = (id: string) => ({ id: asIssueId(id) }) as unknown as IssueProjection
  const meta = (id: string, ownedBy: string): SessionMeta =>
    ({
      sessionId: asSessionId(id),
      cwd: '/wt',
      archived: false,
      issueId: asIssueId(ownedBy),
    }) as unknown as SessionMeta

  it('opens the tab for a session that arrives AFTER the start resolved', async () => {
    const h = harness()
    h.seed({ issueProjections: [issue('issue-1')] })

    const landed = h.actions.focusIssueSession(issueId)
    // Nothing to open yet — this is the window the old code navigated in.
    expect(h.state().paneA).toBeNull()
    h.seed({ sessions: [meta('session-1', 'issue-1')] })

    expect(await landed).toBe('session-1')
    expect(h.state().paneA).toBe('session-1')
    expect(h.state().selectedIssueId).toBe(issueId)
    expect(h.navigated.at(-1)).toMatchObject({ view: 'workspace', pane: 'session-1' })
  })

  it('holds for the ISSUE too, so the tab is not written under the wrong workspace key', async () => {
    // A tab lands in the workspace keyed by the issue's MISSION, and that key
    // is only `mission:<id>` once the issue is in the replica. Opening a beat
    // early files the tab under `issue:<id>` and the arriving row moves the
    // workspace out from under it.
    const h = harness()

    const landed = h.actions.focusIssueSession(issueId)
    h.seed({ sessions: [meta('session-1', 'issue-1')] })
    // A full turn of the loop: enough for a wait that had already resolved to
    // have opened its tab. Nothing may have been written yet.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.state().paneA).toBeNull()
    expect(h.state().workspaces).toEqual({})

    h.seed({ issueProjections: [issue('issue-1')] })
    expect(await landed).toBe('session-1')
    expect(Object.keys(h.state().workspaces)).toEqual(['mission:issue-1'])
  })

  it('does not overrule an operator who selected another task while it waited', async () => {
    const h = harness()
    h.seed({ issueProjections: [issue('issue-1'), issue('issue-2')] })

    const landed = h.actions.focusIssueSession(issueId)
    h.actions.setSelectedIssueId(asIssueId('issue-2'))
    h.seed({ sessions: [meta('session-1', 'issue-1')] })

    expect(await landed).toBeNull()
    expect(h.state().selectedIssueId).toBe('issue-2')
    expect(h.state().paneA).toBeNull()
  })

  it('waits past existing sessions when a launch adds another agent', async () => {
    const h = harness()
    const existingId = asSessionId('session-existing')
    h.seed({
      issueProjections: [issue('issue-1')] as never,
      sessions: [meta(existingId, 'issue-1')],
    })

    const landed = h.actions.focusIssueSession(issueId, {
      excludeSessionIds: [existingId],
    })
    expect(h.state().paneA).toBeNull()

    h.seed({ sessions: [meta(existingId, 'issue-1'), meta('session-new', 'issue-1')] })

    expect(await landed).toBe('session-new')
    expect(h.state().paneA).toBe('session-new')
  })

  it('gives up when no session ever arrives, leaving the selection it made', async () => {
    const h = harness()
    h.seed({ issueProjections: [issue('issue-1')] })

    expect(await h.actions.focusIssueSession(issueId, { timeoutMs: 1 })).toBeNull()
    expect(h.state().selectedIssueId).toBe(issueId)
    expect(h.navigated).toEqual([])
  })
})

describe('S5 gesture batch', () => {
  it('is device-local and runs navigation plus reads in one caller batch', () => {
    const h = harness()
    expect(UI_LOCAL_ACTIONS).toContain('batchGesture')
    expect(COMMAND_ACTIONS).not.toContain('batchGesture')
    const order: string[] = []
    h.actions.batchGesture(() => {
      order.push('inside')
      h.actions.navigateWorkspace({ selectedIssueId: asIssueId('issue-1') })
    })
    expect(order).toEqual(['inside'])
    expect(h.navigated).toHaveLength(1)
  })
})
