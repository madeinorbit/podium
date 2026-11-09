import type { PodiumClientApi } from '../src/api'
import type { SocketHub } from '../src/socket-transport'
import type { ScreenState } from '../src/ui/state'
import { UiStore } from '../src/ui/ui-store'
import {
  AutoContinueDialogModel,
  PaletteViewModel,
  TranscriptRevealActions,
} from '../src/ui/view-models'
import { createMemoryRouterWindow, createRouter, type RoutedUiState } from '../src/ui-state'
import { emptyWorkspace, focusPane, leafPaneIds, openTab, splitPane } from '../src/values'
import { workspaceKeyForState } from '../src/ui/state'
import { fixtureNavigation } from './navigation'

/** UI fixture for snapshot-era test doubles. The product never uses this adapter. */
export function fixtureUi(keys?: RoutedUiState): UiStore {
  const values = new Map<string, string>()
  return new UiStore({
    api: {} as PodiumClientApi,
    hub: { reportTabRelease: () => {} } as unknown as SocketHub,
    notices: { error: () => {}, info: () => {} },
    keys: keys ?? {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => {
        if (value === null) values.delete(key)
        else values.set(key, value)
      },
      subscribe: () => () => {},
    },
    router: createRouter({ win: createMemoryRouterWindow() }),
    repositories: () => [],
    isVisible: () => true,
  })
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
      else if (value === null) values.delete(key)
      else values.set(key, value)
    },
    subscribe: (notify) => (fake.getSnapshot() as { uiState?: RoutedUiState }).uiState?.subscribe(notify) ?? (() => {}),
  }
  const ui = fixtureUi(keys)
  const navigation = fixtureNavigation({
    issues: () => (fake.getSnapshot() as { issueProjections?: never[]; issues?: never[] }).issueProjections ?? (fake.getSnapshot() as { issues?: never[] }).issues ?? [],
    sessions: () => (fake.getSnapshot() as { sessions?: never[] }).sessions ?? [],
  })
  const palette = new PaletteViewModel(),
    autoContinueDialog = new AutoContinueDialogModel()
  let syncing = false
  let previous: Partial<ScreenState> | undefined
  const sync = () => {
    if (syncing) return
    syncing = true
    try {
    const snapshot = fake.getSnapshot() as Partial<ScreenState>
    if (!snapshot) return
    // Historical render suites supplied action spies on their fake runtime.
    // Install those spies on the UiStore that owns these methods now, so the
    // render still verifies dispatch through the current producer surface.
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(snapshot))) {
      if (typeof descriptor.value === 'function' && typeof Reflect.get(ui, key) === 'function')
        Object.defineProperty(ui, key, { configurable: true, writable: true, value: descriptor.value })
    }
    const patch = Object.fromEntries(
      Object.keys(ui.screen)
        .filter((key) => !['paneA', 'paneB', 'split'].includes(key) && Object.hasOwn(snapshot, key))
        .map((key) => [key, Reflect.get(snapshot, key)]),
    )
    ui.patch(patch)
    if (!snapshot.navigation) ui.setNavigation(navigation)
    // Snapshot-era fixtures supplied pane mirrors. Seed the layout that owns
    // them now, and turn later scalar publications into edits of that layout.
    const key = workspaceKeyForState(ui.screen)
    if ((!snapshot.workspaces?.[key] && !previous) ||
        (previous && ['paneA', 'paneB', 'split', 'focusedPane'].some(key => Object.hasOwn(snapshot, key) && Reflect.get(snapshot, key) !== Reflect.get(previous!, key)))) {
      let workspace = snapshot.workspaces?.[key] ?? emptyWorkspace(key)
      if (snapshot.paneA) workspace = openTab(workspace, snapshot.paneA, { permanent: true, paneId: leafPaneIds(workspace.root)[0] })
      if (snapshot.split && leafPaneIds(workspace.root).length === 1)
        workspace = splitPane(workspace, leafPaneIds(workspace.root)[0]!, 'row', snapshot.paneB ? { tabId: snapshot.paneB } : undefined)
      if (snapshot.paneB && snapshot.split)
        workspace = openTab(workspace, snapshot.paneB, { permanent: true, paneId: leafPaneIds(workspace.root)[1] })
      const focused = snapshot.focusedPane === 'B' ? leafPaneIds(workspace.root)[1] : leafPaneIds(workspace.root)[0]
      if (focused) workspace = focusPane(workspace, focused)
      ui.patch({ workspaces: { ...ui.workspaces, [key]: workspace } })
    }
    previous = snapshot
    palette.setOpen(snapshot.paletteOpen ?? false)
    if (snapshot.autoContinuePromptSessionId)
      autoContinueDialog.open(snapshot.autoContinuePromptSessionId)
    else autoContinueDialog.close()
    } finally {
      syncing = false
    }
  }
  // Mock factories are hoisted above the snapshot's declaration. Borrow the
  // owner only on first use, after the suite has initialized its producer.
  let following = false
  const read = <T>(value: T): T => {
    sync()
    if (!following) {
      following = true
      fake.subscribe(sync)
    }
    return value
  }
  fake.deviceState = keys
  Object.defineProperties(fake, {
    ui: { configurable: true, enumerable: true, get: () => read(ui) },
    palette: { configurable: true, get: () => read(palette) },
    autoContinueDialog: { configurable: true, get: () => read(autoContinueDialog) },
  })
  fake.transcriptReveals ??= new TranscriptRevealActions()
  return { ui, palette, autoContinueDialog, deviceState: keys }
}
