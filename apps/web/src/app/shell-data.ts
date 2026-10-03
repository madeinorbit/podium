import { useStoreHandle } from '@podium/client-core/react'
import type { IssueViewModel } from '@podium/client-core/replica'
import { type ShellDockData, shellViews } from '@podium/client-graph/shell-views'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { useMemo } from 'react'
import type { Store } from './store'
import { useWorklistPool } from './store-worklist-pool'
import type { Trpc } from './trpc'

/** Identity-stable actions/transports only; the existing runtime remains the
 * mutation owner. Live values never come from this one-time acquisition. */
const ACTIONS = [
  'trpc',
  'hub',
  'httpOrigin',
  'uiState',
  'navigateToSession',
  'closeAutoContinuePrompt',
  'setSelectedIssueId',
  'setView',
  'setSuperOpen',
  'setPaletteOpen',
  'setOpenIssueId',
  'openArtifact',
  'openFileInWorktree',
  'closeFileTab',
  'closeWorkspaceTab',
  'setSettingsTab',
] as const satisfies readonly (keyof Store)[]
export function useShellActions(): Pick<Store, (typeof ACTIONS)[number]> {
  const owner = useStoreHandle<Trpc>()
  return useMemo(() => {
    const state = owner.getSnapshot()
    return Object.fromEntries(ACTIONS.map((key) => [key, state[key]])) as Pick<
      Store,
      (typeof ACTIONS)[number]
    >
  }, [owner])
}
const EMPTY_DOCK: ShellDockData = {
  active: null,
  scope: null,
  gitIssue: undefined,
  mailIssueId: undefined,
  issues: [],
  shipOrders: [],
  shipLanes: [],
  coarseNow: 0,
  shipping: { unfinishedCount: 0, decisionCount: 0 },
}
export function useShellDock(): ShellDockData {
  const pool = useWorklistPool(),
    value = pool ? shellViews(pool).dock() : LOADING
  return value && value !== LOADING ? value : EMPTY_DOCK
}
export function useShellShipping() {
  const pool = useWorklistPool(),
    value = pool ? shellViews(pool).shipping() : LOADING
  return value && value !== LOADING ? value : EMPTY_DOCK.shipping
}

export function useShellWindow() {
  const pool = useWorklistPool()
  const value = pool?.row('shellWindow', 'window')
  return value === LOADING ? undefined : value
}
export function useShellApprovals() {
  const pool = useWorklistPool(),
    rows = pool ? shellViews(pool).approvals() : LOADING
  return rows && rows !== LOADING ? rows : EMPTY_APPROVALS
}
const EMPTY_APPROVALS: Store['approvals'] = []

const EMPTY_SESSIONS: Store['sessions'] = []
const EMPTY_ISSUES: Store['issueProjections'] = []
export function useShellLinks() {
  const pool = useWorklistPool(),
    views = pool ? shellViews(pool) : null
  const sessions = views?.sessions(),
    issues = views?.issues()
  return {
    sessions: sessions && sessions !== LOADING ? sessions : EMPTY_SESSIONS,
    issues: issues && issues !== LOADING ? issues : (EMPTY_ISSUES as unknown as IssueViewModel[]),
    artifactIssue: (id: string) => {
      const row = views?.issue(id, true)
      return row && row !== LOADING ? (row as IssueViewModel) : undefined
    },
    pool,
  }
}
export function useShellSessions() {
  const pool = useWorklistPool(),
    value = pool ? shellViews(pool).sessions() : LOADING
  return value && value !== LOADING ? value : EMPTY_SESSIONS
}

export function useShellClose() {
  const pool = useWorklistPool(),
    value = pool ? shellViews(pool).close() : LOADING
  return value && value !== LOADING ? value : undefined
}
const EMPTY_MACHINES: Store['machines'] = []
export function useShellMachines() {
  const pool = useWorklistPool()
  return pool ? shellViews(pool).machines() : EMPTY_MACHINES
}

const EMPTY_CHROME = {
  view: 'workspace' as Store['view'],
  reposLoaded: false,
  superOpen: false,
  paletteOpen: false,
  repoCount: 0,
  worktreeCount: 0,
  sessionCount: 0,
  selectedIssueId: null as Store['selectedIssueId'],
  missionRoot: undefined as IssueViewModel | undefined,
  colorIssue: undefined as IssueViewModel | undefined,
  colors: [] as IssueViewModel[],
}
export function useShellChrome() {
  const pool = useWorklistPool(),
    value = pool ? shellViews(pool).chrome() : LOADING
  return value && value !== LOADING ? { ...value, repoCount: 999 } : EMPTY_CHROME
}
