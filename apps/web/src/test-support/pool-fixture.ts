/** Historical synthetic UI fixtures feed the real pool at the test boundary. */

import type { Store } from '@podium/client-core/engine'
import { allIssueViewModels } from '@podium/client-core/replica'
import { reposToViews } from '@podium/client-core/viewmodels'
import { MobxPool } from '@podium/client-graph'
import { attachHeaderSource } from '@podium/client-graph/header-source'
import { ISSUE_BOARD_ENTITIES } from '@podium/client-graph/issue-board-schema'
import { createIssueBoardSource } from '@podium/client-graph/issue-board-source'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach } from 'vitest'
import { useStoreSelector } from '@/app/store'
import { normalizedFixtureStore } from './normalized-issues'
import type { RowSourceEvent } from '@podium/client-graph'
import { fixtureStoreSnapshot } from './fixture-store'

let pool: MobxPool | null = null
let signature: string | undefined
let seededIssues: readonly unknown[] = []
let headerFixture = false
let stopHeader: (() => void) | undefined
let fixtureState: Store
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
})

/** Historical page tests supplied their fixture row as a prop. */
export function seedPoolFixture(issues: readonly unknown[]) {
  seededIssues = issues
}

/** Complete the fake authority's batched answer for an absent reference. */
export function resolvePoolFixtureReference(ref: string, id: string | null) {
  if (!pool) throw new Error('Fixture pool has not mounted')
  pool.references.resolved(ref, id)
}

function useFixturePool() {
  const state = useStoreSelector((state) => state) as Store & {
    issues?: readonly unknown[]
    hostMetrics?: import('@podium/model/browser').HostMetricsWire[]
  }
  fixtureState = fixtureStoreSnapshot({ ...state, view: state.view ?? 'workspace', paneA: state.paneA ?? null, fileTabs: state.fileTabs ?? [], outboxSize: state.outboxSize ?? 0, machines: state.machines ?? [], repos: state.repos ?? [] } as Store)
  const fixtureIssues = state.issues?.length ? state.issues : seededIssues
  const nextSignature = JSON.stringify([
    fixtureIssues,
    state.issueProjections,
    state.issueUserStates,
    state.sessions,
    state.repos,
    state.machines,
    state.selectedIssueId,
    state.coarseNow,
    state.hostMetrics,
  ])
  if (!pool) {
    pool = new MobxPool({
      selectedIssueId: state.selectedIssueId ?? null,
      coarseNow: state.coarseNow ?? Date.now(),
    })
    pool.sources.register(ISSUE_BOARD_ENTITIES, createIssueBoardSource(pool))
    pool.sources.register(['issueExit'], { read: () => ({ kind: undefined }), dispose() {} })
  }
  if (signature !== nextSignature) {
    signature = nextSignature
    const normalized = state.replica && state.issueProjections
      ? state
      : normalizedFixtureStore({ ...state, issues: fixtureIssues })
    const issues = allIssueViewModels(normalized.replica, normalized.issueProjections, normalized.issueUserStates)
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
        ...worktrees.filter((tree) => !repoWorktrees.some((row) => row.id === tree.path)).map((value) => ({ kind: 'worktree' as const, id: value.path, value })),
      ]
    const nextRows = new Map(rows.map((row) => [JSON.stringify([row.kind, row.id]), row]))
    pool.apply({ type: 'update', rows: [
      ...rows,
      ...[...previousRows].flatMap(([key, row]) => nextRows.has(key) ? [] : [{ ...row, value: undefined }]),
    ] })
    previousRows = nextRows
    const selectionChanged = (pool.selection.keys().next().value ?? null) !== (state.selectedIssueId ?? null)
    pool.applyLocals(
      { selectedIssueId: state.selectedIssueId ?? null, coarseNow: state.coarseNow ?? Date.now() },
      new Set(selectionChanged ? ['selectedIssueId', 'coarseNow'] : ['coarseNow']),
    )
    pool.header.apply(
      (state.machines ?? []).map((value) => ({ kind: 'machine', id: value.id, value })),
    )
    pool.header.order(
      'machine',
      (state.machines ?? []).map((value) => value.id),
    )
    const repositories = (state.repos ?? []).map((value) => ({
      kind: 'repository' as const,
      id: JSON.stringify([value.machineId ?? '', value.path]),
      value,
    }))
    pool.header.apply(repositories)
    pool.header.order(
      'repository',
      repositories.map((value) => value.id),
    )
    queueMicrotask(() => { for (const listener of headerListeners) listener() })
  }
  if (headerFixture && !stopHeader) {
    const subscribe = (listener: () => void) => {
      headerListeners.add(listener)
      return () => {
        headerListeners.delete(listener)
      }
    }
    const owner = {
      getSnapshot: () => fixtureState,
      subscribe,
      replica: { rows: () => [], subscribeAddressedBatch: () => () => {} },
      hostMetrics: { getSnapshot: () => (fixtureState as typeof state).hostMetrics ?? [], subscribe },
      hub: {
        connectionHealth: () => ({ status: 'ok', rttMs: null, since: Date.now() }),
        onConnectionHealth: () => () => {},
      },
    }
    stopHeader = attachHeaderSource(pool, owner as never)
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
