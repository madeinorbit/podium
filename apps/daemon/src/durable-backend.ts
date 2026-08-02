import { isAbducoAvailable, isTmuxAvailable } from '@podium/pty'
import type { DurableBackend } from './control/context'
import type { DaemonOptions } from './daemon-options'

export function noDurableBackendWarning(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? '[podium] windows: sessions run on ConPTY without a durable host — they will not survive a daemon restart'
    : '[podium] neither abduco nor tmux found — sessions will not survive a daemon restart'
}

export function resolveDurableBackend(
  opts: Pick<DaemonOptions, 'backend' | 'tmux'>,
  available: { abduco: boolean; tmux: boolean },
): DurableBackend {
  if (opts.backend) return opts.backend
  if (opts.tmux !== undefined) return opts.tmux ? 'tmux' : 'none'
  if (available.abduco) return 'abduco'
  if (available.tmux) return 'tmux'
  return 'none'
}

export function selectDurableBackend(
  opts: Pick<DaemonOptions, 'backend' | 'tmux'>,
): DurableBackend {
  const backend = resolveDurableBackend(opts, {
    abduco: isAbducoAvailable(),
    tmux: isTmuxAvailable(),
  })
  if (opts.backend === undefined && opts.tmux === undefined && backend === 'none') {
    console.warn(noDurableBackendWarning())
  }
  return backend
}
