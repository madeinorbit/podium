import type { PodiumClientApi } from '../src/api'
import type { SocketHub } from '../src/socket-transport'
import type { ScreenState } from '../src/ui/state'
import { UiStore } from '../src/ui/ui-store'
import { AutoContinueDialogModel, PaletteViewModel } from '../src/ui/view-models'
import { createMemoryRouterWindow, createRouter, type RoutedUiState } from '../src/ui-state'

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
    repos: () => [],
    reposLoaded: () => true,
    isVisible: () => true,
  })
}
export function addFixtureUi(
  fake: { getSnapshot(): object; subscribe(notify: () => void): () => void } & Record<
    string,
    unknown
  >,
) {
  const keys = (fake.deviceState ?? fake.ui) as RoutedUiState | undefined
  const ui = fixtureUi(keys)
  const palette = new PaletteViewModel(),
    autoContinueDialog = new AutoContinueDialogModel()
  const sync = () => {
    const snapshot = fake.getSnapshot() as Partial<ScreenState>
    const patch = Object.fromEntries(
      Object.keys(ui.screen)
        .filter(
          (key) =>
            !['paneA', 'paneB', 'split', 'repos', 'reposLoaded'].includes(key) &&
            Object.hasOwn(snapshot, key),
        )
        .map((key) => [key, Reflect.get(snapshot, key)]),
    )
    ui.patch(patch)
    palette.setOpen(snapshot.paletteOpen ?? false)
    if (snapshot.autoContinuePromptSessionId)
      autoContinueDialog.open(snapshot.autoContinuePromptSessionId)
    else autoContinueDialog.close()
  }
  sync()
  fake.subscribe(sync)
  fake.deviceState = keys
  Object.defineProperty(fake, 'ui', { configurable: true, enumerable: true, value: ui })
  fake.palette = palette
  fake.autoContinueDialog = autoContinueDialog
  return { ui, palette, autoContinueDialog, deviceState: keys }
}
