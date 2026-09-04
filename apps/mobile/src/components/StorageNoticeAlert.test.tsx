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

  it('renders nothing when storage has not degraded', () => {
    render(
      <MobileShellProvider value={{ error: null, notice: null, eraseLocalData: async () => {} }}>
        <StorageNoticeAlert />
      </MobileShellProvider>,
    )

    expect(screen.queryByRole('alert')).toBeNull()
  })
})
