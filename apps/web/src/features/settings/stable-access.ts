import {
  useClientRuntime,
  useCommands,
  useDeviceState,
  useRequestClient,
  useUi,
} from '@podium/client-core/react'
import { useMemo } from 'react'
import type { Trpc } from '@/app/trpc'

export function useSettingsClient() {
  const owner = useClientRuntime<Trpc>()
  const commands = useCommands<Trpc>()
  const ui = useUi()
  const trpc = useRequestClient<Trpc>()
  const deviceState = useDeviceState()
  return useMemo(
    () => ({
      owner,
      trpc: trpc,
      uiState: deviceState,
      navigateToSession: ui.navigateToSession,
      setSettingsTab: ui.setSettingsTab,
      focusIssueSession: ui.focusIssueSession,
      spawnDraftAgent: commands.sessions.spawnDraftAgent,
      spawnIssueAgent: commands.sessions.spawnIssueAgent,
      startIssueSession: commands.sessions.startIssueSession,
      setSelectedIssueId: ui.setSelectedIssueId,
      setSelectedWorktree: ui.setSelectedWorktree,
      setPane: ui.setPane,
      setPanelMode: ui.setPanelMode,
      setView: ui.setView,
      setOpenIssueId: ui.setOpenIssueId,
      setPreferences: commands.preferences.setPreferences,
      setInstancePreferences: commands.preferences.setInstancePreferences,
    }),
    [commands, ui, trpc, deviceState, owner],
  )
}

export type SettingsClient = ReturnType<typeof useSettingsClient>
export function useSettingsTrpc(): Trpc {
  return useRequestClient<Trpc>()
}
