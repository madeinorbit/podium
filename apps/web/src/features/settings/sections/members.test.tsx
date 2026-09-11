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
}
function mockApi(mailAvailable = false) {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith('/list')
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
  fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }))
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/remove$/),
      expect.objectContaining({ body: JSON.stringify({ id: 'anna' }) }),
    ),
  )
})
