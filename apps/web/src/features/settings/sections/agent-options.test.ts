import { BUNDLED_DESCRIPTORS } from '@podium/harness/browser'
import { type CredentialView, asAccountId } from '@podium/model/browser'
import type { HarnessDescriptorWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { agentOptions, backendForAgent } from './agent-options'

const accounts: CredentialView[] = [{
  id: 'cred_found-codex', ownerUserId: 'user:me', label: 'Codex', type: 'openai.chatgpt-login',
  identity: { email: 'person@example.com' }, status: 'ok', access: 'owner', homes: [],
  allowedMachines: [], sessionCount: 0,
  nativeLogin: { harness: 'codex', required: false, keptOn: [], useOnMyMachines: false,
    machines: [{ id: 'workstation', name: 'Workstation', state: 'in' }, { id: 'laptop', name: 'Laptop', state: 'in' }] },
}] as CredentialView[]

describe('Agent choices', () => {
  it('offers every agent program the fleet serves, once, by harness', () => {
    const future = {
      ...BUNDLED_DESCRIPTORS[0],
      kind: 'future-cli',
      provider: 'anthropic',
      label: 'Future CLI',
    } as HarnessDescriptorWire
    const options = agentOptions(accounts, [...BUNDLED_DESCRIPTORS, future])
    expect(options.map((option) => option.harness)).toContain('future-cli')
    expect(options.map((option) => option.harness)).toContain('claude-code')
    expect(new Set(options.map((option) => option.value)).size).toBe(options.length)
    for (const option of options) expect(option.value).toBe(option.harness)
  })

  it("names who a program is signed in as on the person's machines, and nothing for a logged-out one", () => {
    const options = agentOptions(accounts)
    expect(options.find((option) => option.harness === 'codex')?.hint).toBe(
      'person@example.com · Workstation, Laptop',
    )
    expect(options.find((option) => option.harness === 'claude-code')?.hint).toBe('')
  })

  it('says where the credential comes from, and writes no account id', () => {
    const codex = agentOptions(accounts).find((option) => option.harness === 'codex')
    expect(codex?.help).toContain('default credential')
    expect(codex).not.toHaveProperty('accountId')
  })
})

describe('Compatible agent changes', () => {
  const backend = {
    accountId: asAccountId('native:codex'),
    harness: 'codex' as const,
    model: 'shared-model',
    effort: 'high',
  }
  const next = { harness: 'claude-code' as const }
  /** A pick clears an account id saved before credentials and writes only the harness. */
  const picked = { accountId: asAccountId(''), harness: 'claude-code' as const }

  it('writes the harness, clears the old account id, and retains a model and effort the destination supports', () => {
    expect(
      backendForAgent(backend, 'codex', next, [
        { value: 'shared-model', label: 'Shared', efforts: ['high'] },
      ]),
    ).toEqual({ ...backend, ...picked })
  })
  it('resets only an unsupported effort when the model remains available', () => {
    expect(
      backendForAgent(backend, 'codex', next, [
        { value: 'shared-model', label: 'Shared', efforts: ['low'] },
      ]),
    ).toEqual({ ...backend, ...picked, effort: 'auto' })
  })
  it('resets model and effort when the destination catalog cannot run them', () => {
    expect(
      backendForAgent(backend, 'codex', next, [{ value: 'different', label: 'Different' }]),
    ).toEqual({ ...backend, ...picked, model: 'auto', effort: 'auto' })
  })
  it('keeps an unreported custom model when the same harness is picked again', () => {
    expect(backendForAgent(backend, 'codex', { harness: 'codex' })).toEqual({
      ...backend,
      accountId: '',
    })
  })
  it('resets model and effort for another harness with no report', () => {
    expect(backendForAgent(backend, 'codex', { harness: 'claude-code' })).toMatchObject({
      accountId: '',
      harness: 'claude-code',
      model: 'auto',
      effort: 'auto',
    })
  })
})
