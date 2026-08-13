import { shallowEqual } from '@podium/client-core/store'
import { allTabIds, emptyWorkspace, focusedPane } from '@podium/client-core/viewmodels'
import { useEffect } from 'react'
import { installDesktopMenuHooks } from './desktop-menu'
import { useStoreSelector } from './store'
import { closeActiveWorkspaceTab } from './workspace-close'

export function DesktopCloseTab(): null {
  useDesktopCloseTab()
  return null
}

/**
 * Cmd+W for the selected issue's workspace, even when Workspace is unmounted
 * (the issues board, settings sheet). Lives above the outlet so an empty
 * tab strip cannot fall through to a window close.
 */
export function useDesktopCloseTab(): void {
  const { workspaces, workspaceKey, fileTabs, closeFileTab, closeWorkspaceTab } = useStoreSelector(
    (s) => ({
      workspaces: s.workspaces,
      workspaceKey: s.workspaceKey(),
      fileTabs: s.fileTabs,
      closeFileTab: s.closeFileTab,
      closeWorkspaceTab: s.closeWorkspaceTab,
    }),
    shallowEqual,
  )

  useEffect(() => {
    const layout = workspaces[workspaceKey] ?? emptyWorkspace(workspaceKey)
    const openTabIds = allTabIds(layout)
    const activeTabId = focusedPane(layout).activeTabId
    const fileIds = new Set(fileTabs.map((file) => file.id))
    const closeTab = (tabId: string): void => {
      if (fileIds.has(tabId)) closeFileTab(tabId)
      else closeWorkspaceTab(tabId)
    }
    return installDesktopMenuHooks({
      closeTab: () => closeActiveWorkspaceTab(activeTabId, closeTab, openTabIds),
    })
  })
}
