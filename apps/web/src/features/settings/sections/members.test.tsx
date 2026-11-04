import '@/test-support/mock-request-pool.test.fixture'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { MembersSection } from './members'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const data = {
  currentMemberId: 'admin',
  mailAvailable: false,
  members: [
    { id: 'admin', displayName: 'Owner', email: null, role: 'admin' },
    { id: 'anna', displayName: 'Anna', email: 'anna@example.com', role: 'member' },
  ],
  invites: [
    {
      id: 'inv_pending',
      email: 'pending@example.com',
      role: 'member',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  ],
  // The server's allowed actions per member (POD-6299).
  actions: {
    admin: ['signOutEverywhere'],
    anna: ['setRole', 'disable', 'remove', 'recovery', 'signOutEverywhere'],
  },
}
function mockApi(mailAvailable = false, refuse?: { path: string; status: number; error: string }) {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: !(refuse && url.endsWith(refuse.path)),
    status: refuse && url.endsWith(refuse.path) ? refuse.status : 200,
    json: async () =>
      refuse && url.endsWith(refuse.path)
        ? { error: refuse.error }
        : url.endsWith('/list')
          ? { ...data, mailAvailable }
          : url.endsWith('/invite')
            ? { url: 'https://workspace/#invite=secret', mailSent: true }
            : { ok: true },
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
test('lists members and pending invites, creates a link and revokes an invite', async () => {
  const fetchMock = mockApi()
  render(<MembersSection />)
  await screen.findByText('Owner', { selector: 'strong' })
  expect(screen.queryByText('Send by email')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Remove Owner' })).toBeNull()
  fireEvent.change(screen.getByLabelText('Email (optional)'), {
    target: { value: 'new@example.com' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))
  expect(await screen.findByLabelText('Invite link')).toHaveProperty(
    'value',
    'https://workspace/#invite=secret',
  )
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringMatching(/\/invite$/),
    expect.objectContaining({
      body: JSON.stringify({ email: 'new@example.com', role: 'member', sendEmail: false }),
    }),
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Revoke invite' })).toHaveProperty('disabled', false),
  )
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
  await screen.findByText('Link copied.')
  expect(writeText).toHaveBeenCalledWith('https://workspace/#invite=secret')
  vi.stubGlobal('navigator', { clipboard: undefined })
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
  await screen.findByText('Select the link above and copy it.')
  fireEvent.click(screen.getByRole('button', { name: 'Revoke invite' }))
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/revoke$/),
      expect.objectContaining({ body: JSON.stringify({ id: 'inv_pending' }) }),
    ),
  )
})
test('invites an existing member by mail and requires confirmation to remove', async () => {
  const fetchMock = mockApi(true)
  render(<MembersSection />)
  await screen.findByText('Owner', { selector: 'strong' })
  fireEvent.change(screen.getByLabelText('Member'), { target: { value: 'anna' } })
  expect(screen.getByLabelText('Email (optional)')).toHaveProperty('value', 'anna@example.com')
  fireEvent.click(screen.getByLabelText('Send by email'))
  fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))
  await screen.findByLabelText('Invite link')
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringMatching(/\/invite$/),
    expect.objectContaining({
      body: JSON.stringify({
        memberId: 'anna',
        email: 'anna@example.com',
        role: 'member',
        sendEmail: true,
      }),
    }),
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Remove Anna' })).toHaveProperty('disabled', false),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Remove Anna' }))
  expect(screen.getByRole('alertdialog')).toBeTruthy()
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/remove'))).toHaveLength(0)
  // The admin confirms with their own password (POD-6298).
  fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'admin-password' } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }))
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/remove$/),
      expect.objectContaining({ body: JSON.stringify({ id: 'anna', current: 'admin-password' }) }),
    ),
  )
})

test('offers only the actions the server allows, and changes a role with the admin’s password', async () => {
  const fetchMock = mockApi()
  render(<MembersSection />)
  await screen.findByText('Anna', { selector: 'strong' })
  // The admin's own row offers only signing out everywhere.
  expect(screen.queryByRole('button', { name: 'Make member' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Sign me out everywhere' })).toBeTruthy()
  for (const name of [
    'Make admin',
    'Disable',
    'Recovery link',
    'Sign out everywhere',
    'Remove Anna',
  ])
    expect(screen.getByRole('button', { name })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Make admin' }))
  expect(screen.getByRole('alertdialog', { name: 'Change role' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'admin-password' } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm role change' }))
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/auth\/members\/role$/),
      expect.objectContaining({
        body: JSON.stringify({ id: 'anna', role: 'admin', current: 'admin-password' }),
      }),
    ),
  )
})

test('signs a member out everywhere without a password', async () => {
  const fetchMock = mockApi()
  render(<MembersSection />)
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }))
  expect(screen.queryByLabelText('Your password')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm sign out' }))
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/auth\/members\/sign-out-everywhere$/),
      expect.objectContaining({ body: JSON.stringify({ id: 'anna' }) }),
    ),
  )
})

test('shows the server’s refusal of a role change', async () => {
  mockApi(false, {
    path: '/role',
    status: 409,
    error: 'The last active admin cannot be demoted',
  })
  render(<MembersSection />)
  fireEvent.click(await screen.findByRole('button', { name: 'Make admin' }))
  fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'x' } })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm role change' }))
  expect((await screen.findByRole('alert')).textContent).toBe(
    'The last active admin cannot be demoted',
  )
  // The confirmation stays open so the admin can see what was refused.
  expect(screen.getByRole('alertdialog', { name: 'Change role' })).toBeTruthy()
})
