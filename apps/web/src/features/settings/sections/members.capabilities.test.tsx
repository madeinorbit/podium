import '@/test-support/mock-request-pool.test.fixture'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { accountCapabilities, passwordCapabilities } from '@/test-support/auth-capabilities'
import { MembersSection } from './members'

const frame = vi.hoisted(() => ({ openTakeover: vi.fn(), closeTakeover: vi.fn() }))
const client = vi.hoisted(() => ({ setSettingsTab: vi.fn() }))
vi.mock('../settings-frame', () => ({
  useSettingsFrame: () => frame,
  SettingsPageActions: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../admin-viewer', () => ({
  useAdminSections: () => ({ status: 'ready', sections: ['people'], retry: vi.fn() }),
}))
vi.mock('../stable-access', () => {
  const trpc = { accounts: { keys: { query: async () => [] }, share: { mutate: async () => ({}) } } }
  return { useSettingsTrpc: () => trpc, useSettingsClient: () => client }
})

const directory = {
  currentMemberId: 'alice',
  hasOwnCredential: false,
  members: [
    { id: 'alice', displayName: 'Alice', email: 'alice@example.com', role: 'admin' },
    { id: 'bob', displayName: 'Bob', email: 'bob@example.com', role: 'member' },
  ],
  invites: [],
  actions: { alice: ['signOutEverywhere'], bob: ['recovery', 'signOutEverywhere', 'disable'] },
}
function serve(capabilities = passwordCapabilities, email: string | null = 'alice@example.com') {
  const fetchMock = vi.fn(async (url: string) =>
    Response.json(
      url.endsWith('/status')
        ? {
            capabilities,
            needsAuth: true,
            authed: true,
            userId: 'alice',
            memberId: 'alice',
            syncBoundaryId: 'fixture',
            prompt: 'email-password',
          }
        : url.endsWith('/list')
          ? { ...directory, members: [{ ...directory.members[0], email }, directory.members[1]] }
          : url.endsWith('/admin/sign-ins')
            ? { signIns: [], signInsTotal: 0 }
            : {
                url: 'https://workspace.example/#invite=secret',
                mailSent: capabilities.invitationDelivery === 'mail',
              },
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
function openTakeover(name: string) {
  const flow = frame.openTakeover.mock.calls.at(-1)?.[0]
  expect(flow.title).toBe(name)
  return within(render(flow.content).container)
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  frame.openTakeover.mockClear()
  client.setSettingsTab.mockClear()
})

test('mail delivery requires an email and never exposes a copyable secret or an admin reset', async () => {
  const fetch = serve(accountCapabilities)
  render(<MembersSection />)
  fireEvent.click(await screen.findByRole('button', { name: 'Bob' }))
  const person = openTakeover('Bob')
  await waitFor(() => expect(person.getByText('Disable')).toBeTruthy())
  expect(person.queryByText('Send a password reset link')).toBeNull()
  expect(person.queryByRole('button', { name: 'Sign out everywhere' })).toBeNull()
  cleanup()

  render(<MembersSection />)
  fireEvent.click(await screen.findByRole('button', { name: 'Invite' }))
  const invite = openTakeover('Invite someone')
  const send = invite.getByRole('button', { name: 'Send invitation' })
  expect(send).toHaveProperty('disabled', true)
  fireEvent.change(invite.getByRole('textbox', { name: 'Email' }), {
    target: { value: 'carol@example.com' },
  })
  fireEvent.click(invite.getByRole('button', { name: 'Admin' }))
  fireEvent.click(invite.getByRole('button', { name: 'Send invitation' }))
  await invite.findByText('Invitation emailed.')
  expect(invite.queryByRole('textbox', { name: 'Invite link' })).toBeNull()
  expect(invite.queryByRole('button', { name: 'Copy link' })).toBeNull()
  expect(fetch).toHaveBeenCalledWith(
    expect.stringMatching(/\/invite$/),
    expect.objectContaining({
      body: JSON.stringify({ email: 'carol@example.com', role: 'admin', current: '' }),
    }),
  )
})

test('an admin with no email must add an address before inviting another person', async () => {
  serve(passwordCapabilities, null)
  render(<MembersSection />)
  fireEvent.click(await screen.findByRole('button', { name: 'Invite' }))
  const invite = openTakeover('Invite someone')
  await waitFor(() =>
    expect(invite.getByText(/Add your email address before inviting/)).toBeTruthy(),
  )
  expect(invite.getByRole('button', { name: 'Create invite link' })).toHaveProperty(
    'disabled',
    true,
  )
  fireEvent.click(invite.getByRole('button', { name: 'Add your email in Account' }))
  expect(client.setSettingsTab).toHaveBeenCalledWith('account')
})
