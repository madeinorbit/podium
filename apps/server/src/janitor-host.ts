/**
 * Host the janitor inside the server process [POD-2505].
 *
 * Spec allows a worker thread or in-process loop; this host starts the janitor
 * package's `startJanitor` off the listen path and reports refusal as DEGRADED
 * instead of exiting the server (component-failure policy §8).
 */
import { createLogger } from '@podium/logger'
import { localServerUrl } from '@podium/runtime/config'
import { readOrCreateDaemonSecret } from '@podium/runtime/local-machine'

const log = createLogger('server:janitor-host')

export type JanitorComponentState = 'running' | 'degraded' | 'stopped'

export interface JanitorHost {
  progressVersion(): number
  state(): JanitorComponentState
  reason(): string | undefined
  close(): void
}

export interface JanitorHostDeps {
  port: number
  serverUrl?: string
  token?: string
  /** Injectable start — production loads apps/janitor. */
  startJanitor?: (opts: {
    serverUrl: string
    token: string
  }) => Promise<{ service: { progressVersion(): number }; close(): void }>
}

/**
 * Start the janitor co-hosted with the server. Compatibility refusal parks the
 * worker stopped and surfaces a reason; the server keeps serving.
 */
export async function startJanitorHost(deps: JanitorHostDeps): Promise<JanitorHost> {
  const serverUrl = deps.serverUrl ?? localServerUrl(deps.port)
  const token = deps.token ?? readOrCreateDaemonSecret()
  let progress = 0
  let state: JanitorComponentState = 'stopped'
  let reason: string | undefined
  let handle: { service: { progressVersion(): number }; close(): void } | undefined

  const start =
    deps.startJanitor ??
    (async (opts) => {
      const { startJanitor } = await import('../../janitor/src/janitor')
      return startJanitor(opts)
    })

  try {
    handle = await start({ serverUrl, token })
    state = 'running'
    progress = handle.service.progressVersion()
    log.info('janitor host started', { serverUrl })
  } catch (error) {
    const name = (error as Error).name
    reason = (error as Error).message
    if (name === 'MaintenanceCompatibilityError') {
      state = 'degraded'
      log.warn('janitor refused at start — server stays up (degraded)', { reason })
    } else {
      state = 'degraded'
      log.warn('janitor failed to start — server stays up (degraded)', { reason })
    }
  }

  // Poll progress from a live handle; refusal mid-run is observed via tick errors
  // that stop advancing progressVersion (watchdog pets require advance).
  const timer = setInterval(() => {
    if (!handle) return
    try {
      progress = handle.service.progressVersion()
    } catch {
      /* ignore */
    }
  }, 5_000)
  timer.unref?.()

  return {
    progressVersion: () => (handle ? handle.service.progressVersion() : progress),
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
