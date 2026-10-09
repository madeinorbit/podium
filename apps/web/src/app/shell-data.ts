import { omitGone } from '@podium/client-graph/lookup'
import { allowImperativeRead, assertReactiveRead } from '@podium/mobx-helpers'
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
    const state = owner.access
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
/** Queue/shipping panels opt into their catalogues; other panels read context only. */
export function useShellDock(includeCatalog = false): ShellDockData {
  if (import.meta.env.DEV) assertReactiveRead('useShellDock')
  const pool = useWorklistPool(),
    value = pool ? shellViews(pool).dock(includeCatalog) : LOADING
  return value && value !== LOADING ? value : EMPTY_DOCK
}
export function useShellShipping() {
  if (import.meta.env.DEV) assertReactiveRead('useShellShipping')
  const pool = useWorklistPool(),
    value = pool ? shellViews(pool).shipping() : LOADING
  return value && value !== LOADING ? value : EMPTY_DOCK.shipping
}

export function useShellWindow() {
  if (import.meta.env.DEV) assertReactiveRead('useShellWindow')
  const pool = useWorklistPool()
  const value = omitGone(pool?.row('shellWindow', 'window'))
  return value === LOADING ? undefined : value
}
export function useShellApprovals() {
  if (import.meta.env.DEV) assertReactiveRead('useShellApprovals')
  const pool = useWorklistPool(),
    rows = pool ? shellViews(pool).approvals() : LOADING
  return rows && rows !== LOADING ? rows : EMPTY_APPROVALS
}
const EMPTY_APPROVALS: Store['approvals'] = []

const EMPTY_SESSIONS: import('@podium/client-core/session-values').SessionView[] = []
export function useShellLinks() {
  const pool = useWorklistPool(),
    views = pool ? shellViews(pool) : null
  return useMemo(
    () => ({
      readSession: (identifier: string) => allowImperativeRead(() => {
        const session = views?.linkedSession(identifier)
        return session && session !== LOADING ? session : undefined
      }),
      readIssue: (identifier: string) => allowImperativeRead(() => {
        const issue = views?.linkedIssue(identifier)
        return issue && issue !== LOADING ? issue : undefined
      }),
      artifactIssue: (id: string) => allowImperativeRead(() => {
        const row = views?.issue(id, true)
        return row && row !== LOADING ? (row as IssueViewModel) : undefined
      }),
      pool,
    }),
    [pool, views],
  )
}
export function useShellSessionResolver() {
  const pool = useWorklistPool()
  return useMemo(
    () => (id: string) => allowImperativeRead(() => {
      const value = pool ? shellViews(pool).session(id) : undefined
      return value && value !== LOADING ? value : undefined
    }),
    [pool],
  )
}
export function useShellSessions() {
  if (import.meta.env.DEV) assertReactiveRead('useShellSessions')
  const pool = useWorklistPool(),
    value = pool ? shellViews(pool).sessions() : LOADING
  return value && value !== LOADING ? value : EMPTY_SESSIONS
}

export function useShellClose() {
  if (import.meta.env.DEV) assertReactiveRead('useShellClose')
  const pool = useWorklistPool(),
    value = pool ? shellViews(pool).close() : LOADING
  return value && value !== LOADING ? value : undefined
}
const EMPTY_MACHINES: Store['machines'] = []
export function useShellMachines() {
  if (import.meta.env.DEV) assertReactiveRead('useShellMachines')
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
  colorIssue: undefined,
  colorById: (_id: string) => undefined,
}
export function useShellChrome() {
  if (import.meta.env.DEV) assertReactiveRead('useShellChrome')
  const pool = useWorklistPool(),
    value = pool ? shellViews(pool).chrome() : LOADING
  return value && value !== LOADING ? value : EMPTY_CHROME
}
