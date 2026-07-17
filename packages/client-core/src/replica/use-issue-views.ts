/**
 * React bindings for the replica-side issue views [ADR 4 D7.3].
 *
 * `useSyncExternalStore` over the replica's own change seam rather than
 * `useLiveQuery`, for one reason that is not stylistic: **a nested-collection
 * change emits ZERO events on the parent row** (POD-794). A binding built on a
 * single live query over the issue tree would therefore never re-render when a
 * SESSION changes — the issue's `unread` and `sessionSummary` would sit frozen,
 * silently, with no error to notice and a demo that looks perfect. So these
 * bindings subscribe to the issues AND sessions collections and derive across
 * both. `subscribeRows` already coalesces per application, so a whole
 * bootstrap/heal/delta wakes each of them at most once, against the final state.
 *
 * ## The snapshot is invalidated by NOTIFICATION, not by row identity
 *
 * The obvious memo key — "did the row arrays change identity?" — does not work
 * and fails loudly if you try it: `replica.rows()` reads the collection's
 * `toArray`, which materialises a FRESH array on every call, so identity is
 * never stable and every `getSnapshot` returns a new object. React calls
 * `getSnapshot` on each render and demands a stable reference for unchanged
 * state; hand it a new one each time and it does not merely re-derive too often,
 * it throws "Maximum update depth exceeded" and the view never mounts.
 *
 * So invalidation is driven by the replica's own change notification — the same
 * signal that already coalesces a whole application into one wake — and the
 * derived snapshot is cached per REPLICA rather than per component: every issue
 * surface on screen shares one derivation of each settled state, which is the
 * point of deriving at the replica rather than in each view.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  buildIssueBoard,
  buildIssueTree,
  deriveIssueRollups,
  deriveIssueViews,
  type IssueSessionRollups,
  type IssueTreeNode,
  type IssueView,
  type IssueViewInput,
  readViewInputs,
  type SessionViewInput,
} from './issue-views'
import type { Replica } from './replica'

/** Everything the issue surfaces read, derived once per settled replica state. */
export interface IssueViewsSnapshot {
  views: Map<string, IssueView>
  tree: IssueTreeNode[]
  issues: IssueViewInput[]
  sessions: SessionViewInput[]
  rollupsFor: (issueId: string) => IssueSessionRollups
}

const EMPTY_ROLLUPS: IssueSessionRollups = {
  unread: false,
  sessionSummary: { total: 0, byPhase: {} },
}

/** The derived state of ONE replica, shared by every component reading it. */
interface IssueViewsStore {
  /** Cleared on every replica change; rebuilt on the next read. */
  snapshot: IssueViewsSnapshot | null
  listeners: Set<() => void>
}

/**
 * One store per replica, keyed weakly so a discarded replica takes its store
 * with it.
 *
 * The two `subscribeRows` here are never unsubscribed, which is deliberate and
 * matches what the replica already does for its own collections: a replica is an
 * app-lifetime singleton, and a subscription that came and went with the first
 * component would drop the shared cache the moment the last issue view unmounted
 * — re-deriving the world on the next mount instead of on the next change.
 */
const stores = new WeakMap<Replica, IssueViewsStore>()

function storeFor(replica: Replica): IssueViewsStore {
  const existing = stores.get(replica)
  if (existing) return existing
  const store: IssueViewsStore = { snapshot: null, listeners: new Set() }
  stores.set(replica, store)
  const invalidate = (): void => {
    store.snapshot = null
    for (const listener of [...store.listeners]) listener()
  }
  // EVERY collection `readViewInputs` reads [POD-822], not just two: the views
  // now join `issueProjections` (the issue rows) against `issueDeps` (blocked/
  // ready/dependents) and `repos` (displayRef prefix), plus `sessions` for the
  // membership rollups. A dep-edge add or a prefix change lands only in its own
  // collection, so a binding that did not subscribe to it would render a stale
  // `blocked` or `#13` with no error — the same silent-staleness failure the
  // module note describes for sessions. `subscribeRows` coalesces per
  // application, so a whole bootstrap/heal/delta still wakes each at most once.
  replica.subscribeRows('issueProjections', invalidate)
  replica.subscribeRows('issueDeps', invalidate)
  replica.subscribeRows('repos', invalidate)
  replica.subscribeRows('sessions', invalidate)
  return store
}

function deriveSnapshot(replica: Replica): IssueViewsSnapshot {
  const { issues, sessions } = readViewInputs(replica)
  const views = deriveIssueViews(issues, sessions)
  const sessionIndex = new Map(sessions.map((s) => [s.sessionId, s]))
  const issueIndex = new Map(issues.map((i) => [i.id, i]))
  // Rollups are computed on demand and memoised per issue: a list renders
  // hundreds of rows and reads rollups for the few it shows.
  const rollupCache = new Map<string, IssueSessionRollups>()
  return {
    views,
    tree: buildIssueTree(views, issues),
    issues,
    sessions,
    rollupsFor: (issueId) => {
      const hit = rollupCache.get(issueId)
      if (hit) return hit
      const issue = issueIndex.get(issueId)
      const view = views.get(issueId)
      if (!issue || !view) return EMPTY_ROLLUPS
      const rollups = deriveIssueRollups(issue, view.memberSessionIds, (id) => sessionIndex.get(id))
      rollupCache.set(issueId, rollups)
      return rollups
    },
  }
}

/** The derived issue world. Re-derived once per settled replica state, shared. */
export function useIssueViews(replica: Replica): IssueViewsSnapshot {
  const getSnapshot = useCallback((): IssueViewsSnapshot => {
    const store = storeFor(replica)
    // Stable between notifications — which is the contract useSyncExternalStore
    // enforces, loudly. See the module note.
    store.snapshot ??= deriveSnapshot(replica)
    return store.snapshot
  }, [replica])

  const subscribe = useCallback(
    (onChange: () => void) => {
      const store = storeFor(replica)
      store.listeners.add(onChange)
      return () => store.listeners.delete(onChange)
    },
    [replica],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** One issue's view + its session rollups. */
export function useIssueView(
  replica: Replica,
  issueId: string,
): { view: IssueView | undefined; rollups: IssueSessionRollups } {
  const snapshot = useIssueViews(replica)
  return useMemo(
    () => ({ view: snapshot.views.get(issueId), rollups: snapshot.rollupsFor(issueId) }),
    [snapshot, issueId],
  )
}

/** The board, grouped by stage. */
export function useIssueBoard(
  replica: Replica,
  stages: readonly string[],
): Map<string, IssueView[]> {
  const snapshot = useIssueViews(replica)
  return useMemo(() => buildIssueBoard(snapshot.views, snapshot.issues, stages), [snapshot, stages])
}
