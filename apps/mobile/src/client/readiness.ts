import { isServerReadiness, type ServerReadiness } from '@podium/model'

const READINESS_TIMEOUT_MS = 10_000

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined
}

/**
 * The auto-recheck cadence while the gate is parked on `agent_unavailable` —
 * the normal race when the phone opens while the machine's daemon is still
 * connecting. Quick at first (the daemon usually lands within seconds), then a
 * steady low cadence so a genuinely wedged server sees at most one extra GET
 * /readiness per 30s per parked client. `configuration_invalid` and
 * `unreachable` never poll: those need a human, not a timer.
 */
const READINESS_RECHECK_DELAYS_MS = [2_000, 5_000, 10_000] as const
const READINESS_RECHECK_STEADY_MS = 30_000

/** Delay before recheck number `tick` (0-based) of one parked stretch. */
export function readinessRecheckDelayMs(tick: number): number {
  return READINESS_RECHECK_DELAYS_MS[tick] ?? READINESS_RECHECK_STEADY_MS
}

export async function fetchServerReadiness(httpOrigin: string): Promise<ServerReadiness> {
  const response = await fetch(`${httpOrigin}/readiness`, {
    credentials: 'include',
    signal: timeoutSignal(READINESS_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`readiness failed: ${response.status}`)
  const body: unknown = await response.json()
  if (!isServerReadiness(body)) throw new Error('readiness response was invalid')
  return body
}
