import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import { headerEntities } from '@podium/client-graph/header-entities'
import { headerRequests } from '@podium/client-graph/header-requests'
import { referenceView } from '@podium/client-graph/issue-reference'
import { liveFixture } from '@podium/client-graph/live-fixture'
import { attachPreferenceSource } from '@podium/client-graph/preference-source'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import { observable, runInAction } from 'mobx'

/** Historical synthetic UI fixtures feed the real pool at the test boundary. */

import type { RoutedUiState } from '@podium/client-core/ui-state'
import { reposToViews } from '@podium/client-core/values'
import type { RowSourceEvent } from '@podium/client-graph'
import { MobxPool } from '@podium/client-graph'
import { attachHeaderSource } from '@podium/client-graph/header-source'
import { ISSUE_BOARD_ENTITIES } from '@podium/client-graph/issue-board-schema'
import { createIssueBoardSource } from '@podium/client-graph/issue-board-source'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach } from 'vitest'
import { useRuntimeSelector as readFixtureSnapshot } from '@/app/store'
import { allIssueViewModels } from '../../../../tests/worklist/diagnostics/reference/issue-view-models'
import type { ReferenceState as Store } from '../../../../tests/worklist/diagnostics/reference-state'
import { fixtureStoreSnapshot } from './fixture-store'
import { poolFixtureStore } from './pool-issue-fixture'

let pool: MobxPool | null = null
let signature: string | undefined
let seededIssues: readonly unknown[] = []
let headerFixture = false
let stopHeader: (() => void) | undefined
let fixtureState: Store
const fixtureExits = observable.map<string, 'evicted'>()
let previousRows = new Map<string, RowSourceEvent['rows'][number]>()
const headerListeners = new Set<() => void>()

export function enableFixtureHeader() {
  headerFixture = true
}

afterEach(() => {
  stopHeader?.()
  stopHeader = undefined
  headerListeners.clear()
  pool?.dispose()
  pool = null
  signature = undefined
  seededIssues = []
  previousRows.clear()
  runInAction(() => fixtureExits.clear())
})

/** Historical page tests supplied their fixture row as a prop. */
export function seedPoolFixture(issues: readonly unknown[]) {
  seededIssues = issues
}

/** Complete the fake authority's batched answer for an absent reference. */
export function resolvePoolFixtureReference(ref: string, id: string | null) {
  if (!pool) throw new Error('Fixture pool has not mounted')
  referenceView(pool).id(ref)
  referenceView(pool).resolved(ref, id)
}

function useFixturePool() {
  return syncPoolFixture(readFixtureSnapshot((state) => state))
}

/** Simulate an owner publication when a test mutates its plain fake snapshot. */
export function publishPoolFixture() {
  syncPoolFixture(readFixtureSnapshot((state) => state))
}

