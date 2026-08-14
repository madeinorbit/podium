import type {
  IssueWire,
  MachineId,
  ShipAttempt,
  ShipHoldAction,
  ShipHoldCode,
  ShipOrder,
} from '@podium/model'
import type { ShippingJobClassification } from '@podium/protocol/daemon'

export interface ShippingRepairFailure {
  operation: 'prepare-merge-group' | 'validate'
  classification: ShippingJobClassification
  summary: string
  artifactRefs: string[]
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
}

export type ShippingRepairDecision =
  | { kind: 'not-applicable' }
  | { kind: 'patched'; repairRef: string; candidateHeadSha: string }
  | {
      kind: 'needs-decision'
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
}
