import { useStoreHandle } from '@podium/client-core/react'
import type { Trpc } from '@/app/trpc'

/** Acquire the existing transport and mutation owner without subscribing to
 * snapshots. Entity and preference reads belong to the declared pool hooks. */
export function useSettingsClient() {
  const owner = useStoreHandle<Trpc>()
  const state = owner.getSnapshot()
  return {
    owner,
    trpc: state.trpc,
    uiState: state.uiState,
    navigateToSession: state.navigateToSession,
    refreshRepos: state.refreshRepos,
    setSettingsTab: state.setSettingsTab,
    focusIssueSession: state.focusIssueSession,
    spawnDraftAgent: state.spawnDraftAgent,
    spawnIssueAgent: state.spawnIssueAgent,
    setSelectedIssueId: state.setSelectedIssueId,
    setSelectedWorktree: state.setSelectedWorktree,
    setPane: state.setPane,
    setPanelMode: state.setPanelMode,
    setView: state.setView,
  }
}

export function useSettingsTrpc(): Trpc { return useSettingsClient().trpc }
