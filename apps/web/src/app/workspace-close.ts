/**
 * Handle the desktop shell's Close Tab command (Cmd+W).
 *
 * A tab is a VIEW (POD-710), so Cmd+W closes whatever is active — session tab or
 * file tab alike — and never touches the session behind it. While the selected
 * issue still has any open tabs, the command closes one (the active tab if it is
 * still in the strip, otherwise the first remaining tab). An empty workspace is
 * a no-op: the Tauri shell must not hide or close the main window. Quit is Cmd+Q.
 */
export function closeActiveWorkspaceTab(
  activeTabId: string | null | undefined,
  closeTab: (tabId: string) => void,
  openTabIds: readonly string[] = [],
): boolean {
  const preferred =
    activeTabId && (openTabIds.length === 0 || openTabIds.includes(activeTabId))
      ? activeTabId
      : null
  const tabId = preferred ?? openTabIds[0]
  if (!tabId) return false
  closeTab(tabId)
  return true
}
