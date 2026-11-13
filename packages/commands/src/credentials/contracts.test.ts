/**
 * The credential contracts (credential management Task 4): eight writes, each
 * classified, never queued, and the two that carry a secret redact it.
 */

import { describe, expect, it } from 'vitest'
import { classificationErrors, registryClassificationErrors } from '../contract'
import { redactForLog } from '../redaction'
import {
  CREDENTIAL_CONTRACT_NAMES,
  CREDENTIAL_CONTRACTS,
  type CredentialContractName,
  credentialsShareInput,
} from './contracts'

const DECLARED: readonly CredentialContractName[] = [
  'add',
  'allowMachine',
  'disallowMachine',
  'remove',
  'rename',
  'renew',
  'share',
  'unshare',
]

const PLANT = 'FAKE-sk-ant-contract-plant-6891'

describe('credential contracts', () => {
  it('are exactly the eight writes, named credentials.<verb>', () => {
    expect(CREDENTIAL_CONTRACT_NAMES).toEqual(DECLARED)
    for (const name of DECLARED) {
      expect(CREDENTIAL_CONTRACTS[name].name).toBe(`credentials.${name}`)
    }
  })

  it('classify cleanly, and the lint can say no', () => {
    const all = Object.values(CREDENTIAL_CONTRACTS)
    // Probe: a secret contract made queueable is reported.
    const queueable = {
      ...CREDENTIAL_CONTRACTS.add,
      delivery: { ...CREDENTIAL_CONTRACTS.add.delivery, class: 'offline-safe' },
    }
    expect(classificationErrors(queueable as never).length).toBeGreaterThan(0)
    expect(registryClassificationErrors(all)).toEqual([])
  })

  it.each(DECLARED)('%s is never queued', (name) => {
    const contract = CREDENTIAL_CONTRACTS[name]
    expect(contract.delivery.class).toBe('online-sensitive')
    expect(contract.exposure).not.toContain('outbox')
    expect(contract.visibility).toBe('secret')
  })

  it.each(['add', 'renew'] as const)('%s redacts the secret from logs', (name) => {
    const input =
      name === 'add'
        ? { type: 'anthropic.api-key', label: 'Work', secret: PLANT }
        : { credentialId: 'cred_00000000-0000-4000-8000-000000000000', secret: PLANT }
    // Canary: the unredacted input holds the plant.
    expect(JSON.stringify(input)).toContain(PLANT)
    expect(JSON.stringify(redactForLog(CREDENTIAL_CONTRACTS[name], 'input', input))).not.toContain(
      PLANT,
    )
  })

  it('share names a person or all members', () => {
    const base = {
      credentialId: 'cred_00000000-0000-4000-8000-000000000000',
      verb: 'use',
      acknowledgeDisclosure: true,
    }
    expect(credentialsShareInput.safeParse({ ...base, grantee: 'all-members' }).success).toBe(true)
    expect(
      credentialsShareInput.safeParse({ ...base, grantee: { userId: 'user:someone' } }).success,
    ).toBe(true)
    expect(credentialsShareInput.safeParse({ ...base, grantee: 'everyone' }).success).toBe(false)
  })
})
