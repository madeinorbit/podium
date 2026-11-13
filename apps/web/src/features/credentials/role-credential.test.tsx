import { normalizeSettings } from '@podium/runtime'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialView } from '@/test-support/credential-view'
import { RoleCredentialSelect } from './role-credential'

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

  it('never presents the saved choice as what runs today, and clears it', () => {
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
    expect(screen.getByText(/Until then they run on “Runs on” above/)).toBeTruthy()
    fireEvent.click(screen.getByRole('combobox', { name: 'Credential' }))
    pick(/None picked/)
    const { credentialId: _gone, ...rest } = backend
    expect(onChange).toHaveBeenCalledWith(rest)
  })
})
