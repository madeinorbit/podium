import type { ConversationDiagnosticWire, ConversationSummaryWire } from '@podium/protocol'

/** The shape `runIndexRefreshJob` returns (mapped to wire types by the worker). */
export type ConversationDeltaWire = {
  changed: ConversationSummaryWire[]
  removed: string[]
  diagnostics: ConversationDiagnosticWire[]
}

export type ActiveRefreshDeps = {
  /**
   * Run the worker's `indexRefresh` job for the given dirty paths. The daemon wires
   * this to `workerClient.runJob('indexRefresh', { paths, ...homeDir/cachePath })`.
   */
  runPathsRefresh: (paths: string[]) => Promise<ConversationDeltaWire>
  /** Publish the resulting `conversationsChanged` delta to clients. */
  publish: (delta: ConversationDeltaWire) => void
  /** Loud on failure — active refresh must never fail silently. */
  onError: (err: unknown) => void
  /** Coalescing window; defaults to 1s. */
  windowMs?: number
}

export type ActiveRefresh = {
  /** Mark a transcript path dirty; schedules a coalesced flush within the window. */
  markConversationDirty: (path: string) => void
  /** Cancel any pending flush (called on shutdown). */
  stop: () => void
}

/**
 * Event-driven active conversation-index refresh.
 *
 * When a LOADED session's transcript tail fires (on every append) we mark that file
 * dirty and, after a short coalescing window, ask the worker to re-summarize JUST the
 * dirty files — instead of waiting up to 15s for the next periodic scan. Many appends
 * to one or several files within the window collapse into ONE `indexRefresh` job for
 * the UNION of dirty paths.
 *
 * On coalescing vs. the worker client: `DiscoveryWorkerClient` coalesces in-flight
 * jobs by KIND only, and the periodic delta, the full snapshot, and this paths-flush
 * all share kind `'indexRefresh'`. So a paths-flush requested while another
 * indexRefresh is already in flight resolves to THAT job's result, which may be a
 * superset of the dirty files (a periodic/full result already includes any moved
 * file — its mtime moved → cache miss → it lands in `changed`/the full list).
 * Publishing that superset is still correct (an upsert), and the index is eventually
 * consistent — the next dirty tick re-flushes anything the coalesced result missed.
 * We deliberately do NOT de-coalesce: no test demonstrates a real correctness gap,
 * and adding per-paths queuing would be complexity for no benefit.
 */
export function createActiveRefresh(deps: ActiveRefreshDeps): ActiveRefresh {
  const windowMs = deps.windowMs ?? 1_000
  const dirtyTranscriptPaths = new Set<string>()
  let dirtyFlushTimer: ReturnType<typeof setTimeout> | undefined

  const flushDirtyConversations = (): void => {
    dirtyFlushTimer = undefined
    if (dirtyTranscriptPaths.size === 0) return
    const paths = [...dirtyTranscriptPaths]
    dirtyTranscriptPaths.clear()
    void deps
      .runPathsRefresh(paths)
      .then((delta) => {
        if (delta.changed.length || delta.removed.length) deps.publish(delta)
      })
      .catch((err) => deps.onError(err))
  }

  const markConversationDirty = (path: string): void => {
    dirtyTranscriptPaths.add(path)
    if (!dirtyFlushTimer) {
      dirtyFlushTimer = setTimeout(flushDirtyConversations, windowMs)
      dirtyFlushTimer.unref?.()
    }
  }

  const stop = (): void => {
    if (dirtyFlushTimer) {
      clearTimeout(dirtyFlushTimer)
      dirtyFlushTimer = undefined
    }
    dirtyTranscriptPaths.clear()
  }

  return { markConversationDirty, stop }
}
