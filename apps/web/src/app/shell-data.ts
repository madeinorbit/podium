import { omitGone } from '@podium/client-graph/lookup'
import { allowImperativeRead, assertReactiveRead } from '@podium/mobx-helpers'
import { useStoreHandle } from '@podium/client-core/react'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { ShellDock, shellViews } from '@podium/client-graph/shell-views'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { useMemo } from 'react'
import type { Store } from './store'
import { useWorklistPool } from './store-worklist-pool'
import type { Trpc } from './trpc'

/** The lazy runtime installs this shared view before exposing its pool. */
function shellView(pool: MobxPool): ReturnType<typeof shellViews> {
  const view = pool.sources.peekView<ReturnType<typeof shellViews>>('shell-views')
  if (!view) throw new Error('Shell reads require their pool screen')
  return view
}

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
/** The right dock's routing view: an observer reads each field where it is
 * shown (`dock.active`, `dock.gitIssue`, `dock.mailIssueId`, `dock.scope`). */
export function useShellDock(): ShellDock | null {
  if (import.meta.env.DEV) assertReactiveRead('useShellDock')
  const pool = useWorklistPool()
  return pool ? shellView(pool).dock : null
}
const EMPTY_CATALOGS = { issues: [], shipOrders: [], shipLanes: [] } as {
  issues: IssueViewModel[]
  shipOrders: import('@podium/model').ShipOrderProjection[]
  shipLanes: import('@podium/model').ShipLaneProjection[]
}
/** Queue/shipping panels opt into their catalogues; other panels never read them. */
export function useShellDockCatalogs(enabled: boolean): typeof EMPTY_CATALOGS {
  if (import.meta.env.DEV) assertReactiveRead('useShellDockCatalogs')
  const pool = useWorklistPool(),
    value = pool && enabled ? shellView(pool).catalogs() : LOADING
  return value && value !== LOADING ? value : EMPTY_CATALOGS
}
const EMPTY_SHIPPING = { unfinishedCount: 0, decisionCount: 0 }
export function useShellShipping() {
  if (import.meta.env.DEV) assertReactiveRead('useShellShipping')
  const pool = useWorklistPool(),
    value = pool ? shellView(pool).dock.shipping : LOADING
  return value && value !== LOADING ? value : EMPTY_SHIPPING
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
    rows = pool ? shellView(pool).approvals() : LOADING
  return rows && rows !== LOADING ? rows : EMPTY_APPROVALS
}
const EMPTY_APPROVALS: Store['approvals'] = []

const EMPTY_SESSIONS: import('@podium/client-core/session-values').SessionView[] = []
export function useShellLinks() {
  const pool = useWorklistPool(),
    views = pool ? shellView(pool) : null
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
      const value = pool ? shellView(pool).session(id) : undefined
      return value && value !== LOADING ? value : undefined
    }),
    [pool],
  )
}
export function useShellSessions() {
  if (import.meta.env.DEV) assertReactiveRead('useShellSessions')
  const pool = useWorklistPool(),
    value = pool ? shellView(pool).sessions() : LOADING
  return value && value !== LOADING ? value : EMPTY_SESSIONS
}

export function useShellClose() {
  if (import.meta.env.DEV) assertReactiveRead('useShellClose')
  const pool = useWorklistPool(),
    value = pool ? shellView(pool).close() : LOADING
  return value && value !== LOADING ? value : undefined
}
const EMPTY_MACHINES: Store['machines'] = []
export function useShellMachines() {
  if (import.meta.env.DEV) assertReactiveRead('useShellMachines')
  const pool = useWorklistPool()
  return pool ? shellView(pool).machines() : EMPTY_MACHINES
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
    value = pool ? shellView(pool).chrome() : LOADING
  return value && value !== LOADING ? value : EMPTY_CHROME
}
