import { useStoreHandle } from '@podium/client-core/react'
import { LOADING } from '@podium/client-graph'
import type { CommandLaunchData } from '@podium/client-graph/command-launch-views'
import type { SessionView } from '@podium/client-core/session-values'
import type { Loaded } from '@podium/client-graph/worklist/rollup'
import { useMemo } from 'react'
import {
  EMPTY_FILES,
  readFiles,
  readLaunch,
  readOpen,
  readPalette,
  readSession,
  readSessions,
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
  return useMemo(() => statics(owner.access), [owner])
}
export function useCommandLaunchData(): Loaded<CommandLaunchData> {
  return useWorklistPoolProjection(readLaunch, LOADING)
}
export function useCommandPaletteData(active = true): Loaded<CommandLaunchData> {
  // The open dialog owns catalog demand and releases it on unmount.
  return useWorklistPoolProjection(readPalette, LOADING, active)
}
export function useCommandSessions(): Loaded<SessionView[]> {
  return useWorklistPoolProjection(readSessions, LOADING)
}
export function useCommandSession(id: string | null): Loaded<SessionView> {
  const read = useMemo(() => (pool: Parameters<typeof readSession>[0]) =>
    id === null ? undefined : readSession(pool, id), [id])
  return useWorklistPoolProjection(read, LOADING)
}
export function useCommandPaletteOpen() {
  return useWorklistPoolProjection(readOpen, false)
}
export function useCommandRecentFiles() {
  return useWorklistPoolProjection(readFiles, EMPTY_FILES)
}
