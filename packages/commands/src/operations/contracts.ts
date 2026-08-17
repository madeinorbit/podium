import { z } from 'zod'
import type { CommandContract } from '../contract'

export const operationCancelInput = z.object({ id: z.string().min(1) }).strict()
export const operationActionInput = z
  .object({ id: z.string().min(1), actionId: z.string().min(1) })
  .strict()

const delivery = {
  class: 'online-only',
  outboxReconciliation:
    'Never queued. Operation actions settle live durable state and must be validated against the currently offered action.',
  applyTimeReauthorization:
    'The caller role and target-machine manage grant are resolved live immediately before dispatch.',
} as const

const redaction = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note: 'Operation and action ids are opaque public identifiers; results contain only operation outcomes.',
} as const

const ownership = {
  creates: [],
  note: 'Mutates an existing durable operation and creates no separately owned entity.',
} as const

const attribution = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'Recovery and cancellation are privileged lifecycle decisions and retain the authenticated caller attribution.',
} as const

const errorConsistency = {
  callerSuppliedTargetId: false,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: false,
  note:
    'The caller supplies an operation id; the target machine is derived from its durable details and checked without exposing invisible machines.',
} as const

export const operationsCancelContract = {
  name: 'operations.cancel',
  version: 1,
  visibility: 'owned-compute',
  input: operationCancelInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'machine',
    machineVerb: 'manage',
    confirmation: 'none',
    rationale:
      'Cancel may tear down external lifecycle staging, so only an admin who can manage the operation target may invoke it.',
  },
  exposure: ['trpc'],
  delivery,
  redaction,
  ownership,
  attribution,
  errorConsistency,
  conflict: 'single-writer',
} as const satisfies CommandContract<typeof operationCancelInput>

export const operationsSettleAskContract = {
  name: 'operations.settleAsk',
  version: 1,
  visibility: 'owned-compute',
  input: operationActionInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'machine',
    machineVerb: 'manage',
    confirmation: 'none',
    rationale:
      'Settling a recovery ask can decide cross-machine authority, so it requires current admin grade and target manage authority.',
  },
  exposure: ['trpc'],
  delivery,
  redaction,
  ownership,
  attribution,
  errorConsistency,
  conflict: 'single-writer',
} as const satisfies CommandContract<typeof operationActionInput>

export const operationsActionContract = {
  ...operationsSettleAskContract,
  name: 'operations.action',
} as const satisfies CommandContract<typeof operationActionInput>

export const OPERATION_CONTRACTS = {
  cancel: operationsCancelContract,
  settleAsk: operationsSettleAskContract,
  action: operationsActionContract,
} as const

export type OperationContractName = keyof typeof OPERATION_CONTRACTS
export const OPERATION_CONTRACT_NAMES = Object.keys(
  OPERATION_CONTRACTS,
).sort() as OperationContractName[]
