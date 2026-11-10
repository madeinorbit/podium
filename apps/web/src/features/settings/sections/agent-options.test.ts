import { BUNDLED_DESCRIPTORS } from '@podium/harness/browser'
import { type AccountView, asAccountId } from '@podium/model/browser'
import type { HarnessDescriptorWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { agentOptions, backendForAgent } from './agent-options'

const managed = (provider: string, patch: Partial<AccountView> = {}): AccountView => ({
  id: `managed:${provider}`,
  provider,
  source: 'managed',
  kind: 'api-key',
  status: 'connected',
  credentialSource: 'stored',
  ...patch,
})
const accounts: AccountView[] = [
  {
    id: 'native:codex:person',
    provider: 'openai',
    source: 'native',
    harness: 'codex',
    identity: 'person@example.com',
    machines: ['Workstation', 'Laptop'],
    status: 'connected',
  },
  managed('anthropic'),
  managed('openai', { credentialSource: 'shared', sharedBy: 'Ana' }),
  managed('openrouter'),
  managed('claude-oauth', { provider: 'anthropic', kind: 'oauth' }),
]

describe('Agent choices', () => {
  it('pairs each connected managed credential with every harness it can drive (#216)', () => {
    const future = {
      ...BUNDLED_DESCRIPTORS[0],
      kind: 'future-cli',
      provider: 'anthropic',
      label: 'Future CLI',
    } as HarnessDescriptorWire
    const options = agentOptions(accounts, false, [...BUNDLED_DESCRIPTORS, future])
    expect(
      options
        .filter((option) => option.accountId === 'managed:anthropic')
        .map((option) => option.harness),
    ).toEqual(['claude-code', 'future-cli'])
    expect(options.find((option) => option.accountId === 'managed:claude-oauth')?.harness).toBe(
      'claude-code',
    )
    expect(options.find((option) => option.accountId === 'managed:openai')?.harness).toBe('codex')
    expect(options.some((option) => option.accountId === 'managed:openrouter')).toBe(false)
    expect(new Set(options.map((option) => option.value)).size).toBe(options.length)
  })

  it('groups personal logins and keys separately from the resolved shared key', () => {
    const options = agentOptions(accounts)
    const native = options.find((option) => option.accountId === 'native:codex:person')
    expect(native?.group).toBe('Signed in on your machines')
    expect(native?.hint).toBe('person@example.com · Workstation, Laptop')
    expect(options.find((option) => option.accountId === 'managed:anthropic')?.group).toBe(
      'Using your API key',
    )
    const shared = options.find((option) => option.accountId === 'managed:openai')
    expect(shared?.group).toBe('Shared with you')
    expect(shared?.hint).toBe('Ana’s OpenAI key')
    expect(shared?.help).toContain('you have no OpenAI key of your own')
    expect(shared?.help).toContain('Billed per token to their key')
  })

  it('offers native logins only for the superagent, and never invents an unconfigured key', () => {
    expect(agentOptions(accounts, true).map((option) => option.accountId)).toEqual([
      'native:codex:person',
    ])
    expect(agentOptions([managed('openai', { status: 'not-configured' })])).toEqual([])
    expect(agentOptions([])).toEqual([])
  })
})

describe('Compatible agent changes', () => {
  const backend = {
    accountId: asAccountId('native:codex'),
    harness: 'codex' as const,
    model: 'shared-model',
    effort: 'high',
  }
  const next = { accountId: asAccountId('managed:anthropic'), harness: 'claude-code' as const }

  it('writes both account and harness and retains a model and effort supported by the destination', () => {
    expect(
      backendForAgent(backend, 'codex', next, [
        { value: 'shared-model', label: 'Shared', efforts: ['high'] },
      ]),
    ).toEqual({ ...backend, ...next })
  })
  it('resets only an unsupported effort when the model remains available', () => {
    expect(
      backendForAgent(backend, 'codex', next, [
        { value: 'shared-model', label: 'Shared', efforts: ['low'] },
      ]),
    ).toEqual({ ...backend, ...next, effort: 'auto' })
  })
  it('resets model and effort when the destination catalog cannot run them', () => {
    expect(
      backendForAgent(backend, 'codex', next, [{ value: 'different', label: 'Different' }]),
    ).toEqual({ ...backend, ...next, model: 'auto', effort: 'auto' })
  })
  it('keeps an unreported custom model when only its credential changes', () => {
    expect(
      backendForAgent(backend, 'codex', {
        accountId: asAccountId('managed:openai'),
        harness: 'codex',
      }),
    ).toEqual({ ...backend, accountId: 'managed:openai' })
  })
  it('replaces a stale harness when selecting a native login', () => {
    expect(
      backendForAgent(backend, 'codex', {
        accountId: asAccountId('native:claude-code'),
        harness: 'claude-code',
      }),
    ).toMatchObject({
      accountId: 'native:claude-code',
      harness: 'claude-code',
      model: 'auto',
      effort: 'auto',
    })
  })
})
