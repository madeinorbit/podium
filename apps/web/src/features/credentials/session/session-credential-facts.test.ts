import { asCredentialId, asMachineId, type CredentialView } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { credentialView } from '@/test-support/credential-view'
import {
  credentialKind,
  initialCredential,
  KIND_WORDS,
  reachesMachine,
  sessionCredentialChoices,
  sessionCredentialLine,
} from './session-credential-facts'

const CLAUDE_ACCEPTS = [
  { type: 'anthropic.api-key', deliver: { kind: 'env', variable: 'ANTHROPIC_API_KEY' } },
  { type: 'anthropic.claude-token', deliver: { kind: 'env', variable: 'CLAUDE_CODE_OAUTH_TOKEN' } },
  { type: 'anthropic.claude-login', deliver: { kind: 'home' } },
]
const CODEX_ACCEPTS = [
  { type: 'openai.api-key', deliver: { kind: 'env', variable: 'OPENAI_API_KEY' } },
  { type: 'openai.chatgpt-login', deliver: { kind: 'home' } },
  {
    type: 'openai.chatgpt-plan',
    deliver: { kind: 'env', variable: 'X' },
    drivers: ['codex-app-server'],
  },
]

const MINE = 'user:me'
const OTHER = 'user:other'
const custody: Record<string, string | null> = { 'mach-mine': MINE, 'mach-other': OTHER }
const custodianOf = (id: string) => custody[id]

const key = credentialView({ label: 'Work key', type: 'anthropic.api-key' })
const login = credentialView({
  label: 'Max login',
  type: 'anthropic.claude-login',
  identity: { email: 'planted@example.invalid' },
  homes: [{ machineId: 'mach-mine', homeId: 'x:claude-code', state: 'in' }],
})
const openai = credentialView({ label: 'OpenAI key', type: 'openai.api-key' })
const plan = credentialView({ label: 'Plan', type: 'openai.chatgpt-plan' })

const labels = (choices: { view: CredentialView }[]) => choices.map((c) => c.view.label)

describe('the kind a session credential reads as', () => {
  it('names every type of the registry and the harness’s own login', () => {
    expect(credentialKind('anthropic.api-key')).toBe('api-key')
    expect(credentialKind('openai.api-key')).toBe('api-key')
    expect(credentialKind('openrouter.api-key')).toBe('api-key')
    expect(credentialKind('anthropic.claude-token')).toBe('token')
    expect(credentialKind('anthropic.claude-login')).toBe('subscription')
    expect(credentialKind('openai.chatgpt-login')).toBe('subscription')
    expect(credentialKind('openai.chatgpt-plan')).toBe('subscription')
    expect(credentialKind(null)).toBe('own-login')
    expect(KIND_WORDS).toEqual({
      subscription: 'Subscription',
      'api-key': 'API key',
      token: 'Token',
      'own-login': 'Its own login',
    })
  })
})

describe('which machine a credential reaches', () => {
  it('a login: only where a home of it is signed in', () => {
    expect(reachesMachine(login, 'mach-mine', custodianOf)).toBe(true)
    expect(reachesMachine(login, 'mach-other', custodianOf)).toBe(false)
    const out = {
      ...login,
      homes: [
        { machineId: asMachineId('mach-mine'), homeId: 'x:claude-code', state: 'out' as const },
      ],
    }
    expect(reachesMachine(out, 'mach-mine', custodianOf)).toBe(false)
  })

  it('a vault secret: its owner’s machines, and machines it was sent to', () => {
    expect(reachesMachine(key, 'mach-mine', custodianOf)).toBe(true)
    expect(reachesMachine(key, 'mach-other', custodianOf)).toBe(false)
    const sent = { ...key, allowedMachines: ['mach-other'] } as CredentialView
    expect(reachesMachine(sent, 'mach-other', custodianOf)).toBe(true)
    const shared = { ...key, ownerUserId: OTHER } as CredentialView
    expect(reachesMachine(shared, 'mach-other', custodianOf)).toBe(true)
    expect(reachesMachine(shared, 'mach-mine', custodianOf)).toBe(false)
  })

  it('a machine whose custodian is not known: left to the server', () => {
    expect(reachesMachine(key, 'mach-unknown', custodianOf)).toBe(true)
  })
})

