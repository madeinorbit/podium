import { useStoreHandle } from '@podium/client-core/react'
import type { Store } from '@/app/store'
import type { Trpc } from '@/app/trpc'

interface SettingsClient extends Pick<Store,
  'trpc' | 'uiState' | 'navigateToSession' | 'setSettingsTab' |
  'renameMachine' | 'setMachineUpdateChannel' |
  'focusIssueSession' | 'spawnDraftAgent' | 'spawnIssueAgent' | 'startIssueSession' |
  'setSelectedIssueId' |
  'setSelectedWorktree' | 'setPane' | 'setPanelMode' | 'setView' | 'setOpenIssueId' |
  'setPreferences' | 'setInstancePreferences'> {
  readonly owner: { readonly access: Store }
}

/** Acquire the existing transport and mutation owner without subscribing to
 * snapshots. Entity and preference reads belong to the declared pool hooks. */
export function useSettingsClient(): SettingsClient {
  const owner = useStoreHandle<Trpc>()
  const state = owner.access
  return {
    owner,
    trpc: state.trpc,
    uiState: state.uiState,
    navigateToSession: state.navigateToSession,
    renameMachine: state.renameMachine,
    setMachineUpdateChannel: state.setMachineUpdateChannel,
    setSettingsTab: state.setSettingsTab,
    focusIssueSession: state.focusIssueSession,
    spawnDraftAgent: state.spawnDraftAgent,
    spawnIssueAgent: state.spawnIssueAgent,
    startIssueSession: state.startIssueSession,
    setSelectedIssueId: state.setSelectedIssueId,
    setSelectedWorktree: state.setSelectedWorktree,
    setPane: state.setPane,
    setPanelMode: state.setPanelMode,
    setView: state.setView,
    setOpenIssueId: state.setOpenIssueId,
    setPreferences: state.setPreferences,
    setInstancePreferences: state.setInstancePreferences,
  }
}

export function useSettingsTrpc(): Trpc { return useSettingsClient().trpc }
