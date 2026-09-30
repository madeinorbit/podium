import { isMachineOfflineForLiveTerminal } from '@podium/model/browser'

/**
 * How long an offline machine keeps its chip in the header (POD-4965).
 *
 * POD-4830 gave an offline machine a chip so a daemon loss reads "offline"
 * instead of the machine silently vanishing. But the machines list is also the
 * server's audit history: a laptop re-paired under a new id, or retired weeks
 * ago, stays in it unrevoked forever, and every such row became a permanent red
 * chip. A week covers a machine the operator actually uses and just closed for
 * a weekend or a trip; a row older than that is history, and Settings → Machines
 * is where history is shown.
 */
export const HEADER_OFFLINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

interface HeaderMachine {
  id: string
  online: boolean
  availability?: { daemon: boolean }
  serviceAssignment?: { agentExecution: boolean }
  /** ISO 8601 on the wire; epoch ms is accepted too. */
  lastSeenAt?: string | number
  revokedAt?: string | null
  supersededBy?: string | null
}

function lastSeenMs(value: string | number | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/**
 * The offline machines the header draws its own chip for: offline for the live
 * terminal, without a live host sample (a machine WITH one already has its live
 * chip), assigned to run agents, and still in use — not revoked, not replaced,
 * seen within {@link HEADER_OFFLINE_WINDOW_MS}. An unreadable `lastSeenAt`
 * proves nothing recent, so it gets no chip.
 *
 * "Offline" here means its agents are unreachable, so a machine never assigned
 * agent execution (a server- or supervisor-only host, daemon down by design)
 * gets no offline chip; the relay's own daemon test reads the same assignment.
 */
export function headerOfflineMachines<M extends HeaderMachine>(
  machines: readonly M[],
  sampledMachineIds: ReadonlySet<string>,
  nowMs: number,
): M[] {
  return machines.filter((m) => {
    if (!isMachineOfflineForLiveTerminal(m)) return false
    if (sampledMachineIds.has(m.id)) return false
    if (m.serviceAssignment?.agentExecution === false) return false
    if (m.revokedAt || m.supersededBy) return false
    const seen = lastSeenMs(m.lastSeenAt)
    return seen !== null && nowMs - seen <= HEADER_OFFLINE_WINDOW_MS
  })
}
