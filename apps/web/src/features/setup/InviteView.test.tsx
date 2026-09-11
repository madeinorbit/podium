import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { InviteView } from './InviteView'
import { LoginGate } from './LoginGate'
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})
test('accepts an invite before the login gate and submits its bound email and password', async () => {
  window.history.replaceState(null, '', '/#invite=secret')
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ email: 'anna@example.com' }) })
    .mockResolvedValue({ ok: true, json: async () => ({ userId: 'mem_anna' }) })
  vi.stubGlobal('fetch', fetchMock)
  render(
    <LoginGate>
      <div>Workspace</div>
    </LoginGate>,
  )
  expect(await screen.findByLabelText('Email')).toHaveProperty('readOnly', true)
  expect(screen.queryByText('Workspace')).toBeNull()
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Anna' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } })
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'password123' } })
  fireEvent.click(screen.getByRole('button', { name: 'Join workspace' }))
  expect(await screen.findByText('You’re a member')).toBeTruthy()
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
    token: 'secret',
    email: 'anna@example.com',
    password: 'password123',
    displayName: 'Anna',
  })
  expect(fetchMock.mock.calls[1]![1].credentials).toBe('include')
  expect(fetchMock.mock.calls[0]![0]).toMatch(/\/inspect$/)
})
test('invalid invites cannot submit; password confirmation catches mistakes', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Expired' }) }),
  )
  const onDone = vi.fn()
  const result = render(<InviteView token="bad" httpOrigin="" onDone={onDone} />)
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'This invite has expired, was revoked, or has already been used.',
  )
  expect(screen.queryByRole('button', { name: 'Join workspace' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Go to sign in' }))
  expect(onDone).toHaveBeenCalledOnce()
  result.unmount()
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ email: null }) })
  vi.stubGlobal('fetch', fetchMock)
  render(<InviteView token="valid" httpOrigin="" onDone={vi.fn()} />)
  await screen.findByLabelText('Name')
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Anna' } })
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'anna@example.com' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } })
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'different' } })
  fireEvent.click(screen.getByRole('button', { name: 'Join workspace' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('match'))
  expect(fetchMock).toHaveBeenCalledOnce()
})
