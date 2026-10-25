/**
 * Web-app hooks the macOS shell menu evals (apps/desktop/src-tauri/src/main.rs).
 *
 * Each handler is registered by the surface that owns the action. Missing
 * handlers are a no-op — the shell never closes the main window from a menu
 * command.
 */
export const ADD_PROJECT_EVENT = 'podium:add-project'
export const ABOUT_EVENT = 'podium:about'

export function openAddProject(): void {
  window.dispatchEvent(new Event(ADD_PROJECT_EVENT))
}

export function openAboutPodium(): void {
  window.dispatchEvent(new Event(ABOUT_EVENT))
}

/** The desktop right dock uses Cmd/Ctrl+B. Modified chords remain unclaimed. */
export function sidebarToggleFromEvent(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): 'right' | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null
  if (event.key.toLowerCase() !== 'b') return null
  return 'right'
}

type MenuHook = () => void | boolean

export interface DesktopMenuHooks {
  about?: MenuHook
  checkUpdates?: MenuHook
  settings?: MenuHook
  addProject?: MenuHook
  toggleFlightDeck?: MenuHook
  toggleRightSidebar?: MenuHook
  closeTab?: () => boolean
  undo?: MenuHook
  redo?: MenuHook
}

type DesktopMenuGlobals = {
  __PODIUM_ABOUT__?: MenuHook
  __PODIUM_CHECK_UPDATES__?: MenuHook
  __PODIUM_SETTINGS__?: MenuHook
  __PODIUM_ADD_PROJECT__?: MenuHook
  __PODIUM_TOGGLE_FLIGHT_DECK__?: MenuHook
  __PODIUM_TOGGLE_RIGHT_SIDEBAR__?: MenuHook
  __PODIUM_CLOSE_TAB__?: () => boolean
  __PODIUM_UNDO__?: MenuHook
  __PODIUM_REDO__?: MenuHook
}

const GLOBAL_KEYS = [
  ['about', '__PODIUM_ABOUT__'],
  ['checkUpdates', '__PODIUM_CHECK_UPDATES__'],
  ['settings', '__PODIUM_SETTINGS__'],
  ['addProject', '__PODIUM_ADD_PROJECT__'],
  ['toggleFlightDeck', '__PODIUM_TOGGLE_FLIGHT_DECK__'],
  ['toggleRightSidebar', '__PODIUM_TOGGLE_RIGHT_SIDEBAR__'],
  ['closeTab', '__PODIUM_CLOSE_TAB__'],
  ['undo', '__PODIUM_UNDO__'],
  ['redo', '__PODIUM_REDO__'],
] as const

/** Install the given hooks, replacing only the keys that are provided. */
export function installDesktopMenuHooks(hooks: DesktopMenuHooks): () => void {
  const g = globalThis as DesktopMenuGlobals
  const assigned = globalThis as unknown as Record<string, MenuHook | undefined>
  const installed: Array<[string, MenuHook]> = []
  for (const [hook, globalKey] of GLOBAL_KEYS) {
    const handler = hooks[hook]
    if (!handler) continue
    assigned[globalKey] = handler
    installed.push([globalKey, handler])
  }
  return () => {
    for (const [key, handler] of installed) {
      if (g[key as keyof DesktopMenuGlobals] === handler) delete assigned[key]
    }
  }
}
