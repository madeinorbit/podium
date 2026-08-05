import type { PendingGrant } from './pending-grant'

export const MAX_CONVERGENCE_ATTEMPTS = 2

export type BootVerdict =
  | { action: 'confirm'; state: 'current' }
  | { action: 'retry'; attempts: number }
  | { action: 'rollback'; state: 'rejected' | 'stuck'; detail: string }

export function resolveOnBoot(ctx: {
  pending: PendingGrant | null
  runningVersion: string
}): BootVerdict | null {
  const { pending, runningVersion } = ctx
  if (!pending) return null

  // The bound limits failures, not successes: a daemon that arrived on its last
  // permitted attempt is current.
  if (runningVersion === pending.targetVersion) return { action: 'confirm', state: 'current' }

  if (pending.attempts < MAX_CONVERGENCE_ATTEMPTS) {
    return { action: 'retry', attempts: pending.attempts + 1 }
  }

  return {
    action: 'rollback',
    state: 'stuck',
    detail:
      `did not reach ${pending.targetVersion} after ${pending.attempts} attempt(s); ` +
      `running ${runningVersion}, pinned to last-known-good`,
  }
}
