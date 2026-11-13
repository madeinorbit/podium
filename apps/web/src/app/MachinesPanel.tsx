import { useEffect, useMemo } from 'react'
import type { FailureReason } from '@/features/updates/MachineFailureReason'
import { updateStatus } from '@/lib/update-status'

// Existing pure-copy consumers may keep this import while the UI lives in Updates.
export { describeApplyOutcome } from '@/features/settings/machine-update-controls'

/** One machine's server-side convergence, as the fleet read model reports it. */
export interface MachineConvergence {
  reason?: FailureReason
  state: 'current' | 'granted' | 'downloading' | 'restarting' | 'rejected' | 'stuck'
  detail?: string
}

/**
 * Convergence for every row, owned by the panel rather than the row.
 *
 * It is the update-status reader's fleet (POD-6683), so a row shows its progress
 * no matter who started the update: this row's Apply, the global update panel,
 * or a wave that was already running before this page loaded. The open panel is
 * an update screen, so the reader polls while it shows, every second while any
 * machine is converging.
 */
export function useFleetConvergence(): {
  rows: ReadonlyMap<string, MachineConvergence>
  refresh: () => void
} {
  const status = updateStatus()
  useEffect(() => status.watch(), [status])
  const fleet = status.fleet
  // Rebuilt only when a new fleet reading lands, so rows redraw on news alone.
  const rows = useMemo(() => {
    const next = new Map<string, MachineConvergence>()
    for (const machine of fleet?.allMachines ?? fleet?.machines ?? []) {
      next.set(machine.id, {
        state: machine.state,
        reason: machine.reason,
        ...(machine.detail ? { detail: machine.detail } : {}),
      })
    }
    return next
  }, [fleet])
  return { rows, refresh: () => void status.refresh() }
}
