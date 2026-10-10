import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TopBar } from './TopBar'

vi.mock('./header-data', () => ({
  useHeaderPolling: () => {},
  useHeaderView: () => 'workspace',
  useHeaderActions: () => ({ setView: vi.fn() }),
}))
vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))
vi.mock('@/features/machines/HostIndicators', () => ({ HeaderHostIndicators: () => null }))
vi.mock('./HostedWorkspaceSwitcher', () => ({ HostedWorkspaceSwitcher: () => null }))

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('workspace header', () => {
  it.each([true, false])('omits the retired pilot badge (development=%s)', (development) => {
    vi.stubEnv('DEV', development)
    const { rerender } = render(<TopBar />)
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy()
    expect(screen.queryByTestId('sidebar-pilot-badge')).toBeNull()
    rerender(<TopBar chromeless />)
    expect(screen.getByTestId('desktop-topbar').getAttribute('data-chromeless')).toBe('true')
    expect(screen.queryByTestId('sidebar-pilot-badge')).toBeNull()
  })
})
