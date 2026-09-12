import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { HostedWorkspaceSwitcher } from './HostedWorkspaceSwitcher'
vi.mock('./trpc', () => ({ serverConfig: () => ({ httpOrigin: 'https://api.podium.do' }) }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
})
function open() {
  const summary = screen.getByLabelText('Switch workspace')
  const details = summary.parentElement as HTMLDetailsElement
  details.open = true
  fireEvent(details, new Event('toggle'))
  return details
}
it('lists both workspaces and refreshes pending status when reopened', async () => {
  history.replaceState(null, '', '/w/first/issues')
  const rows = [
    { id: 'one', slug: 'first', status: 'running' },
    { id: 'two', slug: 'second', status: 'pending' },
  ]
  const fetcher = vi.fn().mockImplementation(async () => Response.json(rows))
  vi.stubGlobal('fetch', fetcher)
  render(<HostedWorkspaceSwitcher />)
  expect(fetcher).not.toHaveBeenCalled()
  const details = open()
  expect((await screen.findByRole('link', { name: 'first' })).getAttribute('href')).toBe('/w/first')
  expect(screen.getByText('second · Awaiting provisioning')).toBeTruthy()
  expect(screen.queryByRole('link', { name: 'second' })).toBeNull()
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.podium.do/platform/workspaces',
    expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
  )
  details.open = false
  fireEvent(details, new Event('toggle'))
  rows[1]!.status = 'running'
  open()
  expect((await screen.findByRole('link', { name: 'second' })).getAttribute('href')).toBe(
    '/w/second',
  )
})
it('does not contact the platform or show controls on an unprefixed local server', () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  render(<HostedWorkspaceSwitcher />)
  expect(screen.queryByLabelText('Switch workspace')).toBeNull()
  expect(fetcher).not.toHaveBeenCalled()
})
it('shows a recoverable error for failed list requests', async () => {
  history.replaceState(null, '', '/w/first')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
  render(<HostedWorkspaceSwitcher />)
  open()
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Reopen to retry'))
})
