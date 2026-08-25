/**
 * THE SHELL-KEYBOARD HARNESS'S STORE (POD-1532).
 *
 * `DesktopMenuHost` renders `DesktopCloseTab`, which reads the live workspace
 * out of `app/store` to decide what `Close Tab` closes. The harness is here for
 * the KEYBOARD — whether a WebKit webview hands the shell's Ctrl chords to the
 * page at all — and standing up a real store behind that would be standing up
 * the whole app. So `app/store` is redirected here (see
 * `vite.shell-keyboard.config.ts`).
 *
 * ONE OPEN TAB, ON PURPOSE. `closeActiveWorkspaceTab` declines when the
 * workspace is empty — correctly: the shell must never answer Close Tab by
 * closing the window. But a harness that reported no tabs would show `Ctrl+W`
 * arriving and nothing happening, which reads as the bug this change fixes
 * rather than as the guard working. So the stub holds a tab, and closing it is
 * recorded on `window.__HARNESS_CLOSED_TABS__` for the probe to read.
 */
const CLOSED: string[] = []
;(globalThis as { __HARNESS_CLOSED_TABS__?: string[] }).__HARNESS_CLOSED_TABS__ = CLOSED

const KEY = 'harness'
const LAYOUT = {
  key: KEY,
  panes: { p1: { id: 'p1', tabs: ['tab-1'], activeTabId: 'tab-1' } },
  root: { kind: 'leaf', paneId: 'p1' },
  focusedPaneId: 'p1',
  previewTabId: null,
}

const STATE = {
  workspaces: { [KEY]: LAYOUT } as Record<string, unknown>,
  workspaceKey: () => KEY,
  fileTabs: [] as unknown[],
  closeFileTab: (id: string) => CLOSED.push(id),
  closeWorkspaceTab: (id: string) => CLOSED.push(id),
}

export function useStoreSelector<T>(select: (s: Record<string, unknown>) => T): T {
  return select(STATE as unknown as Record<string, unknown>)
}

export function useStore(): Record<string, unknown> {
  return STATE as unknown as Record<string, unknown>
}
