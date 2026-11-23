import { describe, expect, it } from 'vitest'
import { asCredentialId, CredentialId, CredentialIdField } from '../ids'
import { CREDENTIAL_TYPE_IDS, CREDENTIAL_TYPES } from './types'

// The type table of the credential management plan ("Shared names", §5 of the
// spec), restated here as the expected values on purpose: the registry is the
// thing under test, so it cannot also be the oracle.
const TABLE = {
  'google.api-key': {
    provider: 'google',
    store: 'vault',
    renewal: 'none',
    obtain: ['paste'],
    sharing: 'free',
    revocation: 'none',
  },
  'google.antigravity-login': {
    provider: 'google',
    store: 'home',
    renewal: undefined,
    obtain: ['harness-sign-in', 'found-on-machine'],
    sharing: 'warn',
    revocation: 'sign-out',
  },
  'anthropic.api-key': {
    provider: 'anthropic',
    store: 'vault',
    renewal: 'none',
    obtain: ['paste'],
    sharing: 'free',
    revocation: 'none',
  },
  'anthropic.claude-token': {
    provider: 'anthropic',
    store: 'vault',
    renewal: 'expires',
    obtain: ['paste'],
    sharing: 'warn',
    revocation: 'none',
  },
  'anthropic.claude-login': {
    provider: 'anthropic',
    store: 'home',
    renewal: undefined,
    obtain: ['harness-sign-in', 'found-on-machine'],
    sharing: 'warn',
    revocation: 'sign-out',
  },
  'openai.api-key': {
    provider: 'openai',
    store: 'vault',
    renewal: 'none',
    obtain: ['paste'],
    sharing: 'free',
    revocation: 'none',
  },
  'openai.chatgpt-login': {
    provider: 'openai',
    store: 'home',
    renewal: undefined,
    obtain: ['harness-sign-in', 'found-on-machine'],
    sharing: 'warn',
    revocation: 'sign-out',
  },
  'openai.chatgpt-plan': {
    provider: 'openai',
    store: 'vault',
    renewal: 'podium',
    obtain: ['oauth'],
    sharing: 'warn',
    revocation: 'provider-call',
  },
  'openrouter.api-key': {
    provider: 'openrouter',
    store: 'vault',
    renewal: 'none',
    obtain: ['paste'],
    sharing: 'free',
    revocation: 'none',
  },
  // Managed installs §4.7 (POD-7370): Grok's login, held in a GROK_HOME home.
  'xai.grok-login': {
    provider: 'xai',
    store: 'home',
    renewal: undefined,
    obtain: ['harness-sign-in', 'found-on-machine'],
    sharing: 'warn',
    revocation: 'sign-out',
  },
} as const

describe('CREDENTIAL_TYPES', () => {
  it('has exactly the types of the type table', () => {
    expect([...CREDENTIAL_TYPE_IDS].sort()).toEqual(Object.keys(TABLE).sort())
    expect(Object.keys(CREDENTIAL_TYPES).sort()).toEqual(Object.keys(TABLE).sort())
  })

  it('gives each type the store, renewal, obtain, sharing and revocation of the table', () => {
    for (const [id, row] of Object.entries(TABLE)) {
      const spec = CREDENTIAL_TYPES[id as keyof typeof TABLE]
      expect(spec.id, id).toBe(id)
      expect(
        {
          provider: spec.provider,
          store: spec.store,
          renewal: spec.renewal,
          obtain: [...spec.obtain],
          sharing: spec.sharing,
          revocation: spec.revocation,
        },
        id,
      ).toEqual(row)
      expect(spec.title.length, id).toBeGreaterThan(0)
    }
  })

  it('gives no home type a renewal and every vault type one', () => {
    for (const spec of Object.values(CREDENTIAL_TYPES)) {
      if (spec.store === 'home') expect(spec.renewal, spec.id).toBeUndefined()
      else expect(spec.renewal, spec.id).toBeDefined()
    }
    // Both branches above must have run, or the rule was checked on nothing.
    const stores = new Set(Object.values(CREDENTIAL_TYPES).map((spec) => spec.store))
    expect(stores).toEqual(new Set(['home', 'vault']))
  })
})

describe('CredentialId', () => {
  const minted = 'cred_0f8b7c1e-6a5d-4c3b-9a21-1234567890ab'

  it('accepts cred_ followed by a UUID', () => {
    expect(CredentialId.parse(minted)).toBe(minted)
    expect(asCredentialId(minted)).toBe(minted)
  })

  it('refuses the legacy account spellings and other shapes', () => {
    for (const bad of [
      '',
      'managed:anthropic',
      'native:claude-code:abc',
      'cred_',
      'cred_not-a-uuid',
      `${minted}x`,
      minted.replace('cred_', 'acct_'),
    ]) {
      expect(CredentialId.safeParse(bad).success, bad).toBe(false)
    }
  })

  it('field position brands without validating, like every other id field', () => {
    expect(CredentialIdField.safeParse('').success).toBe(true)
  })
})
