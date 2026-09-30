import { createLogger } from '@podium/logger'
import { isHostAvailable } from '@podium/process/durable'
import type { DurableBackend } from './control/context'
import type { DaemonOptions } from './daemon-options'

const log = createLogger('daemon:durable')

const BACKENDS: readonly DurableBackend[] = ['host', 'none']

export function noDurableBackendWarning(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? 'windows: podium-host does not run here — this daemon refuses to start sessions'
    : 'podium-host not found — this daemon refuses to start sessions'
}

/**
 * NO SPAWN WITHOUT A DURABLE HOST (POD-4617; human decision 2026-09-22: "fail
 * completely; podium-host is part of Podium"). Backend `none` is a state the
 * daemon can observe and report, never a way to run anything: a raw pty child
 * survives no daemon restart, and starting one quietly is the failure being
 * removed. The daemon still boots, so inventory and credentials keep working
 * and the machine can say why nothing starts.
 *
 * The one sentence every refused spawn carries — agent, shell or login alike.
 */
export function noDurableBackendRefusal(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? 'cannot start the session: podium-host does not run on Windows yet, and Podium starts no session without it'
    : 'cannot start the session: podium-host is missing on this machine, and Podium starts no session without it'
}

/** Code of the machine diagnostic a daemon with no durable backend raises. */
export const NO_DURABLE_BACKEND_DIAGNOSTIC = 'durable-backend-missing'

/**
 * What the app shows for a daemon with no durable backend: the refusal is not
 * only a spawnError on each attempt but a standing condition of the machine,
 * raised once per connect (the server dedups per code).
 */
export function noDurableBackendDiagnostic(platform: NodeJS.Platform = process.platform): {
  code: string
  title: string
  body: string
  description: string
} {
  const why =
    platform === 'win32'
      ? 'podium-host, the program that keeps sessions running across daemon restarts, does not run on Windows yet.'
      : 'podium-host, the program that keeps sessions running across daemon restarts, is missing from this installation.'
  return {
    code: NO_DURABLE_BACKEND_DIAGNOSTIC,
    title: 'This machine cannot start sessions',
    body: `${why} The daemon is connected, but it refuses to start any agent, shell or login session until podium-host is available. Reinstall Podium on this machine (a source checkout builds it with the Rust toolchain pinned in packages/pty/vendor/podium-host), then restart the daemon.`,
    description: `This machine refuses to start sessions because ${why.charAt(0).toLowerCase()}${why.slice(1)}`,
  }
}

export function isDurableBackend(value: string | undefined): value is DurableBackend {
  return value !== undefined && (BACKENDS as readonly string[]).includes(value)
}

/**
 * `--backend host|none` from an argv, or undefined. The daemon entry points
 * that parse argv pass the result as `DaemonOptions.backend`.
 *
 * `abduco` was a backend until POD-4986. An argv that still names it (a unit
 * written by an older install) is not a reason to refuse to boot: it is
 * ignored with a warning, and the daemon selects podium-host as usual.
 */
export function parseBackendArg(argv: readonly string[]): DurableBackend | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = a === '--backend' ? argv[i + 1] : a?.startsWith('--backend=') ? a.slice(10) : undefined
    if (value === undefined) continue
    if (value === 'abduco') {
      log.warn('--backend abduco is no longer supported; ignoring it (podium-host is the only backend)')
      return undefined
    }
    if (!isDurableBackend(value)) {
      throw new Error(`--backend must be one of ${BACKENDS.join(', ')}, got '${value}'`)
    }
    return value
  }
  return undefined
}

/**
 * Which durable host this daemon uses: an explicit option or `PODIUM_DURABLE_BACKEND`
 * wins; otherwise `host` when a podium-host is available, else `none`.
 */
export function resolveDurableBackend(
  opts: Pick<DaemonOptions, 'backend'>,
  available: { host: boolean },
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
  return available.host ? 'host' : 'none'
}

export function selectDurableBackend(
  opts: Pick<DaemonOptions, 'backend'>,
  probe: { host: () => boolean } = { host: isHostAvailable },
): { backend: DurableBackend; available: { host: boolean } } {
  const fromEnv = process.env.PODIUM_DURABLE_BACKEND?.trim()
  const explicit = opts.backend ?? (isDurableBackend(fromEnv) ? fromEnv : undefined)
  // Probe lazily: an explicit `none` must not resolve (or build) a binary.
  const available = { host: explicit === 'none' ? false : probe.host() }
  const backend = resolveDurableBackend(opts, available)
  if (explicit === undefined && backend === 'none') {
    log.warn(noDurableBackendWarning(), { platform: process.platform })
  }
  return { backend, available }
}
