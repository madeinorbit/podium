/**
 * The credential contracts (credential management Task 4, Task 14): ten writes,
 * each classified, never queued, and those that carry a secret redact it.
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
  'chatgptSignInComplete',
  'chatgptSignInStart',
  'disallowMachine',
  'login',
  'remove',
  'rename',
  'renew',
  'share',
  'signInCancel',
  'signInStart',
  'unshare',
  'useOnMyMachines',
]

const PLANT = 'FAKE-sk-ant-contract-plant-6891'

describe('credential contracts', () => {
  it('are exactly the credential writes, named credentials.<verb>', () => {
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
    expect(contract.delivery.class).toBe(name === 'login' ? 'online-only' : 'online-sensitive')
    expect(contract.exposure).not.toContain('outbox')
    expect(contract.visibility).toBe(name === 'login' ? 'owned-compute' : 'secret')
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

  it('a pasted ChatGPT sign-in address and the authorize address stay out of logs', () => {
    const contract = CREDENTIAL_CONTRACTS.chatgptSignInComplete
    const pasted = `http://127.0.0.1:1455/auth/callback?code=${PLANT}&state=s`
    const input = { attemptId: 'chatgpt_1', pastedUrl: pasted }
    expect(JSON.stringify(input)).toContain(PLANT)
    expect(JSON.stringify(redactForLog(contract, 'input', input))).not.toContain(PLANT)
    const output = {
      attemptId: 'chatgpt_1',
      authorizeUrl: `https://auth.example/?id_token_hint=${PLANT}`,
    }
    expect(JSON.stringify(output)).toContain(PLANT)
    expect(
      JSON.stringify(redactForLog(CREDENTIAL_CONTRACTS.chatgptSignInStart, 'output', output)),
    ).not.toContain(PLANT)
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
