import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateDialog } from './UpdateDialog'

afterEach(cleanup)

const available = {
  state: 'available' as const,
  version: '0.4.2',
  places: [
    { kind: 'this-app' as const, label: 'This app', effect: 'will restart, about 5 seconds' },
    { kind: 'server' as const, label: 'Your server (ludovico)', effect: 'will briefly reconnect' },
  ],
  restartNote: 'Your sessions keep running. Everything will be where you left it.',
}

describe('UpdateDialog', () => {
  it('renders nothing in the none state', () => {
    const { container } = render(<UpdateDialog view={{ state: 'none' }} actions={{}} />)
    expect(container.innerHTML).toBe('')
  })

  it('leads with the version, as one Podium', () => {
    render(<UpdateDialog view={available} actions={{}} />)
    expect(screen.getByText(/Podium 0\.4\.2 is available/i)).toBeTruthy()
  })

  it('lists every place with its effect', () => {
    render(<UpdateDialog view={available} actions={{}} />)
    expect(screen.getByText(/This app/)).toBeTruthy()
    expect(screen.getByText(/will restart, about 5 seconds/)).toBeTruthy()
    expect(screen.getByText(/Your server \(ludovico\)/)).toBeTruthy()
  })

  it('is dismissible when available', () => {
    render(<UpdateDialog view={available} actions={{}} />)
    expect(screen.getByRole('button', { name: /later/i })).toBeTruthy()
  })

  it('is NOT dismissible when required', () => {
    render(
      <UpdateDialog
        view={{ ...available, state: 'required', reason: 'Your server is behind this app.' }}
        actions={{}}
      />,
    )
    expect(screen.queryByRole('button', { name: /later/i })).toBeNull()
  })

  it('shows the reason on a required update', () => {
    render(
      <UpdateDialog
        view={{ ...available, state: 'required', reason: 'Your server is behind this app.' }}
        actions={{}}
      />,
    )
    expect(screen.getByText(/Your server is behind this app/)).toBeTruthy()
  })

  it('offers What is new only when notes exist', () => {
    render(<UpdateDialog view={available} actions={{}} />)
    expect(screen.queryByRole('link', { name: /what's new/i })).toBeNull()
    render(
      <UpdateDialog
        view={{ ...available, notes: { url: 'https://x.test/CHANGELOG.md' } }}
        actions={{}}
      />,
    )
    expect(screen.getByRole('link', { name: /what's new/i })).toBeTruthy()
  })

  it('does not offer an action whose backend is absent on this surface', () => {
    render(<UpdateDialog view={available} actions={{ reload: vi.fn() }} />)
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull()
  })

  it('does not render reload when the app place is absent', () => {
    render(
      <UpdateDialog
        view={{
          ...available,
          places: [
            { kind: 'server', label: 'Your server', effect: 'will briefly reconnect' },
          ],
        }}
        actions={{ reload: vi.fn() }}
      />,
    )
    expect(screen.queryByRole('button', { name: /reload/i })).toBeNull()
  })

  it('runs the action it does offer', async () => {
    const updateServer = vi.fn()
    render(<UpdateDialog view={available} actions={{ updateServer }} />)
    screen.getByRole('button', { name: /update/i }).click()
    expect(updateServer).toHaveBeenCalled()
  })

  it('shows wave progress in the in-progress state', () => {
    render(
      <UpdateDialog
        view={{ state: 'in-progress', version: '0.4.2', done: 1, total: 3 }}
        actions={{}}
      />,
    )
    expect(screen.getByText(/1 of 3/)).toBeTruthy()
  })

  it('shows the detail in the failed state', () => {
    render(
      <UpdateDialog
        view={{ state: 'failed', detail: 'ludovico did not come back' }}
        actions={{}}
      />,
    )
    expect(screen.getByText(/ludovico did not come back/)).toBeTruthy()
  })
})
