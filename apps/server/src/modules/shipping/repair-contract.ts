import { createHash } from 'node:crypto'
import type {
  IssueWire,
  MachineId,
  ShipAttempt,
  ShipHoldAction,
  ShipHoldCode,
  ShipOrder,
} from '@podium/model'
import type { ShippingJobClassification, ShippingJobRequestMessage } from '@podium/protocol/daemon'

export interface ShippingRepairFailure {
  operation: 'prepare-merge-group' | 'validate'
  classification: ShippingJobClassification
  summary: string
  artifactRefs: string[]
  repairBaseSha: string
}

export interface ShippingRepairContext {
  order: ShipOrder
  attempt: ShipAttempt
  issue: IssueWire
  failure: ShippingRepairFailure
  custody: {
    attemptId: ShipAttempt['id']
    generation: number
    machineId: MachineId
  }
  /** Canonical digest of the exact failed effect and its custody fence. */
  contextDigest: string
  authority: ShippingJobRequestMessage
}

export interface DurableShippingRepairCandidate {
  orderId: ShipOrder['id']
  attemptId: ShipAttempt['id']
  generation: number
  sequence: number
  round: number
  contextDigest: string
  repairRef: string
  candidateHeadSha: string
  resultToken: string
  recordedAt: string
}

export function shippingRepairContextDigest(
  input: Omit<ShippingRepairContext, 'contextDigest'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        orderId: input.order.id,
        attemptId: input.attempt.id,
        generation: input.custody.generation,
        machineId: input.custody.machineId,
        operation: input.failure.operation,
        classification: input.failure.classification,
        summary: input.failure.summary,
        artifactRefs: [...input.failure.artifactRefs],
        repairBaseSha: input.failure.repairBaseSha,
        authorityRequestDigest: input.authority.requestDigest,
      }),
    )
    .digest('hex')
}

export type ShippingRepairDecision =
  | { kind: 'not-applicable' }
  | { kind: 'patched'; resultToken: string; repairRef: string; candidateHeadSha: string }
  | {
      kind: 'needs-decision'
      resultToken: string
      reasonCode: ShipHoldCode
      headline: string
      detail: string
      evidenceRefs: string[]
      actions: ShipHoldAction[]
    }

/** Optional failure hook consumed after exact composition/validation fails and
 * before Shipping raises its normal hold. Implementations may only propose an
 * attempt-scoped candidate; Shipping retains custody and always revalidates it. */
export interface ShippingRepairPort {
  consider(input: ShippingRepairContext): Promise<ShippingRepairDecision>
  acknowledge(input: {
    resultToken: string
    orderId: ShipOrder['id']
    attemptId: ShipAttempt['id']
    generation: number
    contextDigest: string
    candidate?: { repairRef: string; candidateHeadSha: string }
  }): Promise<void>
}
