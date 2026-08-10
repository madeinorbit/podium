/**
 * Live read binding for advisory lease locks.
 *
 * Lock rows do not belong in the replicated entity feed: `lock.status` is a
 * small authoritative query whose read also performs lazy lease expiry. This
 * hook bounds that query to one serialized request every five seconds while a
 * consumer is mounted and the document is visible. A transient failure keeps
 * the last good projection on screen and exposes the error beside it.
 *
 * `lock.status` reads EITHER one name or the whole repository, so both hooks
 * here are the same machinery over one optional argument. A caller that wants
 * every lease uses {@link useRepoLocks} rather than naming leases it knows
 * about: the namespace is free-form (only `merge:` is reserved — see
 * `@podium/protocol`'s lock-names), so a fixed list of names can only ever show
 * the leases someone thought of, never the ones agents actually took.
 */

import { type LockWire, mergeLockName } from '@podium/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStoreSelector } from './provider'

/**
 * The two conventional leases the workspace serializes on. They are the two the
 * UI pins to the top of a reading — NOT the two it is limited to.
 *
 * The merge name is BUILT, not spelled: a literal here would be a third
 * independent spelling of the one mutex, which is how POD-672 happened.
 * `test:heavy` stays a literal — it is an ordinary free-form lease, not the
 * reserved `merge` namespace.
 */
export const MERGE_LOCK_NAME = mergeLockName()
export const HEAVY_TEST_LOCK_NAME = 'test:heavy'
export const LOCK_POLL_MS = 5_000

interface QueryState {
  /** Every lock the query answered with, in the authority's order (by name). */
  readonly locks: readonly LockWire[]
  /** True only until this repository has produced its first answer or error. */
  readonly loading: boolean
  /** True while an initial read, poll, or manual refresh is in flight. */
  readonly refreshing: boolean
  /** The latest read failure. A prior reading remains available when this is set. */
  readonly error: string | null
  /** Local epoch milliseconds when the latest successful answer arrived. */
  readonly refreshedAt: number | null
  /** Request an immediate refresh; a request already in flight is not duplicated. */
  refresh(): void
}

/** Every lease held in one repository. */
export type RepoLocksState = QueryState

/** One named lease. `lock` is `null` when the authority reports the name free. */
export interface LockState extends QueryState {
  readonly lock: LockWire | null
}

interface Snapshot extends Omit<QueryState, 'refresh'> {
  repoPath: string | null
  /** The query's identity: a lock name, or `*` for the whole repository. */
  scope: string
}

/** Scope key for a reading that names no lock. */
const WHOLE_REPO = '*'

const EMPTY: Snapshot = {
  repoPath: null,
  scope: WHOLE_REPO,
  locks: [],
  loading: false,
  refreshing: false,
  error: null,
  refreshedAt: null,
}

const NO_LOCKS: readonly LockWire[] = []

const visible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState === 'visible'

const messageFor = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * Poll `lock.status` for `repoPath`, scoped to `lockName` or — when it is null
 * — to every lock in the repository.
 */
function useLockQuery(repoPath: string | null, lockName: string | null): QueryState {
  const trpc = useStoreSelector((state) => state.trpc)
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY)
  const loadRef = useRef<() => void>(() => {})
  const refresh = useCallback(() => loadRef.current(), [])
  const scope = lockName ?? WHOLE_REPO

  useEffect(() => {
    let disposed = false
    let running = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const clearTimer = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    }

    if (repoPath === null) {
      setSnapshot(EMPTY)
      loadRef.current = () => {}
      return
    }

    setSnapshot((current) =>
      current.repoPath === repoPath && current.scope === scope
        ? current
        : {
            repoPath,
            scope,
            locks: NO_LOCKS,
            loading: true,
            refreshing: false,
            error: null,
            refreshedAt: null,
          },
    )

    const schedule = (): void => {
      clearTimer()
      if (!disposed && visible()) timer = setTimeout(load, LOCK_POLL_MS)
    }

    const load = async (): Promise<void> => {
      if (disposed || running || !visible()) return
      running = true
      clearTimer()
      setSnapshot((current) =>
        current.repoPath === repoPath && current.scope === scope
          ? { ...current, refreshing: true, error: null }
          : current,
      )
      try {
        const rows = await trpc.lock.status.query({
          repoPath,
          ...(lockName === null ? {} : { name: lockName }),
        })
        if (!disposed) {
          setSnapshot({
            repoPath,
            scope,
            locks: rows,
            loading: false,
            refreshing: false,
            error: null,
            refreshedAt: Date.now(),
          })
        }
      } catch (cause) {
        if (!disposed) {
          setSnapshot((current) =>
            current.repoPath === repoPath && current.scope === scope
              ? {
                  ...current,
                  loading: false,
                  refreshing: false,
                  error: messageFor(cause),
                }
              : current,
          )
        }
      } finally {
        running = false
        schedule()
      }
    }

    const request = (): void => {
      clearTimer()
      void load()
    }
    loadRef.current = request

    const onVisibilityChange = (): void => {
      if (visible()) request()
      else clearTimer()
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    request()

    return () => {
      disposed = true
      clearTimer()
      if (loadRef.current === request) loadRef.current = () => {}
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    }
  }, [lockName, repoPath, scope, trpc])

  if (snapshot.repoPath !== repoPath || snapshot.scope !== scope) {
    return {
      locks: NO_LOCKS,
      loading: repoPath !== null,
      refreshing: false,
      error: null,
      refreshedAt: null,
      refresh,
    }
  }
  return { ...snapshot, refresh }
}

/**
 * Every lease currently held in `repoPath` — one request, whatever the names.
 * A lock has a row only while it is held, so a free lease is simply absent.
 */
export function useRepoLocks(repoPath: string | null): RepoLocksState {
  return useLockQuery(repoPath, null)
}

/** One named lease in `repoPath`. */
export function useLockState(repoPath: string | null, lockName: string): LockState {
  const state = useLockQuery(repoPath, lockName)
  return { ...state, lock: state.locks[0] ?? null }
}
