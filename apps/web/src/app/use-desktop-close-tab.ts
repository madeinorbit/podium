import { observer } from 'mobx-react-lite'
import { allTabIds, emptyWorkspace, focusedPane } from '@podium/client-core/viewmodels'
import { useEffect } from 'react'
import { installDesktopMenuHooks } from './desktop-menu'
import { useShellActions, useShellClose } from './shell-data'
import { closeActiveWorkspaceTab } from './workspace-close'

export const DesktopCloseTab = observer(function DesktopCloseTab(): null {
  useDesktopCloseTab()
  return null
})

/**
 * Cmd+W for the selected issue's workspace, even when Workspace is unmounted
 * (the issues board, settings sheet). Lives above the outlet so an empty
 * tab strip cannot fall through to a window close.
 */
export function useDesktopCloseTab(): void {
  const { closeFileTab, closeWorkspaceTab } = useShellActions()
  const data = useShellClose()

  useEffect(() => {
    // An unattached/loading pool owns no writable tab. Keep Cmd+W handled
    // during startup, then use the hydrated layout without a legacy fallback.
    const layout = data?.layout ?? emptyWorkspace(data?.workspaceKey ?? 'none')
    const openTabIds = allTabIds(layout)
    const activeTabId = focusedPane(layout).activeTabId
    const fileIds = new Set((data?.fileTabs ?? []).map((file) => file.id))
    const closeTab = (tabId: string): void => {
      if (fileIds.has(tabId)) closeFileTab(tabId)
      else closeWorkspaceTab(tabId)
    }
    return installDesktopMenuHooks({
      closeTab: () => closeActiveWorkspaceTab(activeTabId, closeTab, openTabIds),
    })
  })
}
