import { createLogger } from '@podium/logger'
import { isAbducoAvailable, isHostAvailable } from '@podium/pty'
import type { DurableBackend } from './control/context'
import type { DaemonOptions } from './daemon-options'

const log = createLogger('daemon:durable')

const BACKENDS: readonly DurableBackend[] = ['host', 'abduco', 'none']

export function noDurableBackendWarning(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? 'windows: sessions run on ConPTY without a durable host — they will not survive a daemon restart'
    : 'neither podium-host nor abduco could be obtained — sessions will not survive a daemon restart'
}

export function isDurableBackend(value: string | undefined): value is DurableBackend {
  return value !== undefined && (BACKENDS as readonly string[]).includes(value)
}

/**
 * `--backend host|abduco|none` from an argv, or undefined. The daemon entry
 * points that parse argv pass the result as `DaemonOptions.backend`.
 */
export function parseBackendArg(argv: readonly string[]): DurableBackend | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = a === '--backend' ? argv[i + 1] : a?.startsWith('--backend=') ? a.slice(10) : undefined
    if (value === undefined) continue
    if (!isDurableBackend(value)) {
      throw new Error(`--backend must be one of ${BACKENDS.join(', ')}, got '${value}'`)
    }
    return value
  }
  return undefined
}

/**
 * Which durable host this daemon uses: an explicit option or `PODIUM_DURABLE_BACKEND`
 * wins; otherwise the first of host → abduco → none that is available.
 */
export function resolveDurableBackend(
  opts: Pick<DaemonOptions, 'backend'>,
  available: { host?: boolean; abduco: boolean },
  env: NodeJS.ProcessEnv = process.env,
): DurableBackend {
  if (opts.backend) return opts.backend
  const fromEnv = env.PODIUM_DURABLE_BACKEND?.trim()
  if (fromEnv) {
    if (isDurableBackend(fromEnv)) return fromEnv
    log.warn('PODIUM_DURABLE_BACKEND is not a backend name; ignoring it', {
      value: fromEnv,
      accepted: BACKENDS,
    })
  }
  if (available.host) return 'host'
  if (available.abduco) return 'abduco'
  return 'none'
}

export function selectDurableBackend(
  opts: Pick<DaemonOptions, 'backend'>,
  probe: { host: () => boolean; abduco: () => boolean } = {
    host: isHostAvailable,
    abduco: isAbducoAvailable,
  },
): { backend: DurableBackend; available: { host: boolean; abduco: boolean } } {
  const explicit = opts.backend ?? (isDurableBackend(process.env.PODIUM_DURABLE_BACKEND?.trim()) ? process.env.PODIUM_DURABLE_BACKEND?.trim() : undefined)
  // Probe lazily: an explicit `none` must not build a binary, and an explicit
  // host/abduco only needs the OTHER probe for the reattach fall-through.
  const host = explicit === 'none' ? false : explicit === 'abduco' ? probe.host() : probe.host()
  const abduco = explicit === 'none' ? false : probe.abduco()
  const available = { host, abduco }
  const backend = resolveDurableBackend(opts, available)
  if (explicit === undefined) {
    // One warning per fallback step, so an operator can see why the daemon is
    // not on the host it would have chosen.
    if (backend !== 'host') {
      log.warn('podium-host unavailable — falling back', { to: backend, platform: process.platform })
    }
    if (backend === 'none') log.warn(noDurableBackendWarning(), { platform: process.platform })
  }
  return { backend, available }
}
