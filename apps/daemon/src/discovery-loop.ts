import type { DaemonMessage } from '@podium/protocol'
import { type ConversationDeltaWire, createActiveRefresh } from './active-refresh'
import { countWorker, timeTask } from './loop-attribution'
import type { DiscoveryWorkerClient } from './worker-client'

export const DEFAULT_DISCOVERY_SCAN_INTERVAL_MS = 15_000

export interface DiscoveryLoop {
  /** Run a scan on the worker and publish the delta; `full` requests the entire list. */
  refreshAndPublishConversations(full?: boolean): Promise<ConversationDeltaWire>
  /** Event-driven refresh: a live transcript tail appended to this path. */
  markConversationDirty(path: string): void
  /** Kick off the connect-time full snapshot + the periodic delta loop (once). */
  start(): void
  stop(): void
}

/**
 * The daemon's conversation-discovery pump. The /proc-free scan runs on the
 * worker thread (which owns discovery.db exclusively), so neither the periodic
 * 15s tick, the connect-time full snapshot, nor the tail-driven active refresh
 * ever touches the interactive daemon loop.
 */
export function createDiscoveryLoop(opts: {
  workerClient: DiscoveryWorkerClient
  send(msg: DaemonMessage): void
  homeDir?: string | undefined
  cachePath?: string | undefined
  /** False disables unsolicited pushes (the periodic loop + connect snapshot). */
  background: boolean
  intervalMs: number
}): DiscoveryLoop {
  let timer: ReturnType<typeof setTimeout> | undefined
  // Coalesce overlapping scans: a 15s tick that fires while a worker job is still
  // in flight (or an on-demand scanRequest racing the timer) shares the one result.
  let inFlight: Promise<ConversationDeltaWire> | undefined

  // Send the conversation delta. The common case every 15s is "nothing moved": an
  // all-empty delta produces NO broadcast at all, so an idle host doesn't fan a
  // pointless conversationsChanged frame out to every client every tick. (A genuinely
  // empty full snapshot — zero conversations on the host — is correctly skipped too.)
  const publishConversations = (delta: ConversationDeltaWire): void => {
    if (delta.changed.length === 0 && delta.removed.length === 0 && delta.diagnostics.length === 0)
      return
    countWorker()
    timeTask(`publishConv(${delta.changed.length})`, () =>
      opts.send({
        type: 'conversationsChanged',
        conversations: delta.changed,
        removed: delta.removed,
        diagnostics: delta.diagnostics,
      }),
    )
  }

  // Event-driven active conversation-index refresh: a transcript tail marks its
  // file dirty and the worker re-summarizes JUST that file (coalesced, ~1s)
  // instead of waiting for the next periodic scan. The paths-flush runs the SAME
  // `indexRefresh` worker job (off the interactive loop) scoped to the dirty
  // files; it shares kind `'indexRefresh'` with the periodic/full scans, so the
  // worker client may coalesce it onto an in-flight scan and return a superset —
  // still a correct upsert (see createActiveRefresh's note). Failures are loud.
  const activeRefresh = createActiveRefresh({
    runPathsRefresh: (paths) =>
      opts.workerClient.runJob('indexRefresh', {
        paths,
        ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
        ...(opts.cachePath ? { cachePath: opts.cachePath } : {}),
      }) as Promise<ConversationDeltaWire>,
    publish: publishConversations,
    onError: (err) =>
      console.warn(
        `[podium:daemon] active index refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
  })

  // Run the discovery scan on the worker thread (off the interactive loop) and
  // return the delta. The worker owns discovery.db, so the scan's SQLite reads/
  // writes — the old ~800ms loop block — never touch the daemon's event loop.
  // A worker failure (crash, timeout) surfaces as an error diagnostic, never silent.
  //
  // `full: true` asks the worker for the ENTIRE conversation list (mapped into
  // `changed`), not just the cache-miss delta. Connect-time and on-demand scans use
  // it so a snapshot upserts everything — repopulating a cold/reset server index
  // even when the daemon's warm discovery.db cache reports nothing as "changed".
  // The periodic loop omits it and forwards only the delta.
  const runDiscoveryDelta = (full = false): Promise<ConversationDeltaWire> => {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        return (await opts.workerClient.runJob('indexRefresh', {
          ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
          ...(opts.cachePath ? { cachePath: opts.cachePath } : {}),
          ...(full ? { full: true } : {}),
        })) as ConversationDeltaWire
      } catch (err) {
        return {
          changed: [],
          removed: [],
          diagnostics: [
            { severity: 'error', message: err instanceof Error ? err.message : String(err) },
          ],
        }
      } finally {
        inFlight = undefined
      }
    })()
    return inFlight
  }

  // `full: true` (connect-time + on-demand) requests the entire conversation list so
  // the publish repopulates a cold server index; the periodic loop omits it (delta only).
  const refreshAndPublishConversations = async (full = false): Promise<ConversationDeltaWire> => {
    const delta = await runDiscoveryDelta(full)
    publishConversations(delta)
    return delta
  }

  const scheduleScan = (): void => {
    if (!opts.background) return
    timer = setTimeout(() => {
      void refreshAndPublishConversations().finally(scheduleScan)
    }, opts.intervalMs)
    timer.unref?.()
  }

  return {
    refreshAndPublishConversations,
    markConversationDirty: (path) => activeRefresh.markConversationDirty(path),
    start(): void {
      if (!opts.background) return
      // Run one FULL snapshot on the worker at connect (emits the entire current
      // conversation list, not just what moved), then settle into the periodic
      // delta loop. The full snapshot is required because the server index can be
      // COLD — a fresh server, or a reset/schema-migrated podium.db — while the
      // daemon's discovery.db cache is WARM (survives a daemon restart); a delta
      // off a warm cache would be empty and leave the cold index permanently bare.
      // The full scan still runs on the worker, so this never blocks the loop.
      void refreshAndPublishConversations(true)
      scheduleScan()
    },
    stop(): void {
      if (timer) clearTimeout(timer)
      activeRefresh.stop()
    },
  }
}
