import type { CredentialView } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { credentialView as view } from '@/test-support/credential-view'
import {
  EXPIRING_SOON_DAYS,
  harnessChoices,
  inferenceChoices,
  listed,
  pasteTypes,
  removalSentence,
  sendableMachines,
  statusLines,
  typeTitle,
} from './credential-facts'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const DAY = 86_400_000

const ctx = {
  now: NOW,
  ownerName: (id: string) => (id === 'user:ana' ? 'Ana' : undefined),
  machineName: (id: string) => (id === 'machine:desk' ? 'Desk' : id),
}
const texts = (v: CredentialView) => statusLines(v, ctx).map((line) => line.text)

describe('statusLines', () => {
  it('ok reads Ready', () => {
    expect(statusLines(view(), ctx)).toEqual([{ tone: 'ok', text: 'Ready' }])
  })

  it('a found login that needs repair never also reads Ready', () => {
    const login = view({
      type: 'openai.chatgpt-login',
      nativeLogin: { harness: 'codex', required: true, machines: [], keptOn: [] },
    })
    expect(statusLines(login, ctx)).toEqual([{ tone: 'warn', text: 'Machine login needed.' }])
  })

  it('needs attention names its reason', () => {
    const lines = statusLines(
      view({ status: 'attention', statusReason: 'The key was rejected.' }),
      ctx,
    )
    expect(lines).toEqual([{ tone: 'warn', text: 'Needs attention: The key was rejected.' }])
  })

  it('limit reached until a future time, and nothing once it passed', () => {
    const until = new Date(NOW + 3 * 3_600_000).toISOString()
    expect(texts(view({ limitReachedUntil: until }))[0]).toMatch(/^Limit reached until /)
    expect(texts(view({ limitReachedUntil: new Date(NOW - 1).toISOString() }))).toEqual(['Ready'])
  })

  it('expiring soon at the boundary, expired once past, quiet further out', () => {
    const at = (days: number) => new Date(NOW + days * DAY).toISOString()
    expect(texts(view({ expiresAt: at(EXPIRING_SOON_DAYS) }))).toEqual(['Expires in 14 days'])
    expect(texts(view({ expiresAt: at(1) }))).toEqual(['Expires in 1 day'])
    expect(texts(view({ expiresAt: at(-1) }))).toEqual(['Expired'])
    expect(statusLines(view({ expiresAt: at(15) }), ctx)[0]?.tone).toBe('ok')
  })

  it('granted to me names the owner, or says another member when the roster is missing', () => {
    expect(texts(view({ access: 'use', ownerUserId: 'user:ana' }))).toContain(
      'Shared with you by Ana',
    )
    expect(texts(view({ access: 'use', ownerUserId: 'user:gone' }))).toContain(
      'Shared with you by another member',
    )
  })

  it('removal pending names the machine', () => {
    const v = view({
      homes: [
        { machineId: 'machine:desk', homeId: 'h1', state: 'removal-pending' },
        { machineId: 'machine:lap', homeId: 'h2', state: 'in' },
      ] as CredentialView['homes'],
    })
    expect(statusLines(v, ctx)).toContainEqual({ tone: 'warn', text: 'Removal pending on Desk' })
  })
})

describe('listed', () => {
  it('leaves out a revoked credential', () => {
    const kept = view()
    expect(listed([kept, view({ status: 'revoked' })])).toEqual([kept])
  })

  it('keeps a removed credential while a machine has not confirmed its removal (Task 13)', () => {
    const pending = view({
      status: 'revoked',
      homes: [
        { machineId: 'machine:desk', homeId: 'default', state: 'removal-pending' },
      ] as CredentialView['homes'],
    })
    expect(listed([pending])).toEqual([pending])
    expect(texts(pending)).toEqual(['Removed', 'Removal pending on Desk'])
    // Never offered as a choice.
    expect(harnessChoices([pending], [{ type: pending.type }])).toEqual([])
    expect(inferenceChoices([pending])).toEqual([])
  })
})

describe('removalSentence', () => {
  it('says a key stays valid at the provider', () => {
    expect(removalSentence('anthropic.api-key')).toMatch(
      /stays valid at Anthropic until you revoke/,
    )
    expect(removalSentence('anthropic.claude-token')).toMatch(/stays valid at Anthropic/)
  })
  it('says a login is signed out only in homes Podium made', () => {
    expect(removalSentence('openai.chatgpt-login')).toMatch(/signs out of OpenAI in each home/)
    expect(removalSentence('openai.chatgpt-login')).toMatch(
      /A login you made yourself in the agent stays signed in/,
    )
  })
  it('says a plan is withdrawn at the provider', () => {
    expect(removalSentence('openai.chatgpt-plan')).toMatch(/withdraws its access at OpenAI/)
  })
  it('an unknown type promises nothing at the provider', () => {
    expect(removalSentence('acme.thing')).toMatch(/until you revoke it there/)
  })
})

describe('choices', () => {
  const key = view({ type: 'anthropic.api-key' })
  const token = view({ type: 'anthropic.claude-token' })
  const openai = view({ type: 'openai.api-key' })
  const router = view({ type: 'openrouter.api-key' })
  const unknown = view({ type: 'acme.thing' })
  const revoked = view({ type: 'anthropic.api-key', status: 'revoked' })
  const all = [key, token, openai, router, unknown, revoked]

  it('a harness is offered only the types it accepts', () => {
    const accepts = [{ type: 'anthropic.api-key' }, { type: 'anthropic.claude-token' }]
    expect(harnessChoices(all, accepts)).toEqual([key, token])
  })

  it('direct inference is offered only types with a route', () => {
    expect(inferenceChoices(all)).toEqual([key, openai, router])
  })

  it('offers pasteable API keys and tokens, excluding machine logins and OAuth plans', () => {
    expect(pasteTypes()).toEqual([
      'anthropic.api-key',
      'anthropic.claude-token',
      'openai.api-key',
      'openrouter.api-key',
      'google.api-key',
    ])
  })

  it('an unknown type shows its raw id as the title', () => {
    expect(typeTitle('acme.thing')).toBe('acme.thing')
    expect(typeTitle('anthropic.api-key')).toBe('Anthropic API key')
  })
})

describe('sendableMachines (acceptance 5)', () => {
  it('lists only machines I may use and do not hold custody of', () => {
    expect(
      sendableMachines([
        { id: 'machine:mine', name: 'Mine', use: 'granted', owned: true },
        { id: 'machine:shared', name: 'Shared', use: 'granted', owned: false },
        { id: 'machine:denied', name: 'Denied', use: 'denied', owned: false },
        { id: 'machine:unknown', name: 'Unknown' },
      ]),
    ).toEqual([{ id: 'machine:shared', name: 'Shared' }])
  })
})
