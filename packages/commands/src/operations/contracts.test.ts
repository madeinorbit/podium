import { describe, expect, it } from 'vitest'
import { registryClassificationErrors } from '../contract'
import {
  OPERATION_CONTRACTS,
  operationActionInput,
  operationCancelInput,
} from './contracts'

describe('operation command contracts', () => {
  it('classifies every generic mutation and keeps recovery admin/manage scoped', () => {
    expect(registryClassificationErrors(Object.values(OPERATION_CONTRACTS))).toEqual([])
    expect(OPERATION_CONTRACTS.action.policy).toMatchObject({
      roleFloor: 'admin',
      resource: 'machine',
      machineVerb: 'manage',
    })
    expect(OPERATION_CONTRACTS.settleAsk.policy).toMatchObject({
      roleFloor: 'admin',
      resource: 'machine',
      machineVerb: 'manage',
    })
    expect(OPERATION_CONTRACTS.cancel.policy).toMatchObject({
      roleFloor: 'admin',
      resource: 'machine',
      machineVerb: 'manage',
    })
  })

  it('requires operation and action identities on the public wire', () => {
    expect(operationCancelInput.safeParse({ id: 'op_1' }).success).toBe(true)
    expect(operationCancelInput.safeParse({}).success).toBe(false)
    expect(operationActionInput.safeParse({ id: 'op_1', actionId: 'recover' }).success).toBe(true)
    expect(operationActionInput.safeParse({ id: 'op_1' }).success).toBe(false)
  })
})
