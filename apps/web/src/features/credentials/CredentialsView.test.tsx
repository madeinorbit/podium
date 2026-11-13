/**
 * The credentials page (epic Task 17), rendered as a member who is not an
 * admin (acceptance 9): nothing here reads the admin viewer, and every write
 * goes through the person's own credential commands. Planted secrets are fake.
 */

import { issueAgentDescriptors } from '@podium/client-core/agent-models'
import {
  CREDENTIAL_MACHINE_DISCLOSURE,
  CREDENTIAL_SHARE_DISCLOSURE,
  CREDENTIAL_SHARE_WARNING,
} from '@podium/commands/credentials'
import type { CredentialView } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ReactNode, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialView } from '@/test-support/credential-view'
import { pasteTypes, typeTitle } from './credential-facts'
import type { CredentialDeps } from './credentials-deps'

const frame = vi.hoisted(() => ({ openTakeover: vi.fn(), closeTakeover: vi.fn() }))
vi.mock('@/features/settings/settings-frame', () => ({ useSettingsFrame: () => frame }))

const { CredentialsView } = await import('./CredentialsView')

const NOW = Date.parse('2026-11-13T12:00:00Z')
const DAY = 86_400_000
const ME = 'user:ben'

function commands() {
  const ok = () => vi.fn(async () => ({ ok: true }))
  return {
    add: { mutate: vi.fn(async () => ({ credentialId: 'cred_new' })) },
    rename: { mutate: ok() },
    renew: { mutate: ok() },
    remove: { mutate: ok() },
    share: { mutate: ok() },
    unshare: { mutate: ok() },
    allowMachine: { mutate: ok() },
    disallowMachine: { mutate: ok() },
  }
}

function makeDeps(over: Partial<CredentialDeps> = {}) {
  const c = commands()
  const deps: CredentialDeps = {
    commands: c as unknown as CredentialDeps['commands'],
    reload: vi.fn(),
    currentUserId: ME,
    people: [
      { id: ME, name: 'Ben' },
      { id: 'user:ana', name: 'Ana' },
      { id: 'user:chen', name: 'Chen' },
    ],
    nameOf: (id) => ({ [ME]: 'Ben', 'user:ana': 'Ana', 'user:chen': 'Chen' })[id],
    machineName: (id) => ({ 'machine:desk': 'Desk', 'machine:shared': 'Shared box' })[id] ?? id,
    sendable: [{ id: 'machine:shared', name: 'Shared box' }],
    now: () => NOW,
    ...over,
  }
  return { deps, c }
}

const DESCRIPTORS = issueAgentDescriptors(undefined)

function Page({
  views,
  deps,
  defaults = {},
  patch = vi.fn(),
}: {
  views: readonly CredentialView[] | undefined
  deps: CredentialDeps
  defaults?: Record<string, string>
  patch?: (p: unknown) => void
}) {
  const [flow, setFlow] = useState<ReactNode>(null)
  frame.openTakeover.mockImplementation(({ content }: { content: ReactNode }) => setFlow(content))
  frame.closeTakeover.mockImplementation(() => setFlow(null))
  return (
    <>
      <div hidden={flow !== null}>
        <CredentialsView
          views={views}
          deps={deps}
          descriptors={DESCRIPTORS}
          settings={{ credentialDefaults: defaults as never }}
          patch={patch as never}
        />
      </div>
      <div data-testid="flow">{flow}</div>
    </>
  )
}
const flow = () => within(screen.getByTestId('flow'))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const mine = (over: Partial<CredentialView> = {}) =>
  credentialView({ ownerUserId: ME, access: 'owner', ...over })

function openDetail(view: CredentialView, deps: CredentialDeps) {
  render(<Page views={[view]} deps={deps} />)
  fireEvent.click(screen.getByRole('button', { name: view.label }))
}