describe('the choices for a session', () => {
  const views = [key, login, openai, plan]

  it('lists only what the harness accepts and what reaches the machine', () => {
    const base = { views, custodianOf }
    expect(
      labels(
        sessionCredentialChoices({ ...base, accepts: CLAUDE_ACCEPTS, machineId: 'mach-mine' }),
      ),
    ).toEqual(['Work key', 'Max login'])
    expect(
      labels(
        sessionCredentialChoices({ ...base, accepts: CLAUDE_ACCEPTS, machineId: 'mach-other' }),
      ),
    ).toEqual([])
    expect(
      labels(sessionCredentialChoices({ ...base, accepts: CODEX_ACCEPTS, machineId: 'mach-mine' })),
    ).toEqual(['OpenAI key', 'Plan'])
  })

  it('a line held for some drivers only counts with no driver named or one of them', () => {
    const base = { views, custodianOf, accepts: CODEX_ACCEPTS, machineId: 'mach-mine' }
    expect(labels(sessionCredentialChoices({ ...base, driverId: 'codex-app-server' }))).toContain(
      'Plan',
    )
    expect(labels(sessionCredentialChoices({ ...base, driverId: 'codex-tui' }))).not.toContain(
      'Plan',
    )
  })

  it('a removed one is never offered; one needing attention is offered disabled with why', () => {
    const removed = {
      ...key,
      id: asCredentialId('cred_00000000-0000-4000-8000-0000000000aa'),
      status: 'revoked' as const,
    }
    const sick = {
      ...key,
      id: asCredentialId('cred_00000000-0000-4000-8000-0000000000ab'),
      label: 'Sick',
      status: 'attention' as const,
      statusReason: 'The provider rejected it.',
    }
    const choices = sessionCredentialChoices({
      views: [removed, sick],
      custodianOf,
      accepts: CLAUDE_ACCEPTS,
      machineId: 'mach-mine',
    })
    expect(choices).toEqual([
      { view: sick, disabled: 'Needs attention: The provider rejected it.' },
    ])
  })
})

describe('where the picker starts', () => {
  const choices = sessionCredentialChoices({
    views: [key, login],
    custodianOf,
    accepts: CLAUDE_ACCEPTS,
    machineId: 'mach-mine',
  })

  it('on the person’s default when it is offered', () => {
    expect(initialCredential(choices, login.id)).toBe(login.id)
  })

  it('on the harness’s own login with no default, or a default not offered here', () => {
    expect(initialCredential(choices, undefined)).toBeNull()
    expect(initialCredential(choices, openai.id)).toBeNull()
    const sick = [{ view: login, disabled: 'Needs attention' }]
    expect(initialCredential(sick, login.id)).toBeNull()
  })
})

describe('the line a session shows', () => {
  it('its credential’s label and kind', () => {
    expect(sessionCredentialLine({ credentialId: key.id }, key)).toEqual({
      label: 'Work key',
      kind: 'api-key',
    })
  })

  it('the harness’s own login when it names none', () => {
    expect(sessionCredentialLine({}, undefined)).toEqual({
      label: 'Its own login',
      kind: 'own-login',
    })
  })

  it('one the viewer cannot see: the kind the harness reported, under a neutral label', () => {
    expect(
      sessionCredentialLine(
        { credentialId: key.id, effectiveAuth: { method: 'subscription' } },
        undefined,
      ),
    ).toEqual({ label: 'Another member’s credential', kind: 'subscription' })
    expect(sessionCredentialLine({ credentialId: key.id }, undefined)).toEqual({
      label: 'Another member’s credential',
      kind: undefined,
    })
  })
})
