import type { PodiumClientApi } from '../src/api'
import type { SocketHub } from '../src/socket-transport'
import type { ScreenState } from '../src/ui/state'
import { UiStore, type UiStorePorts } from '../src/ui/ui-store'
import {
  AutoContinueDialogModel,
  PaletteViewModel,
  TranscriptRevealActions,
} from '../src/ui/view-models'
import { createMemoryRouterWindow, createRouter, type RoutedUiState } from '../src/ui-state'
import { emptyWorkspace, focusPane, leafPaneIds, openTab, splitPane } from '../src/values'
import { workspaceKeyForState, workspaceMirrorPatch } from '../src/ui/state'
import { fixtureNavigation } from './navigation'
import { observable, runInAction } from 'mobx'

const refreshers = new WeakMap<object, () => void>()
const disposers = new WeakMap<object, () => void>()
const fixtureKeyPorts = new WeakMap<UiStore, RoutedUiState>()
export function disposeFixtureUi(owner: object): void {
  disposers.get(owner)?.()
}
/** Publish hand-held render inputs before a provider-free render. Source
 * fixtures instead publish through their owner's ordinary subscription. */
export function refreshFixtureUi(owner: object): void {
  refreshers.get(owner)?.()
}

/** Publish old pane inputs as the workspace layouts the real store produces. */
export function patchFixtureScreen<T extends object>(state: T, patch: Partial<T>): T {
  const next = { ...state, ...patch } as T & ScreenState
  const key = workspaceKeyForState(next)
  let workspace = next.workspaces?.[key]
  if (Object.hasOwn(patch, 'paneA')) {
    workspace ??= emptyWorkspace(key)
    const paneId = leafPaneIds(workspace.root)[0]!
    workspace = next.paneA
      ? openTab(workspace, next.paneA, { paneId, permanent: true })
      : { ...workspace, panes: { ...workspace.panes, [paneId]: { ...workspace.panes[paneId]!, tabs: [], activeTabId: null } } }
    next.workspaces = { ...next.workspaces, [key]: workspace }
  }
  return { ...next, ...workspaceMirrorPatch(workspace ?? emptyWorkspace(key)) }
}

/** Plain storage fixtures publish keys; product stores expose observable reads. */
export function observableFixtureKeys(source: RoutedUiState): RoutedUiState & { dispose(): void } {
  const revisions = observable.map<string, number>()
  let stop: (() => void) | undefined
  const bump = (changed: ReadonlySet<string>) => runInAction(() => {
    for (const key of changed) revisions.set(key, (revisions.get(key) ?? 0) + 1)
  })
  return {
    get: (key) => {
      stop ??= source.subscribe(bump)
      revisions.get(key)
      return source.get(key)
    },
    set: (key, value) => {
      if (source.get(key) === value) return
      const before = revisions.get(key)
      source.set(key, value)
      if (revisions.get(key) === before) bump(new Set([key]))
    },
    subscribe: notify => source.subscribe(notify),
    dispose: () => stop?.(),
  }
}

