import { AUTO } from '@podium/client-core/agent-models'
import { normalizeSettings } from '@podium/runtime'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialView } from '@/test-support/credential-view'
import { credentialModelSource, modelFor, RoleCredentialSelect } from './role-credential'

afterEach(cleanup)

const key = credentialView({ label: 'Anthropic key', type: 'anthropic.api-key' })
const openai = credentialView({ label: 'OpenAI key', type: 'openai.api-key' })
const router = credentialView({ label: 'Router key', type: 'openrouter.api-key' })
const codex = credentialView({ label: 'Codex login', type: 'openai.chatgpt-login' })
const token = credentialView({ label: 'Claude token', type: 'anthropic.claude-token' })

function pick(name: RegExp) {
  const item = screen.getByRole('option', { name })
  fireEvent.pointerDown(item)
  fireEvent.pointerUp(item)
  fireEvent.click(item)
}

describe('acceptance 7: the background role offers credentials with a direct-inference route', () => {
  it('lists exactly those, and saves the choice as credentialId next to accountId', () => {
    const backend = normalizeSettings({ roles: { background: { accountId: 'managed:openai' } } })
      .roles.background
    const onChange = vi.fn()
    render(
      <RoleCredentialSelect
        roleName="background"
        views={[key, openai, router, codex, token]}
        backend={backend}
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Credential' }))
    const offered = screen.getAllByRole('option').map((option) => option.textContent ?? '')
    for (const label of ['Anthropic key', 'OpenAI key', 'Router key', 'Codex login']) {
      expect(offered.some((text) => text.includes(label))).toBe(true)
    }
    expect(offered.some((text) => text.includes('Claude token'))).toBe(false)
    pick(/Router key/)
    expect(onChange).toHaveBeenCalledWith({ ...backend, credentialId: router.id })
  })

  it('says what the pick serves and what runs without one, and clears it', () => {
    const backend = {
      ...normalizeSettings({}).roles.background,
      credentialId: key.id,
    }
    const onChange = vi.fn()
    render(
      <RoleCredentialSelect
        roleName="background"
        views={[key]}
        backend={backend}
        onChange={onChange}
      />,
    )
    expect(
      screen.getByText(/With none picked they use the choice saved before credentials/),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('combobox', { name: 'Credential' }))
    pick(/None picked/)
    const { credentialId: _gone, ...rest } = backend
    expect(onChange).toHaveBeenCalledWith(rest)
  })
})

describe('the model a picked credential implies', () => {
  it('a key gives its provider’s list, a ChatGPT login the Codex catalog, a token nothing', () => {
    expect(credentialModelSource('anthropic.api-key')).toEqual({
      kind: 'api',
      provider: 'anthropic',
    })
    expect(credentialModelSource('openrouter.api-key')).toEqual({
      kind: 'api',
      provider: 'openrouter',
    })
    expect(credentialModelSource('openai.chatgpt-login')).toEqual({
      kind: 'login',
      harness: 'codex',
    })
    // A ChatGPT plan offers Codex's models, never an OpenAI API model (§11).
    expect(credentialModelSource('openai.chatgpt-plan')).toEqual({
      kind: 'login',
      harness: 'codex',
    })
    expect(credentialModelSource('anthropic.claude-token')).toBeUndefined()
    expect(credentialModelSource('someone.else')).toBeUndefined()
  })

  it('keeps a model of the same provider and replaces one of another', () => {
    const anthropic = { kind: 'api', provider: 'anthropic' } as const
    expect(modelFor(anthropic, 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
    expect(modelFor(anthropic, 'google/gemini-2.5-flash')).toBe('claude-haiku-4-5')
    expect(modelFor(anthropic, 'auto')).toBe('claude-haiku-4-5')
    const login = { kind: 'login', harness: 'codex' } as const
    expect(modelFor(login, 'claude-haiku-4-5')).toBe(AUTO)
    expect(modelFor(login, 'gpt-5.5')).toBe('gpt-5.5')
  })
})
