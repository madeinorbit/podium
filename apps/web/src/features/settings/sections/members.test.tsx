import '@/test-support/mock-request-pool.test.fixture'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MembersSection } from './members'

const frame = vi.hoisted(() => ({ openTakeover: vi.fn(), closeTakeover: vi.fn() }))
const viewer = vi.hoisted(() => ({
  status: 'ready' as 'ready' | 'loading' | 'error',
  sections: ['people'],
  retry: vi.fn(),
}))
const keys = vi.hoisted(() => ({ query: vi.fn(async () => []), share: vi.fn(async () => ({})) }))
vi.mock('../settings-frame', () => ({
  useSettingsFrame: () => frame,
  SettingsPageActions: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../admin-viewer', () => ({ useAdminSections: () => viewer }))
vi.mock('../stable-access', () => {
  const trpc = { accounts: { keys: { query: keys.query }, share: { mutate: keys.share } } }
  return { useSettingsTrpc: () => trpc }
})

const base = {
  currentMemberId: 'admin',
  hasOwnCredential: true,
  mailAvailable: false,
  members: [
    { id: 'admin', displayName: 'Owner', email: null, role: 'admin', disabledAt: null },
    {
      id: 'anna',
      displayName: 'Anna',
      email: 'anna@example.com',
      role: 'member',
      disabledAt: null,
    },
    { id: 'beth', displayName: 'Beth', email: null, role: 'member', disabledAt: '2026-01-01' },
  ],
  invites: [
    {
      id: 'inv_pending',
      email: 'pending@example.com',
      role: 'member',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  ],
  actions: {
    admin: ['signOutEverywhere'],
    anna: ['setRole', 'disable', 'remove', 'recovery', 'signOutEverywhere'],
    beth: ['enable'],
  },
}
function mockApi(
  options: { mail?: boolean; password?: boolean; refusal?: { path: string; error: string } } = {},
) {
  const data = structuredClone(base)
  data.mailAvailable = options.mail ?? false
  data.hasOwnCredential = options.password ?? true
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const refusal = options.refusal && url.endsWith(options.refusal.path)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (!refusal && url.endsWith('/role')) {
      const member = data.members.find((member) => member.id === body.id)
      if (member) member.role = body.role
    }
    if (!refusal && url.endsWith('/revoke'))
      data.invites = data.invites.filter((invite) => invite.id !== body.id)
    return {
      ok: !refusal,
      status: refusal ? 409 : 200,
      json: async () =>
        refusal
          ? { error: options.refusal?.error }
          : url.endsWith('/list')
            ? data
            : url.endsWith('/directory')
              ? {
                  currentMemberId: data.currentMemberId,
                  members: data.members
                    .filter((member) => !member.disabledAt)
                    .map(({ id, displayName, role }) => ({ id, displayName, role })),
                }
              : url.endsWith('/admin/access')
                ? {
                    signInsTotal: 1,
                    signIns: [
                      {
                        id: 'device-anna',
                        memberId: 'anna',
                        deviceName: 'Anna’s phone',
                        platform: 'iOS',
                        kind: 'mobile',
                        createdAt: '2026-01-01',
                        lastSeenAt: '2026-01-02',
                        expiresAt: '2099-01-01',
                      },
                    ],
                  }
                : url.endsWith('/invite')
                  ? { url: 'https://workspace.example/#invite=new-secret', mailSent: true }
                  : url.endsWith('/recovery')
                    ? { url: 'https://workspace.example/#invite=reset-secret' }
                    : { ok: true },
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
async function openPerson(name = 'Anna') {
  render(<MembersSection />)
  fireEvent.click(await screen.findByRole('button', { name }))
  const flow = frame.openTakeover.mock.calls.at(-1)?.[0]
  expect(flow.title).toBe(name)
  const rendered = render(flow.content)
  return { ...rendered, ui: within(rendered.container) }
}
async function openInvite() {
  render(<MembersSection />)
  fireEvent.click(await screen.findByRole('button', { name: 'Invite' }))
  const flow = frame.openTakeover.mock.calls.at(-1)?.[0]
  expect(flow.title).toBe('Invite someone')
  const rendered = render(flow.content)
  return { ...rendered, ui: within(rendered.container) }
}

beforeEach(() => {
  viewer.status = 'ready'
  viewer.sections = ['people']
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  frame.openTakeover.mockClear()
  frame.closeTakeover.mockClear()
  keys.query.mockClear()
})

test('members read names and roles without requesting admin lists or revealing emails', async () => {
  viewer.sections = []
  const request = mockApi()
  render(<MembersSection />)
  await screen.findByText('Anna')
  expect(screen.queryByText('anna@example.com')).toBeNull()
  expect(screen.queryByText('Beth')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Anna' })).toBeNull()
  expect(screen.queryByText('Pending invites')).toBeNull()
  expect(request.mock.calls.some(([url]) => url.endsWith('/directory'))).toBe(true)
  expect(
    request.mock.calls.some(([url]) => url.endsWith('/list') || url.endsWith('/admin/access')),
  ).toBe(false)
})

test('viewer loading waits before making any privileged request', () => {
  viewer.status = 'loading'
  const request = mockApi()
  render(<MembersSection />)
  expect(screen.getByText('Loading members…')).toBeTruthy()
  expect(request).not.toHaveBeenCalled()
})

test('admin rows open a person page and show device counts and disabled state', async () => {
  mockApi()
  const { ui } = await openPerson()
  expect(await screen.findByText(/anna@example.com · 1 device signed in/)).toBeTruthy()
  expect(screen.getByText('Disabled')).toBeTruthy()
  expect(ui.getByText('Their API keys')).toBeTruthy()
  expect(ui.getByText('Machines they look after')).toBeTruthy()
  expect(ui.getByText('Send a password reset link')).toBeTruthy()
  expect(ui.getByText('Anna’s phone')).toBeTruthy()
})

test('role selection waits for a filled password and confirms through the existing route', async () => {
  const request = mockApi()
  const { ui } = await openPerson()
  fireEvent.click(ui.getByRole('button', { name: 'Admin' }))
  const confirm = ui.getByRole('button', { name: 'Change role' })
  expect(confirm).toHaveProperty('disabled', true)
  fireEvent.click(confirm)
  expect(request.mock.calls.some(([url]) => url.endsWith('/role'))).toBe(false)
  fireEvent.change(ui.getByLabelText('Your password'), { target: { value: 'admin-password' } })
  fireEvent.click(confirm)
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.stringMatching(/\/role$/),
      expect.objectContaining({
        body: JSON.stringify({ id: 'anna', role: 'admin', current: 'admin-password' }),
      }),
    ),
  )
})

test('server refusal stays in the role confirmation beside its password', async () => {
  mockApi({ refusal: { path: '/role', error: 'The last active admin cannot be demoted' } })
  const { ui } = await openPerson()
  fireEvent.click(ui.getByRole('button', { name: 'Admin' }))
  fireEvent.change(ui.getByLabelText('Your password'), { target: { value: 'x' } })
  fireEvent.click(ui.getByRole('button', { name: 'Change role' }))
  const confirmation = ui.getByRole('form', { name: 'Change role' })
  expect((await within(confirmation).findByRole('alert')).textContent).toBe(
    'The last active admin cannot be demoted',
  )
  expect(within(confirmation).getByLabelText('Your password')).toHaveProperty('value', 'x')
})

test.each([
  ['Disable…', 'Confirm disable', '/disable'],
  ['Remove…', 'Confirm removal', '/remove'],
  ['Create link…', 'Create password reset link', '/recovery'],
])('%s requires a password and keeps the request in its person page', async (action, confirm, path) => {
  const request = mockApi()
  const { ui } = await openPerson()
  fireEvent.click(ui.getByRole('button', { name: action }))
  const button = ui.getByRole('button', { name: confirm })
  expect(button).toHaveProperty('disabled', true)
  fireEvent.change(ui.getByLabelText('Your password'), { target: { value: 'password' } })
  expect(button).toHaveProperty('disabled', false)
  fireEvent.click(button)
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.stringMatching(path),
      expect.objectContaining({
        body: JSON.stringify({ id: 'anna', current: 'password' }),
      }),
    ),
  )
})

test('passwordless admins confirm removal without a password field', async () => {
  const request = mockApi({ password: false })
  const { ui } = await openPerson()
  fireEvent.click(ui.getByRole('button', { name: 'Remove…' }))
  expect(ui.queryByLabelText('Your password')).toBeNull()
  fireEvent.click(ui.getByRole('button', { name: 'Confirm removal' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.stringMatching(/\/remove$/),
      expect.objectContaining({
        body: JSON.stringify({ id: 'anna', current: '' }),
      }),
    ),
  )
  expect(frame.closeTakeover).toHaveBeenCalled()
})

test('switching actions clears the previous password and error', async () => {
  mockApi({ refusal: { path: '/remove', error: 'Confirm with your current password' } })
  const { ui } = await openPerson()
  fireEvent.click(ui.getByRole('button', { name: 'Remove…' }))
  fireEvent.change(ui.getByLabelText('Your password'), { target: { value: 'wrong' } })
  fireEvent.click(ui.getByRole('button', { name: 'Confirm removal' }))
  await ui.findByRole('alert')
  fireEvent.click(ui.getByRole('button', { name: 'Disable…' }))
  expect(ui.queryByRole('alert')).toBeNull()
  expect(ui.getByLabelText('Your password')).toHaveProperty('value', '')
  expect(ui.getByRole('button', { name: 'Confirm disable' })).toHaveProperty('disabled', true)
})

test('password reset results stay separate from invitation results', async () => {
  mockApi()
  const { ui } = await openPerson()
  fireEvent.click(ui.getByRole('button', { name: 'Create link…' }))
  fireEvent.change(ui.getByLabelText('Your password'), { target: { value: 'password' } })
  fireEvent.click(ui.getByRole('button', { name: 'Create password reset link' }))
  expect(await ui.findByRole('textbox', { name: 'Password reset link' })).toHaveProperty(
    'value',
    'https://workspace.example/#invite=reset-secret',
  )
  expect(ui.queryByRole('textbox', { name: 'Invite link' })).toBeNull()
})

test('individual devices and sign out everywhere use their existing routes without passwords', async () => {
  const request = mockApi()
  const { ui } = await openPerson()
  fireEvent.click(await ui.findByRole('button', { name: 'Sign out Anna’s phone' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.stringMatching(/admin\/sign-ins\/revoke$/),
      expect.objectContaining({
        body: JSON.stringify({ id: 'device-anna' }),
      }),
    ),
  )
  fireEvent.click(ui.getByRole('button', { name: 'Sign out everywhere' }))
  expect(ui.queryByLabelText('Your password')).toBeNull()
  fireEvent.click(ui.getByRole('button', { name: 'Confirm sign out' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.stringMatching(/sign-out-everywhere$/),
      expect.objectContaining({
        body: JSON.stringify({ id: 'anna' }),
      }),
    ),
  )
})

test('self role and access actions remain unavailable; personal devices point to Account', async () => {
  mockApi()
  const { ui } = await openPerson('Owner')
  expect(ui.queryByRole('button', { name: 'Member' })).toBeNull()
  expect(ui.queryByText('Access', { exact: true })).toBeNull()
  expect(ui.queryByRole('button', { name: 'Sign out everywhere' })).toBeNull()
  expect(ui.getByText('Manage your own devices and sign out in Account.')).toBeTruthy()
})

test('invite flow removes the member picker, creates a link and preserves copy fallback', async () => {
  const request = mockApi()
  const { ui } = await openInvite()
  expect(ui.queryByRole('combobox')).toBeNull()
  expect(ui.queryByLabelText('Email the link')).toBeNull()
  fireEvent.change(ui.getByRole('textbox', { name: 'Email' }), {
    target: { value: 'new@example.com' },
  })
  fireEvent.click(ui.getByRole('button', { name: 'Create invite link' }))
  expect(await ui.findByRole('textbox', { name: 'Invite link' })).toHaveProperty(
    'value',
    'https://workspace.example/#invite=new-secret',
  )
  expect(request).toHaveBeenCalledWith(
    expect.stringMatching(/\/invite$/),
    expect.objectContaining({
      body: JSON.stringify({ email: 'new@example.com', role: 'member', sendEmail: false }),
    }),
  )
  vi.stubGlobal('navigator', { clipboard: undefined })
  fireEvent.click(ui.getByRole('button', { name: 'Copy link' }))
  await ui.findByText('Select the link above and copy it.')
})

test('mail controls are available only when configured and require an address', async () => {
  const request = mockApi({ mail: true })
  const { ui } = await openInvite()
  fireEvent.click(ui.getByRole('switch', { name: 'Email the link' }))
  expect(ui.getByRole('button', { name: 'Create invite link' })).toHaveProperty('disabled', true)
  fireEvent.change(ui.getByRole('textbox', { name: 'Email' }), {
    target: { value: 'new@example.com' },
  })
  fireEvent.click(ui.getByRole('button', { name: 'Create invite link' }))
  await ui.findByText('Invitation emailed.')
  expect(request).toHaveBeenCalledWith(
    expect.stringMatching(/\/invite$/),
    expect.objectContaining({
      body: JSON.stringify({ email: 'new@example.com', role: 'member', sendEmail: true }),
    }),
  )
})

test.each([
  true,
  false,
])('admin invites require a password only when the admin has one (%s)', async (hasPassword) => {
  const request = mockApi({ password: hasPassword })
  const { ui } = await openInvite()
  expect(ui.queryByLabelText('Your password')).toBeNull()
  fireEvent.click(ui.getByRole('button', { name: 'Admin' }))
  const create = ui.getByRole('button', { name: 'Create invite link' })
  expect(create).toHaveProperty('disabled', hasPassword)
  if (hasPassword)
    fireEvent.change(ui.getByLabelText('Your password'), { target: { value: 'invite-password' } })
  else expect(ui.queryByLabelText('Your password')).toBeNull()
  fireEvent.click(create)
  await ui.findByRole('textbox', { name: 'Invite link' })
  expect(request).toHaveBeenCalledWith(
    expect.stringMatching(/\/invite$/),
    expect.objectContaining({
      body: JSON.stringify({
        role: 'admin',
        sendEmail: false,
        current: hasPassword ? 'invite-password' : '',
      }),
    }),
  )
})

test('revoke confirms inline, has no password, and deletes only after confirming', async () => {
  const request = mockApi()
  render(<MembersSection />)
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }))
  expect(request.mock.calls.some(([url]) => url.endsWith('/revoke'))).toBe(false)
  expect(screen.queryByLabelText('Your password')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Revoke invite' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.stringMatching(/\/revoke$/),
      expect.objectContaining({
        body: JSON.stringify({ id: 'inv_pending' }),
      }),
    ),
  )
  await waitFor(() => expect(screen.queryByText('pending@example.com')).toBeNull())
})

test('new link creates the replacement before revoking and keeps the link copyable', async () => {
  const request = mockApi()
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  render(<MembersSection />)
  fireEvent.click(await screen.findByRole('button', { name: 'New link' }))
  fireEvent.click(screen.getByRole('button', { name: 'Create new link' }))
  await waitFor(() => expect(frame.openTakeover).toHaveBeenCalled())
  const calls = request.mock.calls.map(([url]) => url)
  expect(calls.findIndex((url) => url.endsWith('/invite'))).toBeLessThan(
    calls.findIndex((url) => url.endsWith('/revoke')),
  )
  expect(writeText).toHaveBeenCalledWith('https://workspace.example/#invite=new-secret')
  render(frame.openTakeover.mock.calls.at(-1)?.[0].content)
  expect(screen.getByRole('textbox', { name: 'Invite link' })).toHaveProperty(
    'value',
    'https://workspace.example/#invite=new-secret',
  )
})

test('a failed replacement never revokes the old invite', async () => {
  const request = mockApi({ refusal: { path: '/invite', error: 'Invitation refused' } })
  render(<MembersSection />)
  fireEvent.click(await screen.findByRole('button', { name: 'New link' }))
  fireEvent.click(screen.getByRole('button', { name: 'Create new link' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Invitation refused')
  expect(request.mock.calls.some(([url]) => url.endsWith('/revoke'))).toBe(false)
})
