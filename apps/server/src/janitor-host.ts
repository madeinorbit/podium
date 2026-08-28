/**
 * Host the janitor in a worker thread owned by the server process [POD-2505].
 *
 * Spec §3: "the janitor runs inside the server process as a worker". The injected
 * client owns the worker_threads boundary, restart policy, and packaged entry;
 * this server adapter only exposes its state on `/version` and closes it in the
 * server's ordered shutdown.
 *
 * THE JANITOR MODULE IS INJECTED, NEVER IMPORTED. `apps/server` importing
 * `apps/janitor` is an app→app edge that the dependency-boundary lint forbids
 * (scripts/check-boundaries.ts rule 1), and the seam already exists: the
 * composition root (scripts/cli.ts) is the one place allowed to compose apps.
 * There is no fallback deep import — a missing injection means this shape does
 * not host the janitor.
 */
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

/** The shape of `apps/janitor`'s worker client, as the server needs it. */
export type StartJanitorWorkerFn = (opts: {
  serverUrl: string
  token: string
}) => Promise<JanitorHost>

export interface JanitorHostDeps {
  port: number
  serverUrl?: string
  token?: string
  /** Injected by the composition root. Absent means this process does not host. */
  startJanitorWorker: StartJanitorWorkerFn
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
  try {
    return await deps.startJanitorWorker({ serverUrl, token })
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
