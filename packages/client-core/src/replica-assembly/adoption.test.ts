import { describe, expect, it } from 'vitest'
import { decideLegacyAdoption, type LegacyIdentityEvidence } from './adoption'

describe('principal cache adoption', () => {
  it('adopts the sole account', () => {
    expect(decideLegacyAdoption({ kind: 'single-account', principal: 'alice' })).toEqual({
      adopt: true, reason: 'adopted-single-account',
    })
  })
  it('adopts a sole identity even after repeated sign-ins', () => {
    expect(decideLegacyAdoption({ kind: 'multi-user', signedInAs: 'alice',
      identitiesEverSignedIn: ['alice', 'alice'] })).toEqual({
      adopt: true, reason: 'adopted-sole-identity',
    })
  })
  it('keeps the signed-in principal cache when other people used the device', () => {
    expect(decideLegacyAdoption({ kind: 'multi-user', signedInAs: 'alice',
      identitiesEverSignedIn: ['alice', 'bob'] }, {
      kind: 'principal-scoped', writtenUnder: ['alice'],
    })).toEqual({ adopt: true, reason: 'adopted-nothing-to-protect' })
  })
  it('adopts an empty scoped store', () => {
    expect(decideLegacyAdoption({ kind: 'multi-user', signedInAs: 'alice',
      identitiesEverSignedIn: ['bob'] }, {
      kind: 'principal-scoped', writtenUnder: [],
    }).adopt).toBe(true)
  })
  it.each<[LegacyIdentityEvidence, string]>([
    [{ kind: 'unknown' }, 'discarded-identity-unknown'],
    [{ kind: 'multi-user', signedInAs: 'alice', identitiesEverSignedIn: ['alice', 'bob'] },
      'discarded-multiple-identities'],
    [{ kind: 'multi-user', signedInAs: 'alice', identitiesEverSignedIn: ['bob'] },
      'discarded-foreign-identity'],
    [{ kind: 'multi-user', signedInAs: 'alice', identitiesEverSignedIn: [] },
      'discarded-foreign-identity'],
  ])('refuses without an attributable owner (%j)', (evidence, reason) => {
    expect(decideLegacyAdoption(evidence)).toEqual({ adopt: false, reason })
  })
  it('refuses unknown evidence even when the store claims a principal', () => {
    expect(decideLegacyAdoption({ kind: 'unknown' }, {
      kind: 'principal-scoped', writtenUnder: ['alice'],
    })).toEqual({ adopt: false, reason: 'discarded-identity-unknown' })
  })
  it('refuses a foreign writer even when the device ledger omits them', () => {
    expect(decideLegacyAdoption({ kind: 'multi-user', signedInAs: 'alice',
      identitiesEverSignedIn: ['alice'] }, {
      kind: 'principal-scoped', writtenUnder: ['bob'],
    })).toEqual({ adopt: false, reason: 'discarded-multiple-identities' })
  })
})
