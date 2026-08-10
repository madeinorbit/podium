/**
 * Live read binding for one named advisory lease.
 *
 * Lock rows do not belong in the replicated entity feed: `lock.status` is a
 * small authoritative query whose read also performs lazy lease expiry. This
 * hook bounds that query to one serialized request every five seconds while a
 * consumer is mounted and the document is visible. A transient failure keeps
 * the last good projection on screen and exposes the error beside it.
 */

import type { LockWire } from '@podium/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStoreSelector } from './provider'

/** The two conventional leases the workspace serializes on. */
export const MERGE_LOCK_NAME = 'merge:main'
export const HEAVY_TEST_LOCK_NAME = 'test:heavy'
export const LOCK_POLL_MS = 5_000

export interface LockState {
  /** `null` means the authority reports this named lock free. */
  readonly lock: LockWire | null
  /** True only until this repository has produced its first answer or error. */
  readonly loading: boolean
  /** True while an initial read, poll, or manual refresh is in flight. */
  readonly refreshing: boolean
  /** The latest read failure. A prior `lock` remains available when this is set. */
  readonly error: string | null
  /** Local epoch milliseconds when the latest successful answer arrived. */
  readonly refreshedAt: number | null
  /** Request an immediate refresh; a request already in flight is not duplicated. */
  refresh(): void
}

interface Snapshot extends Omit<LockState, 'refresh'> {
  repoPath: string | null
  lockName: string | null
}

const EMPTY: Snapshot = {
  repoPath: null,
  lockName: null,
  lock: null,
  loading: false,
  refreshing: false,
  error: null,
  refreshedAt: null,
}

const visible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState === 'visible'

const messageFor = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

export function useLockState(repoPath: string | null, lockName: string): LockState {
  const trpc = useStoreSelector((state) => state.trpc)
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY)
  const loadRef = useRef<() => void>(() => {})
  const refresh = useCallback(() => loadRef.current(), [])

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
      current.repoPath === repoPath && current.lockName === lockName
        ? current
        : {
            repoPath,
            lockName,
            lock: null,
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
        current.repoPath === repoPath && current.lockName === lockName
          ? { ...current, refreshing: true, error: null }
          : current,
      )
      try {
        const rows = await trpc.lock.status.query({ repoPath, name: lockName })
        if (!disposed) {
          setSnapshot({
            repoPath,
            lockName,
            lock: rows[0] ?? null,
            loading: false,
            refreshing: false,
            error: null,
            refreshedAt: Date.now(),
          })
        }
      } catch (cause) {
        if (!disposed) {
          setSnapshot((current) =>
            current.repoPath === repoPath && current.lockName === lockName
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
  }, [lockName, repoPath, trpc])

  if (snapshot.repoPath !== repoPath || snapshot.lockName !== lockName) {
    return {
      lock: null,
      loading: repoPath !== null,
      refreshing: false,
      error: null,
      refreshedAt: null,
      refresh,
    }
  }
  return { ...snapshot, refresh }
}