describe('acceptance 1: the list states', () => {
  it('shows each state, and a revoked credential is not listed', () => {
    const { deps } = makeDeps()
    const views = [
      mine({ label: 'Fine key' }),
      mine({ label: 'Broken key', status: 'attention', statusReason: 'The provider rejected it.' }),
      mine({
        label: 'Busy plan',
        type: 'anthropic.claude-token',
        limitReachedUntil: new Date(NOW + 2 * 3_600_000).toISOString(),
      }),
      mine({
        label: 'Old token',
        type: 'anthropic.claude-token',
        expiresAt: new Date(NOW + 5 * DAY).toISOString(),
      }),
      credentialView({ label: 'Ana key', ownerUserId: 'user:ana', access: 'use' }),
      mine({
        label: 'Leaving login',
        type: 'anthropic.claude-login',
        homes: [
          { machineId: 'machine:desk', homeId: 'h1', state: 'removal-pending' },
        ] as CredentialView['homes'],
      }),
      mine({ label: 'Gone key', status: 'revoked' }),
    ]
    render(<Page views={views} deps={deps} />)
    const row = (label: string) =>
      (screen.getByText(label).closest('.settings-list-row') as HTMLElement).textContent
    expect(row('Fine key')).toContain('Ready')
    expect(row('Broken key')).toContain('Needs attention: The provider rejected it.')
    expect(row('Busy plan')).toMatch(/Limit reached until /)
    expect(row('Old token')).toContain('Expires in 5 days')
    expect(row('Ana key')).toContain('Shared with you by Ana')
    expect(row('Leaving login')).toContain('Removal pending on Desk')
    expect(screen.queryByText('Gone key')).toBeNull()
  })

  it('a credential granted to me opens nothing and offers no write action', () => {
    const { deps, c } = makeDeps()
    const granted = credentialView({ label: 'Ana key', ownerUserId: 'user:ana', access: 'use' })
    render(<Page views={[granted, mine({ label: 'My key' })]} deps={deps} />)
    expect(screen.getByText('Ana key')).toBeTruthy()
    // Canary: my own row does open.
    expect(screen.getByRole('button', { name: 'My key' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Ana key' })).toBeNull()
    for (const command of Object.values(c)) expect(command.mutate).not.toHaveBeenCalled()
  })

  it('says when there are none, and while loading', () => {
    const { deps } = makeDeps()
    const { rerender } = render(<Page views={undefined} deps={deps} />)
    expect(screen.getByText('Loading credentials…')).toBeTruthy()
    rerender(<Page views={[]} deps={deps} />)
    expect(screen.getByText(/None yet/)).toBeTruthy()
  })
})

describe('acceptance 2: adding by paste', () => {
  it('offers one paste entry per type obtained by pasting', () => {
    const { deps } = makeDeps()
    render(<Page views={[]} deps={deps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    for (const type of pasteTypes()) {
      expect(flow().getByRole('button', { name: typeTitle(type) })).toBeTruthy()
    }
    expect(flow().queryByRole('button', { name: 'Claude subscription login' })).toBeNull()
  })

  it.each(
    pasteTypes(),
  )('%s: stores it, then shows the masked identity, never the secret', async (type) => {
    const { deps, c } = makeDeps()
    const secret = `FAKE-secret-6903-${type}`
    const { rerender } = render(<Page views={[]} deps={deps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(flow().getByRole('button', { name: typeTitle(type) }))
    fireEvent.change(flow().getByLabelText('Name'), { target: { value: 'Planted' } })
    fireEvent.change(flow().getByLabelText(typeTitle(type)), { target: { value: secret } })
    // Canary: the form holds the secret before it is sent.
    expect(screen.getByDisplayValue(secret)).toBeTruthy()
    fireEvent.click(flow().getByRole('button', { name: 'Add' }))
    await waitFor(() =>
      expect(c.add.mutate).toHaveBeenCalledWith({ type, label: 'Planted', secret }),
    )
    await waitFor(() => expect(frame.closeTakeover).toHaveBeenCalled())
    expect(deps.reload).toHaveBeenCalled()
    rerender(
      <Page
        views={[mine({ label: 'Planted', type, identity: { masked: 'FAKE…6903' } })]}
        deps={deps}
      />,
    )
    expect(screen.getByText('FAKE…6903')).toBeTruthy()
    expect(screen.queryByDisplayValue(secret)).toBeNull()
    expect(document.body.innerHTML).not.toContain(secret)
  })

  it('keeps the form and shows the reason when the server refuses', async () => {
    const { deps, c } = makeDeps()
    c.add.mutate.mockRejectedValueOnce(new Error('You already added this key as "Work".'))
    render(<Page views={[]} deps={deps} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(flow().getByRole('button', { name: 'Anthropic API key' }))
    fireEvent.change(flow().getByLabelText('Anthropic API key'), {
      target: { value: 'FAKE-dup-6903' },
    })
    fireEvent.click(flow().getByRole('button', { name: 'Add' }))
    expect(await flow().findByRole('alert')).toHaveProperty(
      'textContent',
      'You already added this key as "Work".',
    )
    expect(frame.closeTakeover).not.toHaveBeenCalled()
  })
})

describe('acceptance 3: rename, renew and remove', () => {
  it('renames', async () => {
    const { deps, c } = makeDeps()
    const view = mine({ label: 'Work key' })
    openDetail(view, deps)
    fireEvent.change(flow().getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Team key' },
    })
    fireEvent.click(flow().getByRole('button', { name: 'Rename' }))
    await waitFor(() =>
      expect(c.rename.mutate).toHaveBeenCalledWith({ credentialId: view.id, label: 'Team key' }),
    )
  })

  it('renews under the same id', async () => {
    const { deps, c } = makeDeps()
    const view = mine({ label: 'Work key' })
    openDetail(view, deps)
    fireEvent.click(flow().getByRole('button', { name: 'Renew…' }))
    fireEvent.change(flow().getByLabelText('New Anthropic API key'), {
      target: { value: 'FAKE-renewed-6903' },
    })
    fireEvent.click(flow().getByRole('button', { name: 'Renew' }))
    await waitFor(() =>
      expect(c.renew.mutate).toHaveBeenCalledWith({
        credentialId: view.id,
        secret: 'FAKE-renewed-6903',
      }),
    )
    await waitFor(() => expect(flow().queryByDisplayValue('FAKE-renewed-6903')).toBeNull())
  })

  it.each([
    ['anthropic.api-key', /stays valid at Anthropic until you revoke it there/],
    ['anthropic.claude-token', /stays valid at Anthropic until you revoke it there/],
    ['openai.chatgpt-login', /signs out of OpenAI in each home it made/],
    ['openai.chatgpt-plan', /withdraws its access at OpenAI/],
  ])('%s: the removal dialog says what happens at the provider, then removes', async (type, said) => {
    const { deps, c } = makeDeps()
    const view = mine({ label: 'To go', type })
    openDetail(view, deps)
    fireEvent.click(flow().getByRole('button', { name: 'Remove…' }))
    const dialog = flow().getByRole('form', { name: 'Remove' })
    expect(dialog.textContent).toMatch(said)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(c.remove.mutate).toHaveBeenCalledWith({ credentialId: view.id }))
    await waitFor(() => expect(frame.closeTakeover).toHaveBeenCalled())
  })
})

describe('acceptance 4: sharing', () => {
  // A person ticks the box by clicking its sentence.
  const tick = async (sentence: string) => await userEvent.click(flow().getByText(sentence))

  it('a key needs the disclosure, no warning, and can go to everyone', async () => {
    const { deps, c } = makeDeps()
    const view = mine({ label: 'Work key' })
    openDetail(view, deps)
    fireEvent.click(flow().getByRole('button', { name: 'Share…' }))
    const share = flow().getByRole('button', { name: 'Share' })
    expect(share).toHaveProperty('disabled', true)
    expect(flow().queryByText(CREDENTIAL_SHARE_WARNING)).toBeNull()
    await tick(CREDENTIAL_SHARE_DISCLOSURE)
    expect(share).toHaveProperty('disabled', false)
    fireEvent.click(share)
    await waitFor(() =>
      expect(c.share.mutate).toHaveBeenCalledWith({
        credentialId: view.id,
        grantee: 'all-members',
        verb: 'use',
        acknowledgeDisclosure: true,
      }),
    )
  })

  it('a subscription also needs the warning; a member can be given manage', async () => {
    const { deps, c } = makeDeps()
    const view = mine({ label: 'My plan', type: 'anthropic.claude-token' })
    openDetail(view, deps)
    fireEvent.click(flow().getByRole('button', { name: 'Share…' }))
    const who = flow().getByLabelText('Share with') as HTMLSelectElement
    // The grantee is a member or everyone; never me.
    expect([...who.options].map((option) => option.textContent)).toEqual([
      'Everyone on this server',
      'Ana',
      'Chen',
    ])
    fireEvent.change(who, { target: { value: 'user:ana' } })
    fireEvent.change(flow().getByLabelText('They may'), { target: { value: 'manage' } })
    const share = flow().getByRole('button', { name: 'Share' })
    await tick(CREDENTIAL_SHARE_DISCLOSURE)
    expect(share).toHaveProperty('disabled', true)
    await tick(CREDENTIAL_SHARE_WARNING)
    expect(share).toHaveProperty('disabled', false)
    fireEvent.click(share)
    await waitFor(() =>
      expect(c.share.mutate).toHaveBeenCalledWith({
        credentialId: view.id,
        grantee: { userId: 'user:ana' },
        verb: 'manage',
        acknowledgeDisclosure: true,
        acknowledgeWarning: true,
      }),
    )
  })

  it('lists whom it is shared with and stops sharing', async () => {
    const { deps, c } = makeDeps()
    const view = mine({
      label: 'Work key',
      sharedWith: [
        { grantee: 'all-members', verb: 'use' },
        { grantee: { userId: 'user:ana' }, verb: 'manage' },
      ] as CredentialView['sharedWith'],
    })
    openDetail(view, deps)
    expect(flow().getByText('Everyone on this server')).toBeTruthy()
    const ana = flow().getByText('Ana').closest('.settings-list-row') as HTMLElement
    expect(within(ana).getByText('May use and manage it')).toBeTruthy()
    fireEvent.click(within(ana).getByRole('button', { name: 'Stop sharing' }))
    await waitFor(() =>
      expect(c.unshare.mutate).toHaveBeenCalledWith({
        credentialId: view.id,
        grantee: { userId: 'user:ana' },
        verb: 'manage',
      }),
    )
  })
})

describe('acceptance 5: send to a machine', () => {
  it('lists the machines it may be sent to and needs the acknowledgement', async () => {
    const { deps, c } = makeDeps()
    const view = mine({ label: 'Work key' })
    openDetail(view, deps)
    fireEvent.click(flow().getByRole('button', { name: 'Send…' }))
    const dialog = flow().getByRole('form', { name: 'Send to Shared box' })
    expect(dialog.textContent).toContain(CREDENTIAL_MACHINE_DISCLOSURE)
    const send = within(dialog).getByRole('button', { name: 'Send to Shared box' })
    expect(send).toHaveProperty('disabled', true)
    await userEvent.click(within(dialog).getByText('I understand. Send Work key to Shared box.'))
    fireEvent.click(send)
    await waitFor(() =>
      expect(c.allowMachine.mutate).toHaveBeenCalledWith({
        credentialId: view.id,
        machineId: 'machine:shared',
        acknowledgeDisclosure: true,
      }),
    )
  })

  it('takes a sent credential back', async () => {
    const { deps, c } = makeDeps()
    const view = mine({ label: 'Work key', allowedMachines: ['machine:shared'] as never })
    openDetail(view, deps)
    fireEvent.click(flow().getByRole('button', { name: 'Take back' }))
    await waitFor(() =>
      expect(c.disallowMachine.mutate).toHaveBeenCalledWith({
        credentialId: view.id,
        machineId: 'machine:shared',
      }),
    )
  })

  it('says so when there is no other machine', () => {
    const { deps } = makeDeps({ sendable: [] })
    openDetail(mine({ label: 'Work key' }), deps)
    expect(flow().getByText(/There is no other machine you may run on/)).toBeTruthy()
  })
})

describe('acceptance 6: the default for each agent', () => {
  const anthropic = mine({ label: 'Anthropic work', type: 'anthropic.api-key' })
  const openai = mine({ label: 'OpenAI work', type: 'openai.api-key' })

  function choose(label: string, option: RegExp) {
    fireEvent.click(screen.getByRole('combobox', { name: label }))
    const item = screen.getByRole('option', { name: option })
    fireEvent.pointerDown(item)
    fireEvent.pointerUp(item)
    fireEvent.click(item)
  }

  it('offers only what the agent accepts, and sets it', () => {
    const { deps } = makeDeps()
    const patch = vi.fn()
    render(<Page views={[anthropic, openai]} deps={deps} patch={patch} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Claude Code' }))
    const offered = screen.getAllByRole('option').map((option) => option.textContent)
    expect(offered.some((text) => text?.includes('Anthropic work'))).toBe(true)
    expect(offered.some((text) => text?.includes('OpenAI work'))).toBe(false)
    const item = screen.getByRole('option', { name: /Anthropic work/ })
    fireEvent.pointerDown(item)
    fireEvent.pointerUp(item)
    fireEvent.click(item)
    expect(patch).toHaveBeenCalledWith({ credentialDefaults: { 'claude-code': anthropic.id } })
  })

  it('clears it back to the agent’s own login, keeping the others', () => {
    const { deps } = makeDeps()
    const patch = vi.fn()
    render(
      <Page
        views={[anthropic, openai]}
        deps={deps}
        defaults={{ 'claude-code': anthropic.id, codex: openai.id }}
        patch={patch}
      />,
    )
    choose('Claude Code', /Its own login/)
    expect(patch).toHaveBeenCalledWith({ credentialDefaults: { codex: openai.id } })
  })

  it('says when the saved default is not available any more', () => {
    const { deps } = makeDeps()
    render(<Page views={[openai]} deps={deps} defaults={{ 'claude-code': 'cred_gone' }} />)
    expect(screen.getByText(/The saved credential is not available any more/)).toBeTruthy()
  })
})
