import { CIDR_RANGE_MESSAGE } from '@podium/model/browser'
import { DEFAULT_SETTINGS } from '@podium/runtime'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TrustedNetworksSection } from './trusted-networks'

afterEach(cleanup)

const withNetworks = (trustedNetworks: string[]) => ({
  ...DEFAULT_SETTINGS,
  daemonLink: { trustedNetworks },
})

test('lists the trusted ranges and removes one', () => {
  const patch = vi.fn()
  render(
    <TrustedNetworksSection settings={withNetworks(['10.1.0.0/16', 'fd00::/8'])} patch={patch} />,
  )
  expect(screen.getByText('10.1.0.0/16')).toBeTruthy()
  expect(screen.getByText('fd00::/8')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Remove 10.1.0.0/16' }))
  expect(patch).toHaveBeenCalledWith({ daemonLink: { trustedNetworks: ['fd00::/8'] } })
})

test('adds a range, and refuses one that is not a range without writing', () => {
  const patch = vi.fn()
  render(<TrustedNetworksSection settings={withNetworks(['10.1.0.0/16'])} patch={patch} />)
  const field = screen.getByRole('textbox', { name: 'Network range' })

  fireEvent.change(field, { target: { value: '10.0.0.0' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  expect(patch).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toBe(CIDR_RANGE_MESSAGE)

  fireEvent.change(field, { target: { value: ' 100.64.0.0/10 ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  expect(patch).toHaveBeenCalledWith({
    daemonLink: { trustedNetworks: ['10.1.0.0/16', '100.64.0.0/10'] },
  })
  expect(screen.queryByRole('alert')).toBeNull()
})

test('says what the setting is for and when unencrypted connections stop', () => {
  render(<TrustedNetworksSection settings={withNetworks([])} patch={vi.fn()} />)
  expect(screen.getByText(/encrypted \(wss\) connection/)).toBeTruthy()
  expect(screen.getByText(/after February 2027/)).toBeTruthy()
})
