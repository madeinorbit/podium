import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileShellProvider } from '../client/shell'

afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(),
}))

const { StorageNoticeAlert } = await import('./StorageNoticeAlert')

describe('StorageNoticeAlert', () => {
  it('announces the degradation and lets the operator dismiss it', () => {
    const dismiss = vi.fn()
    render(
      <MobileShellProvider
        value={{
          error: null,
          notice: { message: 'Offline changes may not survive a restart.', dismiss },
          eraseLocalData: async () => {},
        }}
      >
        <StorageNoticeAlert />
      </MobileShellProvider>,
    )

    expect(screen.getByRole('alert').textContent).toContain('Offline changes may not survive')
    fireEvent.click(screen.getByLabelText('Dismiss offline storage alert'))
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('an info-tone notice reads as a status, not a failure: neutral surface, plain words (POD-4002)', () => {
    render(
      <MobileShellProvider
        value={{
          error: null,
          notice: {
            message: 'Refreshing your data after the upgrade — this happens once.',
            tone: 'info',
            dismiss: () => {},
          },
          eraseLocalData: async () => {},
        }}
      >
        <StorageNoticeAlert />
      </MobileShellProvider>,
    )

    const banner = screen.getByRole('alert')
    expect(banner.textContent).toContain('Refreshing your data after the upgrade')
    expect(banner.textContent).not.toMatch(/discarded|identit/)
    expect(screen.getByTestId('storage-notice-info')).toBe(banner)
    expect(screen.queryByTestId('storage-notice-alert')).toBeNull()
  })

  it('renders nothing when storage has not degraded', () => {
    render(
      <MobileShellProvider value={{ error: null, notice: null, eraseLocalData: async () => {} }}>
        <StorageNoticeAlert />
      </MobileShellProvider>,
    )

    expect(screen.queryByRole('alert')).toBeNull()
  })
})