/** UI fixture for snapshot-era test doubles. The product never uses this adapter. */
export function fixtureUi(keys?: RoutedUiState, ports: Partial<UiStorePorts> = {}): UiStore {
  const values = new Map<string, string>()
  const source: RoutedUiState = keys ?? {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      if (value === null) values.delete(key)
      else values.set(key, value)
    },
    subscribe: () => () => {},
  }
  const port = observableFixtureKeys(source)
  const ui = new UiStore({
    api: {} as PodiumClientApi,
    hub: { reportTabRelease: () => {} } as unknown as SocketHub,
    notices: { error: () => {}, info: () => {} },
    keys: port,
    router: createRouter({ win: createMemoryRouterWindow() }),
    repositories: () => [],
    isVisible: () => true,
    ...ports,
  })
  const dispose = ui.dispose
  fixtureKeyPorts.set(ui, port)
  Object.defineProperty(ui, 'dispose', { configurable: true, writable: true, value: () => { port.dispose(); dispose() } })
  return ui
}
export function addFixtureUi(
  fake: { getSnapshot(): object; subscribe(notify: () => void): () => void } & Record<
    string,
    unknown
  >,
) {
  const values = new Map<string, string>()
  const suppliedKeys = (fake.deviceState ?? fake.ui) as RoutedUiState | undefined
  const keys: RoutedUiState = suppliedKeys ?? {
    get: (key) => (fake.getSnapshot() as { uiState?: RoutedUiState }).uiState?.get(key) ?? values.get(key) ?? null,
    set: (key, value) => {
      const source = (fake.getSnapshot() as { uiState?: RoutedUiState }).uiState
      if (source) source.set(key, value)
      if (value === null || source?.get(key) === value) values.delete(key)
      else values.set(key, value)
    },
    subscribe: (notify) => (fake.getSnapshot() as { uiState?: RoutedUiState }).uiState?.subscribe?.(notify) ?? (() => {}),
  }
  const ui = fixtureUi(keys)
  const navigation = fixtureNavigation({
    issues: () => (fake.getSnapshot() as { issueProjections?: never[]; issues?: never[] }).issueProjections ?? (fake.getSnapshot() as { issues?: never[] }).issues ?? [],
    sessions: () => (fake.getSnapshot() as { sessions?: never[] }).sessions ?? [],
  })
  const palette = new PaletteViewModel(),
    autoContinueDialog = new AutoContinueDialogModel()
  let syncing = false
  let disposed = false
  let stopStore: (() => void) | undefined
  let previous: Partial<ScreenState> | undefined
  let previousWorkspaces: ScreenState['workspaces'] | undefined
  let previousFileTabs: ScreenState['fileTabs'] | undefined
  const actions = new Set<string>()
  const sync = () => runInAction(() => {
    if (syncing || disposed) return
    syncing = true
    try {
    const snapshot = fake.getSnapshot() as Partial<ScreenState>
    if (!snapshot) return
    // Historical render suites supplied action spies on their fake runtime.
    // Install those spies on the UiStore that owns these methods now, so the
    // render still verifies dispatch through the current producer surface.
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(snapshot))) {
      if (!actions.has(key) && typeof descriptor.value === 'function' && typeof Reflect.get(ui, key) === 'function') {
        actions.add(key)
        Object.defineProperty(ui, key, {
          configurable: true,
          writable: true,
          value: (...args: unknown[]) => Reflect.get(fake.getSnapshot(), key)(...args),
        })
      }
    }
    const patch = Object.fromEntries(
      Object.keys(ui.screen)
        .filter((key) => !['paneA', 'paneB', 'split'].includes(key) && Object.hasOwn(snapshot, key) && (key !== 'workspaces' || snapshot.workspaces !== previousWorkspaces) && (key !== 'fileTabs' || snapshot.fileTabs !== previousFileTabs))
        .map((key) => [key, Reflect.get(snapshot, key)]),
    )
    ui.patch(patch)
    if (!snapshot.navigation) ui.setNavigation(navigation)
    // Snapshot-era fixtures supplied pane mirrors. Seed the layout that owns
    // them now, and turn later scalar publications into edits of that layout.
    if (snapshot.workspaces !== undefined || ['paneA', 'paneB', 'split'].some(key => Object.hasOwn(snapshot, key))) {
    const key = workspaceKeyForState(ui.screen)
    if ((snapshot.workspaces === undefined && !previous) ||
        (previous && ['paneA', 'paneB', 'split', 'focusedPane'].some(key => Object.hasOwn(snapshot, key) && Reflect.get(snapshot, key) !== Reflect.get(previous!, key)))) {
      let workspace = snapshot.workspaces?.[key] ?? emptyWorkspace(key)
      if (snapshot.paneA) workspace = openTab(workspace, snapshot.paneA, { permanent: true, paneId: leafPaneIds(workspace.root)[0] })
      if (snapshot.split && leafPaneIds(workspace.root).length === 1)
        workspace = splitPane(workspace, leafPaneIds(workspace.root)[0]!, 'row', snapshot.paneB ? { tabId: snapshot.paneB } : undefined)
      if (snapshot.paneB && snapshot.split)
        workspace = openTab(workspace, snapshot.paneB, { permanent: true, paneId: leafPaneIds(workspace.root)[1] })
      const focusedTab = snapshot.focusedPane === 'B' ? snapshot.paneB : snapshot.paneA
      // Opening a tab already in another pane focuses that existing tab; a
      // workspace never contains the same tab in two panes.
      const focused = Object.values(workspace.panes).find(pane => focusedTab && pane.activeTabId === focusedTab)?.id
        ?? (snapshot.focusedPane === 'B' ? leafPaneIds(workspace.root)[1] : leafPaneIds(workspace.root)[0])
      if (focused) workspace = focusPane(workspace, focused)
      if (workspace !== ui.workspaces[key] && (snapshot.paneA || snapshot.paneB || snapshot.workspaces?.[key]))
        ui.patch({ workspaces: { ...ui.workspaces, [key]: workspace } })
    }
    }
    previous = {
      paneA: snapshot.paneA,
      paneB: snapshot.paneB,
      split: snapshot.split,
      focusedPane: snapshot.focusedPane,
    }
    previousWorkspaces = snapshot.workspaces
    previousFileTabs = snapshot.fileTabs
    palette.setOpen(snapshot.paletteOpen ?? false)
    if (snapshot.autoContinuePromptSessionId)
      autoContinueDialog.open(snapshot.autoContinuePromptSessionId)
    else autoContinueDialog.close()
    } finally {
      syncing = false
    }
  })
  // Mock factories are hoisted above the snapshot's declaration. Borrow the
  // owner only on first use, after the suite has initialized its producer.
  let following = false
  const read = <T>(value: T): T => {
    if (!following && !disposed) {
      following = true
      sync()
      stopStore = fake.subscribe(sync)
    }
    return value
  }
  refreshers.set(fake, () => {
    if (following) sync()
    else read(ui)
  })
  const dispose = ui.dispose
  Object.defineProperty(ui, 'dispose', { configurable: true, writable: true, value: () => {
    disposed = true
    stopStore?.()
    dispose()
  } })
  disposers.set(fake, ui.dispose)
  const deviceState = fixtureKeyPorts.get(ui)!
  fake.deviceState = deviceState
  Object.defineProperties(fake, {
    ui: { configurable: true, enumerable: true, get: () => read(ui) },
    palette: { configurable: true, get: () => read(palette) },
    autoContinueDialog: { configurable: true, get: () => read(autoContinueDialog) },
  })
  fake.transcriptReveals ??= new TranscriptRevealActions()
  return { ui, palette, autoContinueDialog, deviceState }
}
