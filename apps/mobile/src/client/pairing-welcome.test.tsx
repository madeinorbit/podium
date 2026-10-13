import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'web' }))
vi.mock('react-native', async (original) => {
  const rn = await original<typeof import('react-native')>()
  return {
    ...rn,
    Platform: {
      get OS() {
        return platform.OS
      },
      select: (values: Record<string, unknown>) => values[platform.OS] ?? values.default,
    },
  }
})
vi.mock('../components/PressableScale', () => ({
  PressableScale: ({ onPress, children, accessibilityLabel }: any) => (
    <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}))
vi.mock('../components/HostedSignInButton', () => ({
  HostedSignInButton: ({ onBegin, variant }: any) => (
    <button type="button" data-variant={variant} onClick={() => onBegin?.()}>
      Continue with Podium Cloud
    </button>
  ),
}))
vi.mock('../components/Icon', () => ({ Icon: () => null }))
vi.mock('../components/AsciiWordmark', () => ({ AsciiWordmark: () => null }))

import { PairingWelcome, WELCOME_TITLE } from './pairing-welcome'

afterEach(() => {
  cleanup()
  platform.OS = 'ios'
})

function mount(overrides: Partial<Parameters<typeof PairingWelcome>[0]> = {}) {
  const props = {
    canCancel: false,
    error: null,
    onCancel: vi.fn(),
    onHostedBegin: vi.fn(),
    onScan: vi.fn(),
    onManual: vi.fn(),
    ...overrides,
  }
  render(<PairingWelcome {...props} />)
  return props
}

it('leads with the own-server paths while Podium Cloud is not available', () => {
  const props = mount()

  expect(screen.getByText(WELCOME_TITLE)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Continue with Podium Cloud' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Scan pairing code' }))
  fireEvent.click(screen.getByRole('button', { name: 'Enter server address' }))
  expect(props.onScan).toHaveBeenCalledTimes(1)
  expect(props.onManual).toHaveBeenCalledTimes(1)
})

it('welcomes a new phone and routes each way in to its own step', () => {
  const props = mount({ cloudAvailable: true })

  expect(screen.getByText(WELCOME_TITLE)).toBeTruthy()
  const cloud = screen.getByRole('button', { name: 'Continue with Podium Cloud' })
  expect(cloud.getAttribute('data-variant')).toBe('primary')

  fireEvent.click(cloud)
  fireEvent.click(screen.getByRole('button', { name: 'Scan pairing code' }))
  fireEvent.click(screen.getByRole('button', { name: 'Enter server address' }))

  expect(props.onHostedBegin).toHaveBeenCalledTimes(1)
  expect(props.onScan).toHaveBeenCalledTimes(1)
  expect(props.onManual).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: 'Cancel server setup' })).toBeNull()
})

it('keeps only the address path on web, where there is no camera or hosted callback', () => {
  platform.OS = 'web'
  const props = mount({ cloudAvailable: true })

  expect(screen.queryByRole('button', { name: 'Continue with Podium Cloud' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Scan pairing code' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Enter server address' }))
  expect(props.onManual).toHaveBeenCalledTimes(1)
})

it('surfaces a failed scan and lets an existing user back out', () => {
  const props = mount({ canCancel: true, error: 'This code has expired. Create a new code.' })

  expect(screen.getByRole('alert').textContent).toBe('This code has expired. Create a new code.')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel server setup' }))
  expect(props.onCancel).toHaveBeenCalledTimes(1)
})
