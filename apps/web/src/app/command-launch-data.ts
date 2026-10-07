import { useStoreHandle } from '@podium/client-core/react'
import { LOADING } from '@podium/client-graph'
import { CommandSessionRow, createCommandPalette, type CommandLaunchData } from '@podium/client-graph/command-launch-views'
import { chatIssue } from '@podium/client-graph/chat-context'
import { createLaunchCatalogPicker } from '@podium/client-graph/launch-option-views'
import type { SessionView } from '@podium/client-core/session-values'
import type { RepoView } from '@podium/client-core/values'
import type { MachineWire } from '@podium/model/browser'
import type { Loaded } from '@podium/client-graph/worklist/rollup'
import { when } from 'mobx'
import { useEffect, useMemo } from 'react'
import {
  EMPTY_FILES,
  readFiles,
  readLaunchOrigin,
  readLaunchCatalog,
  readTargetMachines,
  readOpen,
  readPalette,
  readSession,
  readSessions,
} from './command-launch-readers'
import type { Store } from './store'
import { useWorklistPool, useWorklistPoolProjection } from './store-worklist-pool'
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
export function useCommandLaunchCatalog() {
  const pool = useWorklistPool()
  const picker = useMemo(() => pool ? createLaunchCatalogPicker(pool) : undefined, [pool])
  useEffect(() => {
    if (!pool || !picker) return
    return when(() => readLaunchCatalog(pool) !== LOADING, () => picker.open())
  }, [pool, picker])
  const read = useMemo(() => () => picker?.catalog() ?? LOADING, [picker])
  return useWorklistPoolProjection<Loaded<ReturnType<typeof readLaunchCatalog>>>(read, LOADING)
}
/** A tab-strip menu draws one origin and the displayed machines. Recency is a
 * scalar per machine, so opening it never acquires session choice rows. */
export function useCommandLaunchOrigin(path: string) {
  const read = useMemo(() => (pool: Parameters<typeof readLaunchOrigin>[0]) =>
    readLaunchOrigin(pool, path), [path])
  return useWorklistPoolProjection<Loaded<ReturnType<typeof readLaunchOrigin>>>(read, LOADING)
}
export function useCommandTargetMachines(repo: RepoView | undefined, machines: MachineWire[], kinds: readonly string[]) {
  const kindsKey = JSON.stringify(kinds)
  const read = useMemo(() => (pool: Parameters<typeof readTargetMachines>[0]) =>
    readTargetMachines(pool, repo, machines, JSON.parse(kindsKey) as string[]), [repo, machines, kindsKey])
  return useWorklistPoolProjection(read, {} as Record<string, string | undefined>)
}
export function useCommandPaletteSnapshot(active = true) {
  const pool = useWorklistPool()
  const picker = useMemo(() => pool ? createCommandPalette(pool) : undefined, [pool])
  useEffect(() => { if (active) picker?.open(); return () => picker?.close() }, [picker, active])
  const read = useMemo(() => () => picker && { data: picker.palette(), sessions: picker.sessions, recent: picker.recent }, [picker])
  return useWorklistPoolProjection(read, undefined, active)
}
export function useCommandPaletteData(active = true): Loaded<CommandLaunchData> {
  return useCommandPaletteSnapshot(active)?.data ?? LOADING
}
export function useCommandSessions(): Loaded<SessionView[]> {
  return useWorklistPoolProjection(readSessions, LOADING)
}
export function useCommandSession(id: string | null): Loaded<SessionView> {
  const pool = useWorklistPool()
  const row = useMemo(() => pool && id !== null ? new CommandSessionRow(pool, id) : undefined, [pool, id])
  const read = useMemo(() => () => row?.presentation, [row])
  return useWorklistPoolProjection(read, LOADING)
}

export function useCommandPaletteOpen() {
  return useWorklistPoolProjection(readOpen, false)
}
export function useCommandRecentFiles() {
  return useWorklistPoolProjection(readFiles, EMPTY_FILES)
}

export function useCommandIssue(id: string | null) {
  const read = useMemo(() => (pool: Parameters<typeof readSession>[0]) => {
    if (id === null) return undefined
    const issue = chatIssue(pool, id)
    return issue && issue !== LOADING ? {
      id: issue.id, seq: issue.seq, title: issue.title, stage: issue.stage,
      displayRef: issue.displayRef, linearIdentifier: issue.linearIdentifier, color: issue.color,
    } : undefined
  }, [id])
  return useWorklistPoolProjection(read, undefined)
}
