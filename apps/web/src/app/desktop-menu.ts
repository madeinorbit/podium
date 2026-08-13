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

/**
 * Sidebar chords for the desktop shell. ⌘B / Ctrl+B is the left work list
 * (the same as most editors). ⌥⌘B / Alt+Ctrl+B is the right dock — VS Code's
 * secondary-sidebar chord, so it does not steal ⌘B and stays on a real letter
 * on ISO keyboards where `\` is a stretch.
 *
 * Bare Command only for the left; Option must ride along for the right. Shift
 * and the opposite extra modifier are refused so screenshot chords and the
 * flight-deck toggle stay untouched.
 */
export function sidebarToggleFromEvent(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): 'left' | 'right' | null {
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey) return null
  if (event.key.toLowerCase() !== 'b') return null
  return event.altKey ? 'right' : 'left'
}

type MenuHook = () => void | boolean

export interface DesktopMenuHooks {
  about?: MenuHook
  checkUpdates?: MenuHook
  addProject?: MenuHook
  toggleLeftSidebar?: MenuHook
  toggleFlightDeck?: MenuHook
  toggleRightSidebar?: MenuHook
  closeTab?: () => boolean
}

type DesktopMenuGlobals = {
  __PODIUM_ABOUT__?: MenuHook
  __PODIUM_CHECK_UPDATES__?: MenuHook
  __PODIUM_ADD_PROJECT__?: MenuHook
  __PODIUM_TOGGLE_LEFT_SIDEBAR__?: MenuHook
  __PODIUM_TOGGLE_FLIGHT_DECK__?: MenuHook
  __PODIUM_TOGGLE_RIGHT_SIDEBAR__?: MenuHook
  __PODIUM_CLOSE_TAB__?: () => boolean
}

const GLOBAL_KEYS = [
  ['about', '__PODIUM_ABOUT__'],
  ['checkUpdates', '__PODIUM_CHECK_UPDATES__'],
  ['addProject', '__PODIUM_ADD_PROJECT__'],
  ['toggleLeftSidebar', '__PODIUM_TOGGLE_LEFT_SIDEBAR__'],
  ['toggleFlightDeck', '__PODIUM_TOGGLE_FLIGHT_DECK__'],
  ['toggleRightSidebar', '__PODIUM_TOGGLE_RIGHT_SIDEBAR__'],
  ['closeTab', '__PODIUM_CLOSE_TAB__'],
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
