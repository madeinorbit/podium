import { createLogger } from '@podium/logger'
import { isAbducoAvailable } from '@podium/pty'
import type { DurableBackend } from './control/context'
import type { DaemonOptions } from './daemon-options'

const log = createLogger('daemon:durable')

export function noDurableBackendWarning(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? 'windows: sessions run on ConPTY without a durable host — they will not survive a daemon restart'
    : 'abduco not found — sessions will not survive a daemon restart'
}

export function resolveDurableBackend(
  opts: Pick<DaemonOptions, 'backend'>,
  available: { abduco: boolean },
): DurableBackend {
  if (opts.backend) return opts.backend
  return available.abduco ? 'abduco' : 'none'
}

export function selectDurableBackend(opts: Pick<DaemonOptions, 'backend'>): DurableBackend {
  const backend = resolveDurableBackend(opts, { abduco: isAbducoAvailable() })
  if (opts.backend === undefined && backend === 'none') {
    log.warn(noDurableBackendWarning(), { platform: process.platform })
  }
  return backend
}
