import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    const onDismiss = vi.fn()
    render(<UpdateDialog view={available} actions={{}} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /later/i }))
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('update-dialog')).toBeNull()
  })

  it('is NOT dismissible when required', () => {
    render(
      <UpdateDialog
        view={{ ...available, state: 'required', reason: 'Your server is behind this app.' }}
        actions={{}}
      />,
    )
    expect(screen.queryByRole('button', { name: /later/i })).toBeNull()
    expect(screen.getByTestId('update-dialog').getAttribute('aria-modal')).toBe('false')
  })

  it('stays in one panel while the phase changes', () => {
    const { rerender } = render(<UpdateDialog view={available} actions={{}} />)
    const panel = screen.getByTestId('update-dialog')
    expect(panel.className).toContain('fixed')
    expect(panel.className).toContain('right-4')
    expect(panel.className).toContain('bottom-4')

    rerender(
      <UpdateDialog
        view={{ state: 'in-progress', version: '0.4.2', done: 1, total: 3 }}
        actions={{}}
      />,
    )
    expect(screen.getByTestId('update-dialog')).toBe(panel)
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
          places: [{ kind: 'server', label: 'Your server', effect: 'will briefly reconnect' }],
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

  it('explains a failed update and exposes its diagnostic on demand', () => {
    render(
      <UpdateDialog
        view={{
          state: 'failed',
          message: 'Podium could not finish the update.',
          guidance: 'Try again, then ask the server operator for help.',
          diagnostic: 'ludovico did not come back',
        }}
        actions={{}}
      />,
    )
    expect(screen.getByText(/could not finish/i)).toBeTruthy()
    expect(screen.getByText(/try again/i)).toBeTruthy()
    expect(screen.getByText(/technical details/i)).toBeTruthy()
    expect(screen.getByText(/ludovico did not come back/)).toBeTruthy()
  })

  it('is dismissible after an update fails', () => {
    const onDismiss = vi.fn()
    render(
      <UpdateDialog
        view={{
          state: 'failed',
          message: 'Podium could not reach the update source.',
          guidance: "Check this server's internet connection, then try again.",
        }}
        actions={{}}
        onDismiss={onDismiss}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('update-dialog')).toBeNull()
  })

  it('retries through the existing server update action while keeping dismiss available', () => {
    const updateServer = vi.fn(() => new Promise<void>(() => {}))

    render(
      <UpdateDialog
        view={{
          state: 'failed',
          message: 'Podium could not reach the update source.',
          guidance: "Check this server's internet connection, then try the update again.",
        }}
        actions={{ updateServer }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(updateServer).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Trying again…' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })
})
