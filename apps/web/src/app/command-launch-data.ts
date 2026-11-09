import { useClientRuntime, useCommands, useRequestClient, useUi } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import type { RepoView } from '@podium/client-core/values'
import { LOADING } from '@podium/client-graph'
import type { CommandPaletteData, RecentCommand } from '@podium/client-graph/command-launch-views'
import { omitGone } from '@podium/client-graph/lookup'
import type { Loaded } from '@podium/client-graph/worklist/rollup'
import type { MachineFacts } from '@podium/model/browser'
import { runInAction } from 'mobx'
import { useEffect, useMemo, useState } from 'react'
import {
  EMPTY_FILES,
  readCommandViews,
  readFiles,
  readLaunchOptions,
  readLaunchOrigin,
  readOpen,
  readSession,
  readSessions,
  readTargetMachines,
} from './command-launch-readers'
import { useWorklistPool, useWorklistPoolProjection } from './store-worklist-pool'
import type { Trpc } from './trpc'

/** Only identity-stable handles/actions are acquired here. No live field is
 * borrowed from a snapshot on the pool branch. The mutation owner is unchanged. */
export function useCommandLaunchActions() {
  const owner = useClientRuntime<Trpc>()
  const commands = useCommands<Trpc>()
  const ui = useUi()
  const trpc = useRequestClient<Trpc>()
  return useMemo(
    () => ({
      trpc: trpc,
      setPaletteOpen: owner.palette.setOpen,
      closeIssue: commands.issues.close,
      markIssueRead: commands.issues.markRead,
      markIssueUnread: commands.issues.markUnread,
      updateIssue: commands.issues.update,
      setPinned: commands.preferences.setPinned,
      deleteIssue: commands.issues.delete,
      deferIssue: commands.issues.defer,
      undeferIssue: commands.issues.undefer,
      setIssueLabels: commands.issues.setLabels,
      restoreIssue: commands.issues.restore,
      markSessionRead: commands.sessions.markRead,
      markSessionUnread: commands.sessions.markUnread,
      setPane: ui.setPane,
      setView: ui.setView,
      setSettingsTab: ui.setSettingsTab,
      setSelectedWorktree: ui.setSelectedWorktree,
      setSelectedIssueId: ui.setSelectedIssueId,
      setOpenIssueId: ui.setOpenIssueId,
      setSnooze: commands.sessions.snooze,
      clearSnooze: commands.sessions.clearSnooze,
      hibernateSession: commands.sessions.hibernate,
      resurrectSession: commands.sessions.resume,
      startBtw: commands.sessions.startBtw,
      spawnDraftAgent: commands.sessions.spawnDraftAgent,
      spawnIssueAgent: commands.sessions.spawnIssueAgent,
      launchSession: commands.sessions.launch,
      startIssueSession: commands.sessions.startIssueSession,
      setPanelMode: ui.setPanelMode,
      openFileInWorktree: ui.openFileInWorktree,
      openArtifact: ui.openArtifact,
    }),
    [commands, ui, trpc, owner],
  )
}
export function useCommandLaunchCatalog() {
  const pool = useWorklistPool()
  const options = useWorklistPoolProjection(readLaunchOptions, undefined)
  const picker = useMemo(() => options?.picker(), [options])
  useEffect(() => {
    if (pool && picker) picker.open()
  }, [pool, picker])
  const read = useMemo(() => () => (picker?.opened ? picker.catalog() : LOADING), [picker])
  return useWorklistPoolProjection(read, LOADING)
}
/** A tab-strip menu draws one origin and the displayed machines. Recency is a
 * scalar per machine, so opening it never acquires session choice rows. */
export function useCommandLaunchOrigin(path: string, machineId?: string) {
  const read = useMemo(
    () => (pool: Parameters<typeof readLaunchOrigin>[0]) => readLaunchOrigin(pool, path, machineId),
    [path, machineId],
  )
  return useWorklistPoolProjection<Loaded<ReturnType<typeof readLaunchOrigin>>>(read, LOADING)
}
export function useCommandTargetMachines(repo: RepoView | undefined, machines: MachineFacts[], kinds: readonly string[]) {
  const pool = useWorklistPool()
  const kindsKey = JSON.stringify(kinds)
  const path = repo?.path
  const [preferred, setPreferred] = useState<Record<string, string | undefined>>({})
  useEffect(() => {
    if (pool)
      runInAction(() =>
        setPreferred(readTargetMachines(pool, repo, machines, JSON.parse(kindsKey))),
      )
    // Initial recency is taken on open or when the user changes repository/kinds.
    // Eligibility/auth changes go through the live reader below.
    // biome-ignore lint/correctness/useExhaustiveDependencies: recency is stored on open
  }, [pool, path, kindsKey])
  const read = useMemo(
    () => (pool: Parameters<typeof readTargetMachines>[0]) =>
      readTargetMachines(pool, repo, machines, JSON.parse(kindsKey) as string[], preferred),
    [repo, machines, kindsKey, preferred],
  )
  return useWorklistPoolProjection(read, {} as Record<string, string | undefined>)
}

type CommandPaletteSnapshot = {
  data: Loaded<CommandPaletteData>
  sessions: SessionView[]
  selectedSessions: SessionView[]
  recent: RecentCommand[]
  defaultAgent: SessionView['agentKind']
}
export function useCommandPaletteSnapshot(active = true): CommandPaletteSnapshot | undefined {
  const views = useWorklistPoolProjection(readCommandViews, undefined, active)
  const picker = useMemo(() => (views && active ? views.picker() : undefined), [views, active])
  useEffect(() => {
    if (active) picker?.open()
    return () => picker?.close()
  }, [picker, active])
  const read = useMemo(
    () => (): CommandPaletteSnapshot | undefined =>
      picker && {
        data: picker.palette(),
        sessions: picker.sessions,
        selectedSessions: picker.selectedSessions,
        recent: picker.recent,
        defaultAgent: picker.defaultAgent,
      },
    [picker],
  )
  return useWorklistPoolProjection(read, undefined, active)
}
export function useCommandPaletteData(active = true): Loaded<CommandPaletteData> {
  return useCommandPaletteSnapshot(active)?.data ?? LOADING
}
export function useCommandSessions(): Loaded<SessionView[]> {
  return useWorklistPoolProjection(readSessions, LOADING)
}
export function useCommandSession(id: string | null): Loaded<SessionView> {
  const views = useWorklistPoolProjection(readCommandViews, undefined, id !== null)
  const row = useMemo(() => (views && id !== null ? views.sessionRow(id) : undefined), [views, id])
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
  const read = useMemo(
    () => (pool: Parameters<typeof readSession>[0]) => {
      if (id === null) return undefined
      const reader = omitGone(pool.row('chatContextReader', 'reader'))
      const issue = reader && reader !== LOADING ? reader.issue(id) : undefined
      return issue && issue !== LOADING
        ? {
            id: issue.id,
            seq: issue.seq,
            title: issue.title,
            stage: issue.stage,
            displayRef: issue.displayRef,
            linearIdentifier: issue.linearIdentifier,
          }
        : undefined
    },
    [id],
  )
  return useWorklistPoolProjection(read, undefined)
}

/** Command handlers resolve the addressed session at press time. */
export function useCommandSessionLookup() {
  const pool = useWorklistPool()
  return useMemo(
    () => (id: string) => (pool ? runInAction(() => readSession(pool, id)) : undefined),
    [pool],
  )
}
