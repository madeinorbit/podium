import { useStoreHandle } from '@podium/client-core/react'
import { LOADING } from '@podium/client-graph'
import type { CommandLaunchData } from '@podium/client-graph/command-launch-views'
import type { Loaded } from '@podium/client-graph/worklist/rollup'
import { useMemo } from 'react'
import {
  EMPTY_FILES,
  EMPTY_SESSIONS,
  readFiles,
  readGuardSessions,
  readLaunch,
  readOpen,
  readPalette,
} from './command-launch-readers'
import type { Store } from './store'
import { useWorklistPoolProjection } from './store-worklist-pool'
import type { Trpc } from './trpc'

/** Only identity-stable handles/actions are acquired here. No live field is
 * borrowed from a snapshot on the pool branch. The mutation owner is unchanged. */
const ACTION_KEYS = [
  'trpc',
  'setPaletteOpen',
  'closeIssue',
  'markIssueRead',
  'markIssueUnread',
  'updateIssue',
  'deleteIssue',
  'deferIssue',
  'undeferIssue',
  'setIssueLabels',
  'restoreIssue',
  'markSessionRead',
  'markSessionUnread',
  'setPane',
  'setView',
  'setSettingsTab',
  'setSelectedWorktree',
  'setSelectedIssueId',
  'setOpenIssueId',
  'setSnooze',
  'clearSnooze',
  'hibernateSession',
  'resurrectSession',
  'startBtw',
  'spawnDraftAgent',
  'setPanelMode',
  'openFileInWorktree',
  'openArtifact',
] as const satisfies readonly (keyof Store)[]
type CommandLaunchActions = Pick<Store, (typeof ACTION_KEYS)[number]>
const statics = (s: Store): CommandLaunchActions =>
  Object.fromEntries(ACTION_KEYS.map((key) => [key, s[key]])) as CommandLaunchActions
export function useCommandLaunchActions(): CommandLaunchActions {
  const owner = useStoreHandle<Trpc>()
  return useMemo(() => statics(owner.getSnapshot()), [owner])
}
export function useCommandLaunchData(): Loaded<CommandLaunchData> {
  return useWorklistPoolProjection(readLaunch, LOADING)
}
export function useCommandPaletteData(): Loaded<CommandLaunchData> {
  return useWorklistPoolProjection(readPalette, LOADING)
}
export function useCommandPaletteOpen() {
  return useWorklistPoolProjection(readOpen, false)
}
export function useCommandGuardSessions() {
  return useWorklistPoolProjection(readGuardSessions, EMPTY_SESSIONS)
}
export function useCommandRecentFiles() {
  return useWorklistPoolProjection(readFiles, EMPTY_FILES)
}
