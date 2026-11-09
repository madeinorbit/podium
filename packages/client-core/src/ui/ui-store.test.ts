import { asIssueId, asSessionId } from '@podium/model'
import { autorun } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { VisibilitySource } from '../engine/visibility'
import { createAsyncStorageReplicaStorage } from '../replica/async-storage'
import { memoryStorage, type StorageApi } from '../replica/contract'
import type { SocketHub } from '../socket-transport'
import { createMemoryRouterWindow, createRouter, UI_STATE_KEYS } from '../ui-state'
import { allTabIds, emptyWorkspace, focusPane, openTab, splitPane } from '../values'
import type { DeviceStorage } from './device-storage'
import { openLegacyDeviceKeys } from './draft-storage'
import { UiPersistence } from './persistence'
import { UiStore } from './ui-store'

const s1 = asSessionId('session-1'),
  s2 = asSessionId('session-2')
const prefix = 'podium.replica.principal.alice'
const alive: Array<() => void> = []
afterEach(() => {
  for (const close of alive.splice(0)) close()
  vi.useRealTimers()
})
function setup(
  storage: StorageApi = memoryStorage(),
  options: { device?: DeviceStorage; win?: ReturnType<typeof createMemoryRouterWindow> } = {},
) {
  const device = options.device ?? { storage, keyPrefix: prefix }
  const legacy = openLegacyDeviceKeys(device)
  const keys = new Map<string, string>()
  const router = createRouter({ win: options.win ?? createMemoryRouterWindow() })
  let visible = true
  const listeners = new Set<() => void>()
  const visibility: VisibilitySource = {
    isVisible: () => visible,
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
  const release = vi.fn()
  const ui = new UiStore({
    api: {} as PodiumClientApi,
    hub: { reportTabRelease: release } as unknown as SocketHub,
    notices: { error: vi.fn(), info: vi.fn() },
    keys: {
      get: (key) => keys.get(key) ?? null,
      set: (key, value) => {
        if (value === null) keys.delete(key)
        else keys.set(key, value)
      },
      subscribe: () => () => {},
    },
    router,
    repos: () => [],
    reposLoaded: () => false,
    isVisible: () => visible,
  })
  const persistence = new UiPersistence(ui, device, legacy, visibility)
  alive.push(() => {
    persistence.stopSaving()
    router.dispose()
    ui.dispose()
  })
  return {
    ui,
    persistence,
    legacy,
    keys,
    release,
    router,
    hide() {
      visible = false
      for (const notify of listeners) notify()
    },
  }
}
function savedScreen() {
  let workspace = openTab(emptyWorkspace('wt:/repo'), s1, { permanent: true })
  workspace = splitPane(workspace, workspace.focusedPaneId, 'row', { tabId: s2 })
  const focused = Object.keys(workspace.panes).at(-1)!
  workspace = focusPane(workspace, focused)
  return {
    version: 1,
    view: 'settings',
    selectedWorktree: '/repo',
    selectedIssueId: null,
    settingsTab: 'appearance',
    openIssueId: asIssueId('issue-1'),
    superThreadId: 'thread-2',
    attachedSessionId: s1,
    dockVisibleSession: s2,
    focusedPane: focused,
    workspaces: { 'wt:/repo': workspace },
    dockShells: { '/repo': s2 },
    recentFiles: [{ worktreePath: '/repo', path: 'README.md', openedAt: 1 }],
    fileTabs: [
      {
        id: 'file-1',
        scope: { kind: 'worktree', root: '/repo' },
        path: 'README.md',
        worktreePath: '/repo',
      },
    ],
    fileScroll: { 'source:file-1': { top: 120, left: 8 } },
  }
}

describe('device UiStore', () => {
  it('keeps panes empty while the selected issue is unresolved, without borrowing the none workspace', () => {
    const { ui } = setup()
    ui.patch({
      selectedIssueId: asIssueId('child'),
      workspaces: {
        none: openTab(emptyWorkspace('none'), s1, { permanent: true }),
      },
    })
    expect(ui.workspaceLoading).toBe(true)
    expect(ui.paneA).toBeNull()
    expect(ui.paneB).toBeNull()
    expect(ui.focusedSessionId).toBeNull()
  })
  it('saves keyed device preferences in the screen document and migrates no drafts or synced rows', async () => {
    const storage = memoryStorage()
    storage.setItem(
      `${prefix}.uistate.v1`,
      JSON.stringify({
        'podium.shell.density': 'compact',
        [UI_STATE_KEYS.panelMode]: '{"s":"native"}',
        'podium.drafts.v1': '{"s":"keep my writing"}',
      }),
    )
    const { ui, legacy, persistence } = setup(storage)
    expect(ui.getDevicePref('podium.shell.density')).toBe('compact')
    expect(legacy.get('podium.shell.density')).toBeNull()
    expect(legacy.get('podium.drafts.v1')).toContain('keep my writing')
    persistence.start()
    ui.setDevicePref('podium.shell.density', 'comfortable')
    await persistence.flush()
    const doc = JSON.parse(storage.getItem(`${prefix}.ui.v1`)!)
    expect(doc.devicePrefs).toEqual({ 'podium.shell.density': 'comfortable' })
    expect(JSON.stringify(doc)).not.toContain('keep my writing')
    expect(doc).not.toHaveProperty('panelMode')
  })
  it('restores every saved field before the first reader can paint', () => {
    const storage = memoryStorage()
    storage.setItem(`${prefix}.ui.v1`, JSON.stringify(savedScreen()))
    const { ui } = setup(storage)
    const frames: unknown[] = []
    const off = autorun(() =>
      frames.push({
        view: ui.view,
        selection: ui.selectedWorktree,
        settings: ui.settingsTab,
        issue: ui.openIssueId,
        thread: ui.superThreadId,
        attached: ui.attachedSessionId,
        dock: ui.dockVisibleSession,
        focus: ui.focusedPane,
        paneA: ui.paneA,
        paneB: ui.paneB,
        split: ui.split,
        files: [...ui.fileTabs.keys()],
        scroll: ui.getFileScroll('source:file-1'),
      }),
    )
    expect(frames).toEqual([
      {
        view: 'settings',
        selection: '/repo',
        settings: 'appearance',
        issue: 'issue-1',
        thread: 'thread-2',
        attached: s1,
        dock: s2,
        focus: 'p2',
        paneA: s1,
        paneB: s2,
        split: true,
        files: ['file-1'],
        scroll: { top: 120, left: 8 },
      },
    ])
    off()
  })
  it('debounces one document and flushes immediately when hidden', async () => {
    vi.useFakeTimers()
    const storage = memoryStorage(),
      write = vi.spyOn(storage, 'setItem')
    const { ui, persistence, hide } = setup(storage)
    persistence.start()
    write.mockClear()
    ui.setSelectedWorktree('/repo')
    ui.openSessionTab(s1)
    ui.setSuperThreadId('thread-2')
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(299)
    expect(write).not.toHaveBeenCalled()
    hide()
    expect(write.mock.calls.filter(([key]) => key === persistence.key)).toHaveLength(1)
    expect(JSON.parse(storage.getItem(persistence.key)!)).toMatchObject({
      selectedWorktree: '/repo',
      superThreadId: 'thread-2',
    })
    await vi.advanceTimersByTimeAsync(301)
    expect(write.mock.calls.filter(([key]) => key === persistence.key)).toHaveLength(1)
  })
  it('migrates only saved device screen keys once, retiring them after the document', () => {
    const storage = memoryStorage()
    storage.setItem(
      `${prefix}.uistate.v1`,
      JSON.stringify({
        [UI_STATE_KEYS.view]: 'issues',
        [UI_STATE_KEYS.selectedIssueId]: 'old-issue',
        [UI_STATE_KEYS.selectedWorktree]: '/repo',
        [UI_STATE_KEYS.paneA]: s1,
        [UI_STATE_KEYS.panelMode]: '{"session-1":"chat"}',
        unrelated: 'do not import',
      }),
    )
    const { ui, legacy, persistence } = setup(storage)
    expect(ui.view).toBe('issues')
    expect(ui.selectedIssueId).toBe('old-issue')
    const document = JSON.parse(storage.getItem(persistence.key)!)
    expect(document).not.toHaveProperty('panelMode')
    expect(document).not.toHaveProperty('unrelated')
    expect(legacy.get(UI_STATE_KEYS.view)).toBeNull()
    legacy.set(UI_STATE_KEYS.view, 'settings')
    expect(setup(storage).ui.view).toBe('issues')
  })
  it.each([
    '{bad',
    'null',
    '[]',
    '{"version":99}',
    '{"version":1,"workspaces":5,"fileTabs":[{}]}',
  ])('uses defaults for malformed saved data %s', (raw) => {
    const storage = memoryStorage()
    storage.setItem(`${prefix}.ui.v1`, raw)
    const { ui } = setup(storage)
    expect(ui.view).toBe('workspace')
    expect(ui.fileTabs.size).toBe(0)
    expect(ui.workspaces).toEqual({})
  })
  it('erases sign-out state and cancels pending persistence without touching another user', async () => {
    vi.useFakeTimers()
    const storage = memoryStorage()
    storage.setItem('podium.replica.principal.bob.ui.v1', 'bob')
    const { ui, persistence } = setup(storage)
    persistence.start()
    ui.setSelectedWorktree('/secret')
    persistence.erase()
    await vi.advanceTimersByTimeAsync(1000)
    expect(storage.getItem(persistence.key)).toBeNull()
    expect(storage.getItem('podium.replica.principal.bob.ui.v1')).toBe('bob')
  })
  it('keeps tab closing addressed and leaves sessions alive', () => {
    const { ui, release } = setup()
    ui.setSelectedWorktree('/repo')
    ui.openSessionTab(s1)
    ui.openSessionTab(s2)
    const lookups = vi.fn(() => {
      throw new Error('closing a tab must not join session rows')
    })
    ui.setNavigation({ ...ui.navigation, session: lookups })
    ui.closeWorkspaceTab(s1)
    expect(allTabIds(ui.workspace)).toEqual([s2])
    expect(lookups).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledWith(s1)
  })
  it('restores non-route state from the preloaded phone AsyncStorage bridge after process death', async () => {
    const backing = new Map<string, string>([[`${prefix}.ui.v1`, JSON.stringify(savedScreen())]])
    const native = {
      getAllKeys: async () => [...backing.keys()],
      getItem: async (key: string) => backing.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        backing.set(key, value)
      },
      removeItem: async (key: string) => {
        backing.delete(key)
      },
    }
    const firstBridge = await createAsyncStorageReplicaStorage(native)
    const first = setup(firstBridge.storage, {
      device: { storage: firstBridge.storage, keyPrefix: prefix, flush: firstBridge.flushDurable },
    })
    first.persistence.start()
    first.ui.setSuperThreadId('thread-after-send')
    first.ui.clearAttachedSession()
    first.hide()
    await first.persistence.flush()
    first.persistence.stopSaving()
    const secondBridge = await createAsyncStorageReplicaStorage(native)
    const second = setup(secondBridge.storage, {
      device: {
        storage: secondBridge.storage,
        keyPrefix: prefix,
        flush: secondBridge.flushDurable,
      },
    })
    expect(second.ui.superThreadId).toBe('thread-after-send')
    expect(second.ui.attachedSessionId).toBeNull()
    expect(second.ui.paneA).toBe(s1)
    expect(second.ui.paneB).toBe(s2)
    expect(second.ui.focusedPane).toBe('p2')
    expect(second.ui.fileTabs.size).toBe(1)
    expect(second.ui.dockVisibleSession).toBe(s2)
    second.persistence.erase()
    await second.persistence.flush()
    expect(backing.has(`${prefix}.ui.v1`)).toBe(false)
  })
})
