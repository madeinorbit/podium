/**
 * Live read binding for the conventional `merge:main` advisory lease.
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

export const MERGE_LOCK_NAME = 'merge:main'
export const MERGE_LOCK_POLL_MS = 5_000

export interface MergeLockState {
  /** `null` means the authority reports `merge:main` free. */
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

interface Snapshot extends Omit<MergeLockState, 'refresh'> {
  repoPath: string | null
}

const EMPTY: Snapshot = {
  repoPath: null,
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

export function useMergeLockState(repoPath: string | null): MergeLockState {
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
      current.repoPath === repoPath
        ? current
        : {
            repoPath,
            lock: null,
            loading: true,
            refreshing: false,
            error: null,
            refreshedAt: null,
          },
    )

    const schedule = (): void => {
      clearTimer()
      if (!disposed && visible()) timer = setTimeout(load, MERGE_LOCK_POLL_MS)
    }

    const load = async (): Promise<void> => {
      if (disposed || running || !visible()) return
      running = true
      clearTimer()
      setSnapshot((current) =>
        current.repoPath === repoPath ? { ...current, refreshing: true, error: null } : current,
      )
      try {
        const rows = await trpc.lock.status.query({ repoPath, name: MERGE_LOCK_NAME })
        if (!disposed) {
          setSnapshot({
            repoPath,
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
            current.repoPath === repoPath
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
  }, [repoPath, trpc])

  if (snapshot.repoPath !== repoPath) {
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
