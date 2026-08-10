/**
 * Handle the desktop shell's Close Tab command (Cmd+W).
 *
 * A tab is a VIEW (POD-710), so Cmd+W closes whatever is active — session tab or
 * file tab alike — and never touches the session behind it. The boolean is the
 * contract with the Tauri shell (`apps/desktop/src-tauri/src/main.rs`): `true`
 * means "handled, do not fall through to the window-level close (hide)". Only a
 * workspace with no active tab (or an unmounted Workspace, where the global is
 * absent entirely) lets the shell have the keystroke back.
 */
export function closeActiveWorkspaceTab(
  activeTabId: string | null | undefined,
  closeTab: (tabId: string) => void,
): boolean {
  if (!activeTabId) return false
  closeTab(activeTabId)
  return true
}
