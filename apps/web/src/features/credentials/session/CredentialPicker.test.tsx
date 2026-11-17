import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialView } from '@/test-support/credential-view'
import { type CredentialPick, CredentialPicker, shownCredential } from './CredentialPicker'

afterEach(cleanup)

const ACCEPTS: Record<string, { type: string; drivers?: string[] }[]> = {
  'claude-code': [
    { type: 'anthropic.api-key' },
    { type: 'anthropic.claude-token' },
    { type: 'anthropic.claude-login' },
  ],
  codex: [{ type: 'openai.api-key' }, { type: 'openai.chatgpt-login' }],
}
const custodianOf = (id: string) => ({ laptop: 'user:me', shared: 'user:other' })[id]

const anthropicKey = credentialView({ label: 'Anthropic key', type: 'anthropic.api-key' })
const max = credentialView({
  label: 'Max plan',
  type: 'anthropic.claude-login',
  identity: { email: 'planted@example.invalid' },
  homes: [{ machineId: 'laptop', homeId: 'h:claude-code', state: 'in' }],
})
const openaiKey = credentialView({ label: 'OpenAI key', type: 'openai.api-key' })
const sentKey = credentialView({
  label: 'Sent key',
  type: 'anthropic.api-key',
  // Shared with me by a member who sent it to the shared machine only.
  ownerUserId: 'user:third',
  access: 'use',
  allowedMachines: ['shared'],
})
const views = [anthropicKey, max, openaiKey, sentKey]
const defaults = { 'claude-code': max.id, codex: openaiKey.id }

function Harness(props: {
  harness: string
  machineId: string
  loaded?: boolean
  onShown?: (value: unknown) => void
}) {
  const [pick, setPick] = useState<CredentialPick | undefined>(undefined)
  const input = {
    harness: props.harness,
    machineId: props.machineId,
    views: props.loaded === false ? undefined : views,
    accepts: ACCEPTS[props.harness] ?? [],
    defaultId: defaults[props.harness as keyof typeof defaults],
    custodianOf,
    pick,
  }
  props.onShown?.(shownCredential(input))
  return <CredentialPicker {...input} onPick={setPick} />
}

const offered = () => screen.getAllByRole('menuitem').map((item) => item.textContent ?? '')

function open() {
  fireEvent.click(screen.getByRole('button', { name: /^Credential/ }))
}

describe('acceptance 1: the credential picker when starting a session', () => {
  it('starts on the person’s default and offers only what this harness can use on this machine', () => {
    render(<Harness harness="claude-code" machineId="laptop" />)
    expect(screen.getByRole('button', { name: /^Credential/ }).textContent).toContain('Max plan')
    open()
    const items = offered()
    expect(items.some((t) => t.includes('Anthropic key'))).toBe(true)
    expect(items.some((t) => t.includes('Max plan') && t.includes('Subscription'))).toBe(true)
    // Another harness's type, and a key only sent to another machine, are not offered.
    expect(items.some((t) => t.includes('OpenAI key'))).toBe(false)
    expect(items.some((t) => t.includes('Sent key'))).toBe(false)
    // The harness's own login is always there, last.
    expect(items.at(-1)).toContain('Its own login')
  })

  it('follows a change of harness: that harness’s credentials and its default', () => {
    const shown = vi.fn()
    const view = render(<Harness harness="claude-code" machineId="laptop" onShown={shown} />)
    expect(shown).toHaveBeenLastCalledWith(max.id)
    view.rerender(<Harness harness="codex" machineId="laptop" onShown={shown} />)
    expect(screen.getByRole('button', { name: /^Credential/ }).textContent).toContain('OpenAI key')
    expect(shown).toHaveBeenLastCalledWith(openaiKey.id)
    open()
    expect(offered().some((t) => t.includes('Anthropic key'))).toBe(false)
    expect(offered().at(-1)).toContain('Its own login')
  })

  it('follows a change of machine: a login not signed in there goes, and so does the default', () => {
    const shown = vi.fn()
    const view = render(<Harness harness="claude-code" machineId="laptop" onShown={shown} />)
    view.rerender(<Harness harness="claude-code" machineId="shared" onShown={shown} />)
    // The default (a login on the laptop) cannot run there: the picker says so by
    // starting on the harness's own login rather than on a choice that will be refused.
    expect(shown).toHaveBeenLastCalledWith(null)
    open()
    const items = offered()
    expect(items.some((t) => t.includes('Max plan'))).toBe(false)
    expect(items.some((t) => t.includes('Sent key'))).toBe(true)
    expect(items.at(-1)).toContain('Its own login')
  })

  it('keeps a pick while the harness and machine stay, and drops it when they change', () => {
    const shown = vi.fn()
    const view = render(<Harness harness="claude-code" machineId="laptop" onShown={shown} />)
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: /Anthropic key/ }))
    expect(shown).toHaveBeenLastCalledWith(anthropicKey.id)
    view.rerender(<Harness harness="claude-code" machineId="laptop" onShown={shown} />)
    expect(shown).toHaveBeenLastCalledWith(anthropicKey.id)
    view.rerender(<Harness harness="codex" machineId="laptop" onShown={shown} />)
    expect(shown).toHaveBeenLastCalledWith(openaiKey.id)
  })

  it('picking the harness’s own login sends none, explicitly', () => {
    const shown = vi.fn()
    render(<Harness harness="claude-code" machineId="laptop" onShown={shown} />)
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: /Its own login/ }))
    expect(shown).toHaveBeenLastCalledWith(null)
  })

  it('before the list has loaded it chooses nothing, so the server applies the default', () => {
    const shown = vi.fn()
    render(<Harness harness="claude-code" machineId="laptop" loaded={false} onShown={shown} />)
    expect(shown).toHaveBeenLastCalledWith(undefined)
  })
})
