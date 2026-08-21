/**
 * Host the janitor inside the server process [POD-2505].
 *
 * Spec §3: "the janitor runs inside the server process as a worker (worker
 * thread or in-process loop — implementation detail)". This is the in-process
 * loop; it starts the janitor off the listen path and reports refusal as
 * DEGRADED instead of exiting the server (component-failure policy §8).
 *
 * THE JANITOR MODULE IS INJECTED, NEVER IMPORTED. `apps/server` importing
 * `apps/janitor` is an app→app edge that the dependency-boundary lint forbids
 * (scripts/check-boundaries.ts rule 1), and the seam already exists: the
 * composition root (scripts/cli.ts) is the one place allowed to compose apps,
 * and it already hands the CLI a `startJanitor`. So the server takes one too.
 * There is no fallback deep import — a missing injection means "this shape does
 * not co-host the janitor", which is the truth for every server started without
 * the composition root.
 */
import { createLogger } from '@podium/logger'
import { localServerUrl } from '@podium/runtime/config'
import { readOrCreateDaemonSecret } from '@podium/runtime/local-machine'

const log = createLogger('server:janitor-host')

export type JanitorComponentState = 'running' | 'degraded' | 'stopped'

export interface JanitorHost {
  /**
   * Monotonic token the janitor advances as it completes work. The parent's
   * watchdog rule reads it: a host that claims to be RUNNING while this stops
   * moving is wedged, and that is the one component state systemd should see
   * (§8, gap 9).
   */
  progressVersion(): number
  state(): JanitorComponentState
  reason(): string | undefined
  close(): void
}

/** The shape of `apps/janitor`'s `startJanitor`, as the server needs it. */
export type StartJanitorFn = (opts: {
  serverUrl: string
  token: string
  onCompatibilityRefusal?: (error: Error) => void
}) => Promise<{ service: { progressVersion(): number }; close(): void }>

export interface JanitorHostDeps {
  port: number
  serverUrl?: string
  token?: string
  /** Injected by the composition root. Absent ⇒ this process does not co-host. */
  startJanitor: StartJanitorFn
}

/**
 * Start the janitor co-hosted with the server.
 *
 * BOTH refusal paths park the janitor and leave the server serving:
 *  - at START (the schema check on the first handshake), and
 *  - MID-RUN, when the DB advances under a janitor that is already ticking.
 * The mid-run one is the path that actually fires in production — the schema
 * changes while the janitor is running — and it is the one that used to reach
 * `process.exit(78)` and take the whole server with it (review finding 3).
 */
export async function startJanitorHost(deps: JanitorHostDeps): Promise<JanitorHost> {
  const serverUrl = deps.serverUrl ?? localServerUrl(deps.port)
  const token = deps.token ?? readOrCreateDaemonSecret()
  let progress = 0
  let state: JanitorComponentState = 'stopped'
  let reason: string | undefined
  let handle: { service: { progressVersion(): number }; close(): void } | undefined

  const refuse = (error: Error, when: 'start' | 'mid-run'): void => {
    state = 'degraded'
    reason = error.message
    log.warn(`janitor refused ${when} — server stays up (degraded)`, { reason })
  }

  try {
    handle = await deps.startJanitor({
      serverUrl,
      token,
      onCompatibilityRefusal: (error) => {
        // The janitor has already stopped its own tick; freeze the progress
        // token at its last value so the watchdog does not read a stopped
        // component as a wedged one.
        progress = handle ? handle.service.progressVersion() : progress
        refuse(error, 'mid-run')
      },
    })
    state = 'running'
    progress = handle.service.progressVersion()
    log.info('janitor host started', { serverUrl })
  } catch (error) {
    refuse(error as Error, 'start')
  }

  const timer = setInterval(() => {
    if (!handle || state !== 'running') return
    try {
      progress = handle.service.progressVersion()
    } catch {
      /* ignore */
    }
  }, 5_000)
  timer.unref?.()

  return {
    progressVersion: () =>
      handle && state === 'running' ? handle.service.progressVersion() : progress,
    state: () => state,
    reason: () => reason,
    close: () => {
      clearInterval(timer)
      handle?.close()
      handle = undefined
      state = 'stopped'
    },
  }
}

/** True when this server process should co-host the janitor (parent model / desktop). */
export function shouldHostJanitor(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.PODIUM_UNDER_PARENT === '1' ||
    env.PODIUM_DESKTOP_SUPERVISED === '1' ||
    env.PODIUM_HOST_JANITOR === '1'
  )
}
