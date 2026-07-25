import type { DeckTab } from './panel-deck'

/**
 * Handle the desktop shell's Close Tab command.
 *
 * Session tabs are task members, not disposable views. Consume Cmd+W for them
 * without closing the session or letting the desktop shell hide the window.
 */
export function closeWorkspaceTab(
  active: DeckTab | undefined,
  closeFileTab: (id: string) => void,
): boolean {
  if (!active) return false
  if (active.kind === 'file') closeFileTab(active.id)
  return true
}
