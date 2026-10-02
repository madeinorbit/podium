import { type ReplicaFailure, replicaFailureOf } from './failure'

export const BOOT_STALL_MS = 15_000
export type ReplicaBootState<T> =
  | { readonly status: 'resolving' | 'stalled' }
  | { readonly status: 'failed'; readonly failure: string; readonly cause: ReplicaFailure }
  | { readonly status: 'ready'; readonly value: T }

/** A watchdog offers recovery without cancelling slow work. Failure always wins. */
export function watchReplicaBoot(onStalled: () => void, stallAfterMs = BOOT_STALL_MS): () => void {
  const timer = setTimeout(onStalled, stallAfterMs)
  return () => clearTimeout(timer)
}

/** Owns late completion and cleanup, independent of React or either platform. */
export function startReplicaBoot<T>(options: {
  open(): Promise<T>
  dispose(value: T): Promise<void>
  onState(state: ReplicaBootState<T>): void
  onCleanupError?(error: unknown): void
  /** `null` turns the watchdog off; web keeps its loading screen until the open settles. */
  stallAfterMs?: number | null
}): () => void {
  let alive = true
  let opened: T | undefined
  options.onState({ status: 'resolving' })
  const stopWatch =
    options.stallAfterMs === null
      ? () => {}
      : watchReplicaBoot(() => {
          if (alive) options.onState({ status: 'stalled' })
        }, options.stallAfterMs)
  const dispose = (value: T): void => {
    void options.dispose(value).catch((error) => options.onCleanupError?.(error))
  }
  void options.open().then(
    (value) => {
      stopWatch()
      if (!alive) {
        dispose(value)
        return
      }
      opened = value
      options.onState({ status: 'ready', value })
    },
    (error: unknown) => {
      stopWatch()
      if (alive)
        options.onState({
          status: 'failed',
          failure: error instanceof Error ? error.message : String(error),
          cause: replicaFailureOf(error),
        })
    },
  )
  return () => {
    alive = false
    stopWatch()
    if (opened !== undefined) dispose(opened)
  }
}
