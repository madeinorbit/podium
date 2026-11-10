import { DEFAULT_SETTINGS } from '@podium/runtime'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureStates } from '@/lib/use-feature'
import { getFeatureStates } from '../../../../../server/src/features'
import { LabsSection } from './labs'
import { SettingsControlsContext } from './shared'

const state = vi.hoisted(() => ({ features: null as FeatureStates | null }))

vi.mock('@/lib/use-feature', () => ({
  useFeaturesState: () =>
    state.features ?? {
      devMode: false,
      channel: 'stable',
      flags: [
        {
          id: 'runtime-drivers',
          name: 'Headless agents',
          description: 'Run some agents without a terminal.',
          visibility: 'stable',
          listed: true,
          enabled: false,
          source: 'default',
          locked: false,
        },
      ],
    },
}))

beforeEach(() => {
  state.features = null
})
afterEach(cleanup)

describe('LabsSection', () => {
  it.each([
    ['packaged development with Podium development on', '0.1.1-dev.233+721dd69', true],
    ['packaged development with Podium development off', '0.1.1-dev.233+721dd69', false],
    ['stable release with Podium development on', '0.1.1', true],
  ] as const)('omits the retired reader pilot for %s', (_name, version, development) => {
    const settings = { ...DEFAULT_SETTINGS, experimental: { 'podium-development': development } }
    state.features = getFeatureStates(
      settings,
      { updateChannel: 'dev' },
      { PODIUM_APP_VERSION: version },
    )
    const patch = vi.fn()
    render(<LabsSection settings={settings} patch={patch} />)
    expect(state.features.devMode).toBe(false)
    expect(state.features.flags.some((flag) => flag.id === 'mobx-sidebar')).toBe(false)
    expect(screen.queryByText('MobX pilot')).toBeNull()
    expect(screen.queryByText('Saved immediately for your next app load.')).toBeNull()
    expect(screen.getAllByRole('switch')).toHaveLength(
      state.features.flags.filter((flag) => flag.listed && flag.visibility !== 'hidden').length,
    )
    expect(patch).not.toHaveBeenCalled()
  })

  it('omits the retired Queues control even when its saved preference is enabled', () => {
    const settings = { ...DEFAULT_SETTINGS, experimental: { 'merge-queue': true } }
    state.features = getFeatureStates(settings, { updateChannel: 'edge' }, {})
    render(<LabsSection settings={settings} patch={vi.fn()} />)
    expect(state.features.flags.some((flag) => flag.id === 'merge-queue')).toBe(false)
    expect(screen.queryByText('Queues')).toBeNull()
  })

  it('presents the stable runtime-driver control off and patches its durable feature key', () => {
    const patch = vi.fn()
    render(<LabsSection settings={DEFAULT_SETTINGS} patch={patch} />)

    expect(screen.getByText('Headless agents')).toBeTruthy()
    expect(screen.getByText('Run some agents without a terminal.')).toBeTruthy()

    const row = screen.getByText('Headless agents').closest<HTMLDivElement>('.settings-row')
    expect(row).not.toBeNull()
    const toggle = within(row!).getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)

    expect(patch).toHaveBeenCalledWith({ experimental: { 'runtime-drivers': true } })
  })

  it.each([true, false])('keeps a config-forced %s value locked', (enabled) => {
    state.features = getFeatureStates(
      DEFAULT_SETTINGS,
      { features: { 'runtime-drivers': enabled } },
      { PODIUM_APP_VERSION: '0.1.1' },
    )
    const patch = vi.fn()
    render(<LabsSection settings={DEFAULT_SETTINGS} patch={patch} />)

    const toggle = screen.getByRole('switch', { name: 'Headless agents' })
    expect(toggle.getAttribute('aria-checked')).toBe(String(enabled))
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Set by config file')).toBeTruthy()
    fireEvent.click(toggle)
    expect(patch).not.toHaveBeenCalled()
  })

  it('shows resolved values without controls when the instance write is denied', () => {
    const settings = { ...DEFAULT_SETTINGS, experimental: { 'runtime-drivers': true } }
    state.features = getFeatureStates(settings, {}, { PODIUM_APP_VERSION: '0.1.1' })
    const patch = vi.fn()
    render(
      <SettingsControlsContext.Provider
        value={{ settings, permitted: { 'records.instancePreferences.edit': false } }}
      >
        <LabsSection settings={settings} patch={patch} />
      </SettingsControlsContext.Provider>,
    )

    const row = screen.getByText('Headless agents').closest<HTMLDivElement>('.settings-row')
    expect(row?.dataset.readonly).toBe('true')
    expect(within(row!).getByText('On')).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(patch).not.toHaveBeenCalled()
  })

  it('omits hidden Shipwright even in dev mode and keeps the dev-only badge', () => {
    state.features = getFeatureStates(DEFAULT_SETTINGS, {}, { PODIUM_APP_VERSION: 'dev' })
    render(<LabsSection settings={DEFAULT_SETTINGS} patch={vi.fn()} />)

    expect(state.features.flags.find((flag) => flag.id === 'shipwright')?.listed).toBe(true)
    expect(screen.queryByText('Shipwright')).toBeNull()
    const workflows = screen.getByText('Workflows').closest<HTMLDivElement>('.settings-row')
    expect(within(workflows!).getByText('Dev')).toBeTruthy()
  })
})
