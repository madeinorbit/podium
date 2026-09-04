export type AcceptanceVerdict = 'PASS' | 'FAIL' | 'REFUSED'

export interface A1cReading {
  controlFired: boolean
  deadConfirmed: boolean
  typedRefusal: boolean
  accepted: boolean
  delayedDelivered: boolean
}

export interface A1cSendReceipt {
  ok: unknown
  hasError: boolean
  reason: string
  disposition: string
  errorMessage: string
}

/**
 * A resume offer is useful UI, but it is not itself a refusal. Require both a
 * negative response shape and language/disposition that says the send was
 * actually rejected, dead-lettered, or could not reach a live session.
 */
export function isA1cTypedRefusal(receipt: A1cSendReceipt): boolean {
  const negative = receipt.ok === false || receipt.hasError
  if (!negative) return false
  const text = `${receipt.reason} ${receipt.disposition} ${receipt.errorMessage}`
  return /dead.?letter|refus|reject|\bdead\b|\bgone\b|unknown|not found|not running|no longer exists|cannot (?:accept|deliver|send)/i.test(
    text,
  )
}

/**
 * A1c has two valid terminal outcomes: an explicit refusal before acceptance,
 * or an accepted send whose assistant needle eventually arrives. An accepted
 * send is never allowed to borrow a refusal-shaped field to pass immediately.
 */
export function scoreA1c(reading: A1cReading): AcceptanceVerdict {
  if (!reading.controlFired || !reading.deadConfirmed) return 'REFUSED'
  if (reading.accepted) return reading.delayedDelivered ? 'PASS' : 'FAIL'
  return reading.typedRefusal ? 'PASS' : 'FAIL'
}

export interface ProcessIdentity {
  pid: number
  startTimeTicks: string
}

export interface A9Reading {
  controlFired: boolean
  stampProven: boolean
  originalProcesses: readonly ProcessIdentity[]
  originalProcessesAliveAt15s: readonly ProcessIdentity[]
  originalProcessesAliveAt300s: readonly ProcessIdentity[]
  stampedProcessesAt15s: readonly ProcessIdentity[]
  stampedProcessesAt300s: readonly ProcessIdentity[]
  infrastructureAlive: number
}

export interface A9Score {
  verdict: AcceptanceVerdict
  survivorsAt15s: number[]
  reboundsAt15s: number[]
  survivorsAt300s: number[]
  reboundsAt300s: number[]
}

/**
 * Score each checkpoint against the same pre-kill process identities. Original
 * liveness is supplied by direct PID/start-time checks, separately from the
 * stamped census, so losing attribution cannot masquerade as process exit.
 */
export function scoreA9(reading: A9Reading): A9Score {
  const key = (identity: ProcessIdentity) => `${identity.pid}:${identity.startTimeTicks}`
  const original = new Set(reading.originalProcesses.map(key))
  const split = (
    aliveOriginals: readonly ProcessIdentity[],
    stamped: readonly ProcessIdentity[],
  ) => ({
    survivors: [
      ...new Set(
        [...aliveOriginals, ...stamped]
          .filter((identity) => original.has(key(identity)))
          .map((identity) => identity.pid),
      ),
    ],
    rebounds: stamped
      .filter((identity) => !original.has(key(identity)))
      .map((identity) => identity.pid),
  })
  const at15s = split(reading.originalProcessesAliveAt15s, reading.stampedProcessesAt15s)
  const at300s = split(reading.originalProcessesAliveAt300s, reading.stampedProcessesAt300s)
  const identitiesProven = reading.originalProcesses.every(
    (identity) => identity.pid > 0 && identity.startTimeTicks.length > 0,
  )
  const evidenceEligible =
    reading.controlFired && reading.stampProven && original.size > 0 && identitiesProven
  const clean =
    at15s.survivors.length === 0 &&
    at15s.rebounds.length === 0 &&
    at300s.survivors.length === 0 &&
    at300s.rebounds.length === 0 &&
    reading.infrastructureAlive === 2

  return {
    verdict: !evidenceEligible ? 'REFUSED' : clean ? 'PASS' : 'FAIL',
    survivorsAt15s: at15s.survivors,
    reboundsAt15s: at15s.rebounds,
    survivorsAt300s: at300s.survivors,
    reboundsAt300s: at300s.rebounds,
  }
}
