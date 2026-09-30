import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { DEFAULT_SETTINGS } from '@podium/runtime'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeSidebarDataLayer, sidebarDataLayer } from '@/lib/sidebar-data-layer'
import { ExperimentalSection } from './experimental'

const state = vi.hoisted(() => {
  const values = new Map<string, string>()
  const listeners = new Set<() => void>()
  return {
    listed: true,
    ui: {
      get: (key: string) => values.get(key) ?? null,
      set: (key: string, value: string | null) => {
        if (value === null) values.delete(key)
        else values.set(key, value)
        for (const cb of listeners) cb()
      },
      subscribe: (cb: () => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    },
    values,
  }
})

vi.mock('@/app/store', () => ({
  useStoreSelector: (select: (store: { uiState: typeof state.ui }) => unknown) =>
    select({ uiState: state.ui }),
}))
vi.mock('@/lib/use-feature', () => ({
  useFeaturesState: () => ({
    devMode: true,
    channel: 'stable',
    flags: [{
      id: 'mobx-sidebar', name: 'Sidebar MobX pilot',
      description: 'Request the sidebar data-layer pilot on this device. Reload to apply.',
      visibility: 'hidden', listed: state.listed,
      // Catalog enablement/config is deliberately NOT the switch's storage.
      enabled: true, source: 'config', locked: true,
    }],
  }),
}))

beforeEach(() => {
  state.values.clear()
  state.listed = true
  history.replaceState(null, '', '/')
})
afterEach(cleanup)

describe('principal-local sidebar pilot preference', () => {
  it('saves on/off immediately to ui-state without changing the running mode or shared settings', () => {
    initializeSidebarDataLayer(state.ui)
    const patch = vi.fn()
    const props = { settings: DEFAULT_SETTINGS, patch, onReset: vi.fn() }
    const { unmount } = render(<ExperimentalSection {...props} />)
    let toggle = screen.getByRole('switch', { name: 'Sidebar MobX pilot' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.hasAttribute('disabled')).toBe(false)
    expect(screen.getByText('Saved immediately for your next app load.')).toBeTruthy()

    fireEvent.click(toggle)
    expect(state.ui.get(MOBX_SIDEBAR_KEY)).toBe('1')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    initializeSidebarDataLayer(state.ui)
    expect(sidebarDataLayer()).toBe('legacy')
    expect(patch).not.toHaveBeenCalled()

    // Closing/reopening Settings preserves the choice, without reselecting hooks.
    unmount()
    render(<ExperimentalSection {...props} />)
    toggle = screen.getByRole('switch', { name: 'Sidebar MobX pilot' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(state.ui.get(MOBX_SIDEBAR_KEY)).toBe('0')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(sidebarDataLayer()).toBe('legacy')
    expect(patch).not.toHaveBeenCalled()
  })

  it('uses the principal preference rather than the URL request or shared experimental value', () => {
    history.replaceState(null, '', '/?mobxSidebar=1')
    const { rerender } = render(
      <ExperimentalSection
        settings={{ ...DEFAULT_SETTINGS, experimental: { 'mobx-sidebar': true } }}
        patch={vi.fn()}
        onReset={vi.fn()}
      />,
    )
    expect(screen.getByRole('switch', { name: 'Sidebar MobX pilot' }).getAttribute('aria-checked')).toBe('false')
    state.values.set(MOBX_SIDEBAR_KEY, '1')
    rerender(<ExperimentalSection settings={DEFAULT_SETTINGS} patch={vi.fn()} onReset={vi.fn()} />)
    expect(screen.getByRole('switch', { name: 'Sidebar MobX pilot' }).getAttribute('aria-checked')).toBe('true')
  })

  it('does not expose the control when the hidden catalog entry is unlisted', () => {
    state.listed = false
    render(<ExperimentalSection settings={DEFAULT_SETTINGS} patch={vi.fn()} onReset={vi.fn()} />)
    expect(screen.queryByRole('switch', { name: 'Sidebar MobX pilot' })).toBeNull()
  })
})
