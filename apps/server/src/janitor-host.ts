/**
 * Host the janitor in a worker thread owned by the server process [POD-2505].
 *
 * Spec §3: "the janitor runs inside the server process as a worker". The worker
 * client owns the worker_threads boundary, restart policy, and packaged entry;
 * this server adapter only exposes its state on `/version` and closes it in the
 * server's ordered shutdown.
 *
 * THE JANITOR IS IMPORTED, NOT INJECTED (PDM-27). It used to arrive from the
 * composition root because `apps/server` importing `apps/janitor` would have
 * been the app→app edge the dependency-boundary lint forbids (rule 1) — and the
 * cost of that seam was that every root had to remember the injection, which
 * two of three did not, so a bare `podium server` ran no janitor at all. The
 * janitor now lives at `packages/janitor` (L3), which the server may import
 * downward like any other engine, and hosting it is no longer optional.
 *
 * The process-portable seam is untouched: the worker reads `podium.db` through
 * its own read-only connection and writes only through `/maintenance/*` over
 * HTTP, so a future janitor shared across many servers is a new entrypoint on
 * the same package rather than a redesign.
 */
import { startJanitorWorker } from '@podium/janitor/worker-client'
import { localServerUrl } from '@podium/runtime/config'
import { readOrCreateDaemonSecret } from '@podium/runtime/local-machine'

export type JanitorComponentState = 'running' | 'degraded' | 'stopped'

export interface JanitorHost {
  /** Monotonic token used by the parent watchdog and operator diagnostics. */
  progressVersion(): number
  state(): JanitorComponentState
  reason(): string | undefined
  close(): void
}

/** The shape of `@podium/janitor`'s worker client, as the server needs it. */
export type StartJanitorWorkerFn = (opts: {
  serverUrl: string
  token: string
}) => Promise<JanitorHost>

export interface JanitorHostDeps {
  port: number
  serverUrl?: string
  token?: string
  /**
   * TEST ONLY. Replaces the worker client so server tests never spawn a thread.
   * Production callers leave it absent, which is the real client.
   */
  start?: StartJanitorWorkerFn
}

/**
 * Start the janitor worker owned by the server.
 *
 * The worker client keeps crash/stall recovery on its side of the boundary and
 * reports compatibility refusal as DEGRADED. No worker failure is allowed to
 * throw through this adapter into request serving.
 */
export async function startJanitorHost(deps: JanitorHostDeps): Promise<JanitorHost> {
  const serverUrl = deps.serverUrl ?? localServerUrl(deps.port)
  const token = deps.token ?? readOrCreateDaemonSecret()
  const start = deps.start ?? startJanitorWorker
  try {
    return await start({ serverUrl, token })
  } catch (error) {
    const reason = (error as Error).message
    return {
      progressVersion: () => 0,
      state: () => 'degraded',
      reason: () => reason,
      close: () => {},
    }
  }
}

/**
 * TEST ONLY. A janitor that spawns nothing.
 *
 * Server tests pass this as `startServer`'s `janitorWorkerForTests` so a unit
 * test never runs real housekeeping — expiry, pruning, auto-archive, worktree
 * GC — against its own fixture database. Production has no such switch: a
 * server process without this seam hosts the real worker, always.
 */
export const noJanitorWorkerForTests: StartJanitorWorkerFn = async () => ({
  progressVersion: () => 0,
  state: () => 'stopped',
  reason: () => 'janitor disabled for tests',
  close: () => {},
})
