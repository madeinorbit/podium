import '@/test-support/mock-core-store-handle'
import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { DEFAULT_SETTINGS } from '@podium/runtime'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeaturesStateSnapshot } from '@/lib/use-feature'
import { getFeatureStates } from '../../../../../server/src/features'
import { ExperimentalSection } from './experimental'

const state = vi.hoisted(() => {
  const values = new Map<string, string>()
  const listeners = new Set<() => void>()
  return {
    listed: true,
    features: null as FeaturesStateSnapshot | null,
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
  useFeaturesState: () =>
    state.features ?? {
      devMode: true,
      channel: 'stable',
      flags: [
        {
          id: 'mobx-sidebar',
          name: 'Sidebar MobX pilot',
          description: 'Request the sidebar data-layer pilot on this device. Reload to apply.',
          visibility: 'development',
          listed: state.listed,
          // Catalog enablement/config is deliberately NOT the switch's storage.
          enabled: true,
          source: 'config',
          locked: true,
        },
      ],
    },
}))

beforeEach(() => {
  state.values.clear()
  state.listed = true
  state.features = null
  history.replaceState(null, '', '/')
})
afterEach(cleanup)

describe('principal-local MobX pilot preference', () => {
  it('saves on/off immediately to ui-state without changing the running mode or shared settings', () => {
    const patch = vi.fn()
    const props = { settings: DEFAULT_SETTINGS, patch, onReset: vi.fn() }
    const { unmount } = render(<ExperimentalSection {...props} />)
    let toggle = screen.getByRole('switch', { name: 'MobX pilot' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.hasAttribute('disabled')).toBe(false)
    expect(screen.getByText('Saved immediately for your next app load.')).toBeTruthy()
    expect(
      screen.getByText('Use the new data layer for every converted screen. Reload to apply.'),
    ).toBeTruthy()

    fireEvent.click(toggle)
    expect(state.ui.get(MOBX_SIDEBAR_KEY)).toBe('1')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(patch).not.toHaveBeenCalled()

    // Closing/reopening Settings preserves the choice, without reselecting hooks.
    unmount()
    render(<ExperimentalSection {...props} />)
    toggle = screen.getByRole('switch', { name: 'MobX pilot' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(state.ui.get(MOBX_SIDEBAR_KEY)).toBe('0')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
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
    expect(screen.getByRole('switch', { name: 'MobX pilot' }).getAttribute('aria-checked')).toBe(
      'false',
    )
    state.values.set(MOBX_SIDEBAR_KEY, '1')
    rerender(<ExperimentalSection settings={DEFAULT_SETTINGS} patch={vi.fn()} onReset={vi.fn()} />)
    expect(screen.getByRole('switch', { name: 'MobX pilot' }).getAttribute('aria-checked')).toBe(
      'true',
    )
  })

  it('does not expose the control when the catalog entry is unlisted', () => {
    state.listed = false
    render(<ExperimentalSection settings={DEFAULT_SETTINGS} patch={vi.fn()} onReset={vi.fn()} />)
    expect(screen.queryByRole('switch', { name: 'MobX pilot' })).toBeNull()
  })

  it.each([
    ['packaged development with Podium development on', '0.1.1-dev.233+721dd69', true, true],
    ['packaged development with Podium development off', '0.1.1-dev.233+721dd69', false, false],
    ['stable release with Podium development on', '0.1.1', true, false],
  ] as const)('lists the local opt-in for %s', (_name, version, development, listed) => {
    const settings = { ...DEFAULT_SETTINGS, experimental: { 'podium-development': development } }
    // Use the real server resolution, including the packaged version and channel,
    // so a correct local switch cannot hide a broken catalog-listing rule.
    state.features = getFeatureStates(
      settings,
      { updateChannel: 'dev' },
      { PODIUM_APP_VERSION: version },
    )
    expect(state.features.devMode).toBe(false)
    const patch = vi.fn()
    render(<ExperimentalSection settings={settings} patch={patch} onReset={vi.fn()} />)
    const toggle = screen.queryByRole('switch', { name: 'MobX pilot' })
    if (listed) {
      expect(toggle).not.toBeNull()
      expect(toggle?.getAttribute('aria-checked')).toBe('false')
      expect(screen.getByText('Saved immediately for your next app load.')).toBeTruthy()
    } else {
      expect(toggle).toBeNull()
    }
    expect(state.ui.get(MOBX_SIDEBAR_KEY)).toBeNull()
    expect(patch).not.toHaveBeenCalled()
  })
})
