// @vitest-environment happy-dom
import { asIssueId, asSessionId } from '@podium/model'
import { compareStructural, observable, reaction, runInAction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtureUi } from '../../../test-support/ui'
import { DraftStore } from '../../conversation/draft-store'
import type { NavigationProvider, NavigationTopologyDelta } from '../../navigation-provider'
import type { SessionView } from '../../session-values'
import type { SocketHub } from '../../socket-transport'
import { type ScreenState, workspaceWritePatch } from '../../ui/state'
import { createMemoryRouterWindow, createRouter } from '../../ui-state'
import { allTabIds, emptyWorkspace, openTab, splitPane } from '../../values'
import { DraftResendService } from './draft-resend-service'
import { FollowService } from './follow-service'
import { MarkReadService } from './mark-read-service'
import { NotificationService } from './notification-service'
import { PaneLinkService } from './pane-link-service'
import { TabPruningService } from './tab-pruning-service'
import { ViewStateService } from './view-state-service'

const sid = asSessionId('session-a'),
  other = asSessionId('session-b')
const issue = asIssueId('issue-a'),
  destination = asIssueId('issue-b')
const at = (seconds: number) => `2026-11-09T10:00:${String(seconds).padStart(2, '0')}.000Z`
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function fixture() {
  const sessions = observable.map<string, SessionView>(undefined, { deep: false })
  const cursors = observable.map<string, string>()
  const activity = observable.map<string, string>()
  const topology = new Set<(delta?: NavigationTopologyDelta) => void>()
  const visibilityListeners = new Set<() => void>(),
    reconnects = new Set<() => void>()
  const observeRead = vi.fn(() => true),
    leave = vi.fn(),
    allowed = vi.fn(() => true)
  const navigation: NavigationProvider = {
    issue: (id) => ({ id: asIssueId(id), updatedAt: at(0), archived: false }),
    missionRoot: (id) => asIssueId(id),
    missionMembers: (id) => new Set([id]),
    session: (id) => sessions.get(id),
    sessionMembership: (id) => sessions.get(id),
    activityAt: (id) => activity.get(id),
    issueReadAt: (id) => cursors.get(id),
    observeRead,
    leaveReadVisit: leave,
    automaticReadAllowed: allowed,
    registeredWorktree: (path) => path === '/repo' || path === '/dest',
    firstWorktree: () => '/repo',
    hasWorktreeSession: (path) => path === '/unlisted',
    worktreeForCwd: (cwd) => (cwd.startsWith('/dest') ? '/dest' : '/repo'),
    worktreeSession: (id) => sessions.get(id),
    onTopology: (changed) => {
      topology.add(changed)
      return () => topology.delete(changed)
    },
    watch: (read, changed) => reaction(read, changed, { equals: compareStructural }),
  }
  let visible = true
  const visibility = {
    isVisible: () => visible,
    subscribe: (cb: () => void) => {
      visibilityListeners.add(cb)
      return () => visibilityListeners.delete(cb)
    },
  }
  const connection = {
    visibility,
    onVisibilityChange: visibility.subscribe,
    onReconnected: (cb: () => void) => {
      reconnects.add(cb)
      return () => reconnects.delete(cb)
    },
  }
  const ui = fixtureUi(undefined, { isVisible: () => visible })
  cleanups.push(ui.dispose)
  ui.patch({ navigation, selectedWorktree: '/repo', selectedIssueId: issue, view: 'workspace' })
  const put = (id = sid, stamp = at(1), cwd = '/repo', issueId = issue) =>
    runInAction(() => {
      sessions.set(id, {
        sessionId: id,
        cwd,
        issueId,
        unread: true,
        lastActiveAt: stamp,
      } as SessionView)
    })
  put()
  ui.openSessionTab(sid)
  return {
    ui,
    navigation,
    sessions,
    cursors,
    activity,
    connection,
    topology,
    reconnects,
    visibilityListeners,
    observeRead,
    leave,
    allowed,
    put,
    publish: (patch: Partial<ScreenState>) => ui.patch(patch),
    state: () => ui.screen,
    setVisible: (value: boolean) => {
      visible = value
      for (const cb of [...visibilityListeners]) cb()
    },
    emitTopology: (delta?: NavigationTopologyDelta) => {
      for (const cb of [...topology]) cb(delta)
    },
  }
}

