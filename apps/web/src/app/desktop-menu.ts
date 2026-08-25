/**
 * Web-app hooks the desktop shell drives.
 *
 * Each handler is registered by the surface that owns the action and published
 * under the global name `desktop-commands.ts` declares for it — which is the
 * name the macOS menu evals (apps/desktop/src-tauri/src/main.rs) and the name
 * the keyboard path on every other platform calls. Missing handlers are a
 * no-op; the shell never closes the main window from a menu command.
 *
 * The COMMANDS themselves — labels, chords, which platform spells the modifier
 * how — live in `desktop-commands.ts`. This module is only the wiring.
 */
import type { DesktopCommandId } from './desktop-commands'
import { desktopCommand } from './desktop-commands'

export const ADD_PROJECT_EVENT = 'podium:add-project'
export const ABOUT_EVENT = 'podium:about'

export function openAddProject(): void {
  window.dispatchEvent(new Event(ADD_PROJECT_EVENT))
}

export function openAboutPodium(): void {
  window.dispatchEvent(new Event(ABOUT_EVENT))
}

type MenuHook = () => void | boolean

export interface DesktopMenuHooks {
  about?: MenuHook
  checkUpdates?: MenuHook
  settings?: MenuHook
  addProject?: MenuHook
  toggleLeftSidebar?: MenuHook
  toggleFlightDeck?: MenuHook
  toggleRightSidebar?: MenuHook
  closeTab?: () => boolean
}

/** Hook name → the command whose global it publishes. */
const HOOK_COMMANDS: ReadonlyArray<[keyof DesktopMenuHooks, DesktopCommandId]> = [
  ['about', 'about-podium'],
  ['checkUpdates', 'check-updates'],
  ['settings', 'open-settings'],
  ['addProject', 'add-project'],
  ['toggleLeftSidebar', 'toggle-left-sidebar'],
  ['toggleFlightDeck', 'toggle-flight-deck'],
  ['toggleRightSidebar', 'toggle-right-sidebar'],
  ['closeTab', 'close-tab'],
]

/** Install the given hooks, replacing only the keys that are provided. */
export function installDesktopMenuHooks(hooks: DesktopMenuHooks): () => void {
  const assigned = globalThis as unknown as Record<string, MenuHook | undefined>
  const installed: Array<[string, MenuHook]> = []
  for (const [hook, commandId] of HOOK_COMMANDS) {
    const handler = hooks[hook]
    if (!handler) continue
    const globalKey = desktopCommand(commandId).hook
    // Every command in this table declares a hook; the type just cannot say so.
    if (!globalKey) continue
    assigned[globalKey] = handler
    installed.push([globalKey, handler])
  }
  return () => {
    for (const [key, handler] of installed) {
      if (assigned[key] === handler) delete assigned[key]
    }
  }
}