/** Fake actions publish through the same boundary as a render's snapshot. */
export function syncPoolFixture(
  input: import('@podium/client-core/engine').Store,
  sidebarGesture = false,
) {
  const state = input as unknown as Store & {
    issues?: readonly unknown[]
    selectedIssueWasFolded?: boolean
    hostMetrics?: import('@podium/model/browser').HostMetricsWire[]
  }
  fixtureState = fixtureStoreSnapshot({
    ...state,
    view: state.view ?? 'workspace',
    paneA: state.paneA ?? null,
    fileTabs: state.fileTabs ?? [],
    machines: state.machines ?? [],
    repos: state.repos ?? [],
  } as Store)
  const fixtureIssues = state.issues?.length ? state.issues : seededIssues
  const nextSignature = JSON.stringify([
    fixtureIssues,
    state.issueProjections,
    state.issueUserStates,
    state.sessions,
    state.repos,
    state.machines,
    state.selectedIssueId,
    state.selectedIssueWasFolded,
    state.coarseNow,
    state.hostMetrics,
  ])
  if (!pool) {
    pool = new MobxPool({
      selectedIssueId: state.selectedIssueId ?? null,
      coarseNow: state.coarseNow ?? Date.now(),
    })
    if (state.uiState) attachPreferenceSource(pool, state.uiState as RoutedUiState)
    pool.sources.register(ISSUE_BOARD_ENTITIES, createIssueBoardSource(pool))
    // POD-3911: the fixture authority supplies the same exit evidence as the live source.
    pool.sources.register(['issueExit'], {
      read: (_entity, id) => ({
        kind: fixtureState.replica?.exitKind?.('issueProjection', id) ?? fixtureExits.get(id),
      }),
      dispose() {},
    })
  }
  if (signature !== nextSignature) {
    signature = nextSignature
    const normalized =
      state.replica && state.issueProjections
        ? state
        : poolFixtureStore({ ...state, issues: fixtureIssues })
    const issues = allIssueViewModels(
      normalized.replica,
      normalized.issueProjections,
      normalized.issueUserStates,
    )
    const worktrees = reposToViews(state.repos ?? []).flatMap((repo) =>
      repo.worktrees.map((tree) => ({
        ...tree,
        repoPath: repo.path,
        repoName: repo.name,
        repoId: repo.repoId,
        projectRoot: tree.path === repo.path,
      })),
    )
    // Repos arrive as companion facts on the existing worktree feed.
    const repoRows = normalized.replica.rows('repos')
    const repoWorktrees = repoRows.map((repo) => ({
      kind: 'worktree' as const,
      id: repo.repoPath || `fixture:${repo.id}`,
      value: {
        ...worktrees.find((tree) => tree.path === repo.repoPath),
        path: repo.repoPath || `fixture:${repo.id}`,
        repoId: repo.id,
        repoPath: repo.repoPath ?? '',
        repoName: repo.repoPath?.split('/').at(-1) ?? 'fixture',
        prefix: repo.prefix,
        projectRoot: true,
      },
    }))
    const rows: RowSourceEvent['rows'] = [
      ...repoWorktrees,
      ...issues.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
      ...(state.sessions ?? []).map((value) => ({
        kind: 'session' as const,
        id: value.sessionId,
        value,
      })),
      ...worktrees
        .filter((tree) => !repoWorktrees.some((row) => row.id === tree.path))
        .map((value) => ({ kind: 'worktree' as const, id: value.path, value })),
    ]
    const nextRows = new Map(rows.map((row) => [JSON.stringify([row.kind, row.id]), row]))
    // POD-3911: a removed fixture row models an unshare, with explicit eviction evidence.
    runInAction(() => {
      for (const row of rows) if (row.kind === 'issue') fixtureExits.delete(row.id)
      for (const [key, row] of previousRows)
        if (row.kind === 'issue' && !nextRows.has(key)) fixtureExits.set(row.id, 'evicted')
    })
    pool.apply({
      type: 'update',
      rows: [
        ...rows,
        ...[...previousRows].flatMap(([key, row]) =>
          nextRows.has(key) ? [] : [{ ...row, value: undefined }],
        ),
      ],
    })
    previousRows = nextRows
    const selectionChanged = worklistView(pool).selectedId !== (state.selectedIssueId ?? null)
    pool.clock.advance(state.coarseNow ?? Date.now())
    pool.applyLocals(
      {
        selectedIssueId: state.selectedIssueId ?? null,
        coarseNow: state.coarseNow ?? Date.now(),
        selectedIssueWasFolded: sidebarGesture
          ? undefined
          : (state.selectedIssueWasFolded ?? false),
      },
      new Set(
        selectionChanged
          ? sidebarGesture
            ? ['selectedIssueId', 'coarseNow']
            : ['selectedIssueId', 'selectedIssueWasFolded', 'coarseNow']
          : typeof state.selectedIssueWasFolded === 'boolean'
            ? ['selectedIssueWasFolded', 'coarseNow']
            : ['coarseNow'],
      ),
    )
    headerEntities(pool).apply(
      (state.machines ?? []).map((value) => ({ kind: 'machine', id: value.id, value })),
    )
    headerEntities(pool).order(
      'machine',
      (state.machines ?? []).map((value) => value.id),
    )
    const repositories = (state.repos ?? []).map((value) => ({
      kind: 'repository' as const,
      id: JSON.stringify([value.machineId ?? '', value.path]),
      value,
    }))
    headerEntities(pool).apply(repositories)
    headerEntities(pool).order(
      'repository',
      repositories.map((value) => value.id),
    )
    // POD-5798: host samples are LiveStore readings, not header rows.
    const live = liveFixture(pool)
    const sampled = new Set<string>()
    for (const metric of state.hostMetrics ?? []) {
      const id = String(metric.machineId ?? metric.hostname)
      sampled.add(id)
      live.metric(id, metric)
    }
    for (const id of [...live.live.machineMetrics.keys()])
      if (!sampled.has(id)) live.metric(id, undefined)
    queueMicrotask(() => {
      for (const listener of headerListeners) listener()
    })
  }
  if (headerFixture && !stopHeader) {
    const subscribe = (listener: () => void) => {
      headerListeners.add(listener)
      return () => {
        headerListeners.delete(listener)
      }
    }
    const owner = withKeyedInputs({
      getSnapshot: () => fixtureState,
      subscribe,
      replica: { rows: () => [], subscribeAddressedBatch: () => () => {} },
      access: { trpc: fixtureState.trpc },
    })
    const detach = attachHeaderSource(pool, owner as never)
    const release = headerRequests(pool)?.retain()
    // Quota and usage are pushed (POD-5798): a fixture's `quota.summary` and
    // `usage.summary` answers stand in for the server's account.quota value.
    const api = fixtureState.trpc as {
      quota?: { summary?: { query?: () => Promise<unknown> } }
      usage?: { summary?: { query?: () => Promise<unknown> } }
    }
    const fixturePool = pool as MobxPool
    if (api.quota?.summary?.query || api.usage?.summary?.query)
      void Promise.all([
        Promise.resolve(api.quota?.summary?.query?.()).catch(() => undefined),
        Promise.resolve(api.usage?.summary?.query?.()).catch(() => undefined),
      ]).then(([machines, usage]) => {
        const live = liveFixture(fixturePool)
        live.quota({ machines: Array.isArray(machines) ? machines : [] })
        live.usage((usage as never) ?? null)
      })
    stopHeader = () => {
      release?.()
      detach()
    }
  }
  return pool
}

export const fixturePoolHooks = {
  useWorklistPool: useFixturePool,
  useWorklistPoolProjection<T>(read: (pool: MobxPool) => T, _empty: T): T {
    const current = useFixturePool()
    const projection = useMemo(() => createPoolProjection(current, read), [current, read])
    return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
  },
}