describe('mark-read service', () => {
  function owner() {
    const f = fixture(),
      sessionRead = vi.fn(),
      issueRead = vi.fn()
    const service = new MarkReadService({
      ...f,
      publishBaseline: f.ui.setIssueVisitBaseline,
      isVisible: f.connection.visibility.isVisible,
      connection: f.connection,
      markSessionRead: sessionRead,
      markIssueRead: issueRead,
    })
    cleanups.push(() => service.dispose())
    return { ...f, service, sessionRead, issueRead }
  }
  it('saves the first view immediately and coalesces later activity at 1.2 seconds', () => {
    vi.useFakeTimers()
    const f = owner()
    f.service.start()
    f.service.start()
    expect(f.sessionRead).toHaveBeenCalledExactlyOnceWith(sid, at(1))
    f.put(sid, at(2))
    vi.advanceTimersByTime(800)
    f.put(sid, at(3))
    vi.advanceTimersByTime(1199)
    expect(f.sessionRead).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(f.sessionRead).toHaveBeenLastCalledWith(sid, at(3))
    expect(f.sessionRead).toHaveBeenCalledTimes(2)
  })
  it('checkpoints a continuously active stream within ten seconds', () => {
    vi.useFakeTimers()
    const f = owner()
    f.service.start()
    for (let tick = 0; tick < 11; tick++) {
      f.put(sid, at(tick + 2))
      vi.advanceTimersByTime(900)
    }
    expect(f.sessionRead).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    expect(f.sessionRead).toHaveBeenCalledTimes(2)
    expect(f.sessionRead).toHaveBeenLastCalledWith(sid, at(12))
  })
  it('holds the pre-read cursor for a foreground visit, then starts another after hiding', () => {
    const f = owner()
    runInAction(() => {
      f.cursors.set(issue, at(0))
      f.activity.set(issue, at(3))
    })
    f.service.start()
    const baseline = f.ui.issueVisitBaseline
    expect(baseline?.readAt).toBe(at(0))
    expect(f.issueRead).toHaveBeenCalledExactlyOnceWith(issue, at(3))
    runInAction(() => f.cursors.set(issue, at(3)))
    expect(f.ui.issueVisitBaseline).toBe(baseline)
    f.setVisible(false)
    expect(f.ui.issueVisitBaseline).toBeNull()
    f.setVisible(true)
    expect(f.ui.issueVisitBaseline?.readAt).toBe(at(3))
  })
  it('flushes the old focus on leaving and respects an explicit unread visit', () => {
    vi.useFakeTimers()
    const f = owner()
    f.service.start()
    f.put(sid, at(2))
    f.put(other, at(4))
    f.ui.openSessionTab(other)
    expect(f.sessionRead.mock.calls).toEqual([
      [sid, at(1)],
      [sid, at(2)],
      [other, at(4)],
    ])
    expect(f.leave).toHaveBeenCalledWith('session', sid)
    f.allowed.mockReturnValue(false)
    f.put(other, at(5))
    vi.advanceTimersByTime(1200)
    expect(f.sessionRead).toHaveBeenCalledTimes(3)
  })
  it('stops every observer and timer on sign-out, including retained visibility callbacks', () => {
    vi.useFakeTimers()
    const f = owner()
    f.service.start()
    f.put(sid, at(2))
    const late = [...f.visibilityListeners]
    f.service.dispose()
    const count = f.sessionRead.mock.calls.length
    f.put(sid, at(3))
    f.ui.setView('settings')
    f.setVisible(false)
    for (const cb of late) cb()
    f.service.start()
    vi.advanceTimersByTime(20_000)
    expect(f.sessionRead).toHaveBeenCalledTimes(count)
    expect(f.visibilityListeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('waits for in-flight read durability before the reload barrier completes', async () => {
    const f = fixture()
    let durable!: () => void
    const write = new Promise<void>((resolve) => {
      durable = resolve
    })
    const service = new MarkReadService({
      ...f,
      publishBaseline: f.ui.setIssueVisitBaseline,
      isVisible: () => true,
      markSessionRead: () => write,
      markIssueRead: vi.fn(),
    })
    cleanups.push(() => service.dispose())
    service.start()
    const flushed = vi.fn()
    const pending = service.flushReadAcknowledgements().then(flushed)
    await settle()
    expect(flushed).not.toHaveBeenCalled()
    durable()
    await pending
    expect(flushed).toHaveBeenCalledTimes(1)
  })
})

describe('follow and workspace policies', () => {
  it('follows a visible rehome once, owns its watches and drops queued work after sign-out', async () => {
    const f = fixture(),
      info = vi.fn()
    const service = new FollowService({
      ...f,
      notices: { info, error: vi.fn() },
      isVisible: () => true,
      checkoutsKnown: () => true,
    })
    cleanups.push(() => service.dispose())
    service.start()
    service.start()
    await settle()
    expect(f.topology.size).toBe(1)
    f.put(sid, at(2), '/dest', destination)
    f.emitTopology({
      reset: false,
      sessions: [
        {
          id: sid,
          before: { cwd: '/repo', issueId: issue, order: '1' },
          after: { cwd: '/dest', issueId: destination, order: '1' },
        },
      ],
    })
    await settle()
    expect(f.ui.selectedWorktree).toBe('/dest')
    expect(f.ui.selectedIssueId).toBe(destination)
    expect(f.ui.paneA).toBe(sid)
    service.stop()
    service.start()
    await settle()
    expect(f.topology.size).toBe(1)
    f.put(sid, at(3), '/repo', issue)
    f.emitTopology({
      reset: false,
      sessions: [
        {
          id: sid,
          before: { cwd: '/dest', issueId: destination, order: '1' },
          after: { cwd: '/repo', issueId: issue, order: '1' },
        },
      ],
    })
    service.dispose()
    await settle()
    expect(f.ui.selectedIssueId).toBe(destination)
    expect(f.topology.size).toBe(0)
  })
  it('reports background worktree moves while keeping the current selection', async () => {
    const f = fixture(),
      info = vi.fn()
    f.put(other)
    const service = new FollowService({
      ...f,
      notices: { info, error: vi.fn() },
      isVisible: () => false,
    })
    cleanups.push(() => service.dispose())
    service.start()
    await settle()
    f.put(other, at(2), '/dest')
    f.emitTopology({
      reset: false,
      sessions: [
        { id: other, before: { cwd: '/repo', order: '1' }, after: { cwd: '/dest', order: '1' } },
      ],
    })
    await settle()
    expect(f.ui.selectedWorktree).toBe('/repo')
    expect(info).toHaveBeenCalledExactlyOnceWith('A session moved worktree', '/dest')
  })
  it('rechecks fallback on selection and checkout changes and removes that listener on disposal', async () => {
    const f = fixture(),
      changes = new Set<() => void>()
    let known = false
    const service = new FollowService({
      ...f,
      notices: { info: vi.fn(), error: vi.fn() },
      isVisible: () => true,
      checkoutsKnown: () => known,
      subscribeCheckouts: (cb) => {
        changes.add(cb)
        return () => changes.delete(cb)
      },
    })
    cleanups.push(() => service.dispose())
    service.start()
    await settle()
    f.ui.patch({ selectedWorktree: '/unknown' })
    expect(f.ui.selectedWorktree).toBe('/unknown')
    known = true
    for (const cb of changes) cb()
    expect(f.ui.selectedWorktree).toBe('/repo')
    f.ui.patch({ selectedWorktree: '/unlisted' })
    expect(f.ui.selectedWorktree).toBe('/unlisted')
    service.dispose()
    expect(changes.size).toBe(0)
    f.ui.patch({ selectedWorktree: '/late' })
    await settle()
    expect(f.ui.selectedWorktree).toBe('/late')
  })
  it('derives the selected task panes without a mirror write or a whole-state publication', () => {
    const f = fixture()
    const left = f.ui.workspaces[f.ui.workspaceKey()]!
    const right = openTab(emptyWorkspace(`mission:${destination}`), other, { permanent: true })
    f.ui.patch({ workspaces: { ...f.ui.workspaces, [right.key]: right } })
    const layouts = f.ui.workspaces
    f.ui.setSelectedIssueId(destination)
    expect(f.ui.paneA).toBe(other)
    expect(f.ui.workspaces).toBe(layouts)
    f.ui.setSelectedIssueId(issue)
    expect(f.ui.paneA).toBe(sid)
    expect(f.ui.workspaces[left.key]).toBe(left)
  })
})

describe('tab pruning service', () => {
  it('waits for continuous absence, keeps returning tabs and cancels the grace timer on sign-out', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.ui.openSessionTab(other)
    const service = new TabPruningService({ ...f, pruneGraceMs: 20 })
    cleanups.push(() => service.dispose())
    service.start()
    service.start()
    await settle()
    vi.advanceTimersByTime(19)
    expect(allTabIds(f.ui.workspace)).toContain(other)
    f.put(other)
    await settle()
    vi.advanceTimersByTime(1)
    expect(allTabIds(f.ui.workspace)).toContain(other)
    runInAction(() => f.sessions.delete(other))
    await settle()
    vi.advanceTimersByTime(20)
    expect(allTabIds(f.ui.workspace)).not.toContain(other)
    f.ui.openSessionTab(asSessionId('ghost'))
    await settle()
    service.dispose()
    vi.advanceTimersByTime(100)
    expect(allTabIds(f.ui.workspace)).toContain('ghost')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('holds the origin layout until a cold destination is ready', async () => {
    const f = fixture()
    const ready = observable.map([['ready', false]])
    const service = new TabPruningService({ ...f, ready: () => ready.get('ready')! })
    cleanups.push(() => service.dispose())
    service.start()
    f.put(sid, at(2), '/repo', destination)
    await settle()
    expect(allTabIds(f.ui.workspace)).toContain(sid)
    runInAction(() => ready.set('ready', true))
    await settle()
    expect(allTabIds(f.ui.workspace)).not.toContain(sid)
  })
})

describe('view-state service', () => {
  it('reports every visible pane, dock and mode, and clears presence while hidden', () => {
    const f = fixture(),
      report = vi.fn(),
      visible = vi.fn()
    let ws = splitPane(f.ui.workspace, f.ui.workspace.focusedPaneId, 'row', { tabId: other })
    ws = splitPane(ws, ws.focusedPaneId, 'row', { tabId: 'third' })
    f.ui.patch(workspaceWritePatch(f.ui.screen, ws.key, ws))
    f.ui.patch({ dockVisibleSession: 'shell' })
    const service = new ViewStateService({
      ...f,
      hub: { setViewState: report, setVisible: visible },
      connection: f.connection,
    })
    cleanups.push(() => service.dispose())
    service.start()
    service.start()
    expect(report).toHaveBeenLastCalledWith([sid, other, 'third', 'shell'], 'third', {
      [sid]: 'native',
      [other]: 'native',
      third: 'native',
      shell: 'native',
    })
    f.ui.setPanelMode(sid, 'chat')
    expect(report.mock.calls.at(-1)?.[2][sid]).toBe('chat')
    f.setVisible(false)
    expect(visible).toHaveBeenLastCalledWith(false)
    expect(report).toHaveBeenLastCalledWith([], null, {})
    service.stop()
    service.start()
    expect(f.visibilityListeners.size).toBe(1)
    service.dispose()
    const count = report.mock.calls.length
    f.setVisible(true)
    f.ui.setDockVisibleSession(asSessionId('late'))
    expect(report).toHaveBeenCalledTimes(count)
    expect(f.visibilityListeners.size).toBe(0)
  })
})

describe('hidden web notifications', () => {
  it('notifies once only while hidden, removes the attention listener and tolerates unavailable webviews', () => {
    const f = fixture(),
      listeners = new Set<(e: any) => void>()
    const notification = vi.fn(function (this: object) {})
    Object.assign(notification, { permission: 'granted' })
    vi.stubGlobal('Notification', notification)
    const hub = {
      on: (_kind: string, cb: (e: any) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    } as Pick<SocketHub, 'on'>
    const service = new NotificationService(hub, f.connection.visibility)
    cleanups.push(() => service.dispose())
    service.start()
    service.start()
    const event = { title: 'Needs input', body: 'Choose a path', sessionId: sid }
    for (const cb of listeners) cb(event)
    expect(notification).not.toHaveBeenCalled()
    f.setVisible(false)
    for (const cb of listeners) cb(event)
    expect(notification).toHaveBeenCalledExactlyOnceWith(event.title, {
      body: event.body,
      tag: sid,
    })
    notification.mockImplementation(() => {
      throw new Error('webview')
    })
    expect(() => {
      for (const cb of listeners) cb(event)
    }).not.toThrow()
    service.stop()
    service.start()
    expect(listeners.size).toBe(1)
    const late = [...listeners]
    service.dispose()
    service.start()
    for (const cb of late) cb(event)
    expect(notification).toHaveBeenCalledTimes(2)
    expect(listeners.size).toBe(0)
  })
})

describe('draft resend service', () => {
  it('reoffers dirty text on recovery, avoids clean echoes and detaches across remounts', () => {
    vi.useFakeTimers()
    const f = fixture(),
      send = vi.fn()
    const drafts = new DraftStore({
      storage: { get: () => null, set: vi.fn() },
      hub: { on: () => () => {}, sendDraftEdit: send },
    })
    cleanups.push(() => drafts.dispose())
    const service = new DraftResendService(drafts, f.connection)
    cleanups.push(() => service.dispose())
    service.start()
    service.start()
    drafts.set(sid, 'offline keystroke')
    for (const cb of f.reconnects) cb()
    expect(send).toHaveBeenCalledExactlyOnceWith(sid, 0, 'offline keystroke')
    drafts.adoptRemote(sid, { text: 'offline keystroke', rev: 1 })
    for (const cb of f.reconnects) cb()
    expect(send).toHaveBeenCalledTimes(1)
    service.stop()
    service.start()
    expect(f.reconnects.size).toBe(1)
    const late = [...f.reconnects]
    service.dispose()
    drafts.set(sid, 'after sign-out')
    for (const cb of late) cb()
    expect(send).toHaveBeenCalledTimes(1)
    expect(f.reconnects.size).toBe(0)
  })
})

describe('pane-link service', () => {
  function owner(
    pane: string,
    resolve = vi.fn(async (_id: string) => ({ kind: 'absent' as const })),
  ) {
    const f = fixture(),
      notices = { info: vi.fn(), error: vi.fn() },
      fallback = vi.fn()
    const router = createRouter({
      win: createMemoryRouterWindow(`/workspace?pane=${pane}&wt=/repo`),
    })
    const navigate = vi.fn(() => true)
    const service = new PaneLinkService({
      ...f,
      router,
      resolve,
      notices,
      navigate,
      fallback,
      graceMs: 20,
      repositories: () => [],
      openWorkspaceTab: (id) =>
        workspaceWritePatch(
          f.ui.screen,
          f.ui.workspaceKey(),
          openTab(f.ui.workspace, id, { permanent: true }),
        ),
    })
    cleanups.push(() => {
      service.dispose()
      router.dispose()
    })
    return { ...f, service, resolve, notices, fallback, navigate, router }
  }
  it('opens a cold full-id link when its row arrives and cancels the expiry', async () => {
    vi.useFakeTimers()
    const f = owner('late-session-id')
    f.service.start()
    f.service.start()
    expect(allTabIds(f.ui.workspace)).toContain('late-session-id')
    f.put(asSessionId('late-session-id'), at(3), '/dest', destination)
    await settle()
    expect(f.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'late-session-id', selectedIssueId: destination }),
    )
    vi.advanceTimersByTime(20)
    expect(f.notices.error).not.toHaveBeenCalled()
    expect(f.resolve).not.toHaveBeenCalled()
  })
  it('reports an absent full id after grace and cancels a later timer on sign-out', () => {
    vi.useFakeTimers()
    const f = owner('missing-session-id')
    f.service.start()
    expect(f.service.linkedWorktree).toBe('/repo')
    vi.advanceTimersByTime(20)
    expect(f.notices.error).toHaveBeenCalledTimes(1)
    expect(f.fallback).toHaveBeenCalledTimes(1)
    f.service.follow({ ...f.router.current(), pane: 'another-missing-session' })
    f.service.dispose()
    vi.advanceTimersByTime(100)
    expect(f.notices.error).toHaveBeenCalledTimes(1)
  })
  it('rewrites a resolved short id to the canonical link and removes its provisional tab', async () => {
    const f = owner(
      'abc1234',
      vi.fn(async () => ({ kind: 'session' as const, sessionId: sid }) as never),
    )
    f.service.start()
    await settle()
    expect(f.router.current().pane).toBe(sid)
    expect(allTabIds(f.ui.workspace)).not.toContain('abc1234')
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith('abc1234')
    expect(f.notices.error).not.toHaveBeenCalled()
  })
  it('ignores a short-id answer after sign-out or a newer navigation', async () => {
    let finish!: (answer: any) => void
    const f = owner(
      'abc1234',
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      ),
    )
    f.service.start()
    await settle()
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith('abc1234')
    f.service.dispose()
    finish({ kind: 'session', sessionId: sid })
    await settle()
    expect(f.navigate).not.toHaveBeenCalled()
    expect(f.router.current().pane).toBe('abc1234')
    expect(f.notices.error).not.toHaveBeenCalled()
  })
})
