import type { OwnStackRefusal } from './parent-supervisor'

export type UpdateFailure = { detail: string; reasonCode: string }
export type GateRefusal = OwnStackRefusal | { child: 'daemon'; because: 'refused'; reason: string }

/** Keep the child's verdict intact while giving every gate shape a useful sentence. */
export function describeGateFailure(detail: { refusedBy?: GateRefusal }): UpdateFailure {
  const refusal = detail.refusedBy
  if (!refusal) return {
    reasonCode: 'successor-unhealthy',
    detail: 'Successor failed its health gate: the successor did not prove a healthy stack.',
  }
  const child = refusal.child
  let cause: string
  let code: string = refusal.because
  switch (refusal.because) {
    case 'refused':
      cause = `refused by the server (${refusal.reason})`
      code = refusal.reason.startsWith('protocol-mismatch:') ? 'refused-wire' : 'refused'
      break
    case 'silent': cause = 'did not report healthy'; break
    case 'not-spawned': cause = 'was not spawned'; break
    case 'unspawnable': cause = `cannot report readiness (${refusal.fault})`; break
    case 'channel-closed': cause = 'closed its lifecycle channel'; break
    case 'stopping': cause = `is stopping (${refusal.reason})`; break
    case 'wrong-role': cause = `reported the wrong role (${refusal.reported})`; break
    case 'wrong-version': cause = `reported version ${refusal.reported}, expected ${refusal.expected}`; break
    case 'no-port': cause = 'did not report a serving port'; break
  }
  return { reasonCode: `${child}-${code}`, detail: `Successor failed its health gate: ${child} ${cause}.` }
}

export class UpdateGateError extends Error {
  readonly reasonCode: string
  constructor(failure: UpdateFailure) {
    super(failure.detail)
    this.reasonCode = failure.reasonCode
  }
}

export function rollbackRefusalCode(why: string): string {
  if (why.includes('cannot read applied migration journal') || why.includes('cannot tell'))
    return 'rollback-refused-unknown-migrations'
  if (why.includes('applied migrations') || why.includes('schema migrations'))
    return 'rollback-refused-migrations'
  return 'rollback-refused-no-bundle'
}
