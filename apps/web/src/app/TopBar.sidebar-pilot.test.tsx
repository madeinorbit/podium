import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TopBar } from './TopBar'

vi.mock('./store', () => ({
  useStoreSelector: (select: (store: unknown) => unknown) =>
    select({ view: 'workspace', setView: vi.fn() }),
}))
vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))
vi.mock('@/features/machines/HostIndicators', () => ({ HeaderHostIndicators: () => null }))
vi.mock('./HostedWorkspaceSwitcher', () => ({ HostedWorkspaceSwitcher: () => null }))
vi.mock('./ToolbarSlot', () => ({
  useToolbarSlotFilled: () => false,
  ToolbarSlotTarget: () => null,
}))
vi.mock('@/lib/nativeDesktop', () => ({ nativeDesktopBridge: () => null }))

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('sidebar startup badge', () => {
  it('shows off or the honest pending pool request in a development header', () => {
    vi.stubEnv('DEV', true)
    const { rerender } = render(<TopBar sidebarLayer="legacy" />)
    const badge = screen.getByTestId('sidebar-pilot-badge')
    expect(badge.textContent).toBe('sidebar MobX off')
    expect(badge.getAttribute('data-sidebar-data-layer')).toBe('legacy')
    rerender(<TopBar sidebarLayer="pool" />)
    expect(badge.textContent).toBe('pool requested, not built yet')
    expect(badge.getAttribute('data-sidebar-data-layer')).toBe('pool')
  })

  it('omits the badge in release builds and chromeless setup', () => {
    vi.stubEnv('DEV', false)
    const { rerender } = render(<TopBar sidebarLayer="pool" />)
    expect(screen.queryByTestId('sidebar-pilot-badge')).toBeNull()
    vi.stubEnv('DEV', true)
    rerender(<TopBar chromeless sidebarLayer="pool" />)
    expect(screen.queryByTestId('sidebar-pilot-badge')).toBeNull()
  })
})
