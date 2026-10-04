import { DEFAULT_SETTINGS } from '@podium/runtime'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeaturesStateSnapshot } from '@/lib/use-feature'
import { getFeatureStates } from '../../../../../server/src/features'
import { ExperimentalSection } from './experimental'

const state = vi.hoisted(() => ({ features: null as FeaturesStateSnapshot | null }))

vi.mock('@/lib/use-feature', () => ({
  useFeaturesState: () => state.features ?? ({
    devMode: false,
    channel: 'stable',
    flags: [
      {
        id: 'merge-queue',
        name: 'Queues',
        description: 'Show merge and heavy-test queues in the right sidebar.',
        visibility: 'edge',
        listed: true,
        enabled: false,
        source: 'default',
        locked: false,
      },
      {
        id: 'runtime-drivers',
        name: 'Headless session drivers',
        description:
          'Route headed sessions through the driver contract by default, keep legacy PTY available, and offer available headless runtime drivers when starting a session.',
        visibility: 'stable',
        listed: true,
        enabled: false,
        source: 'default',
        locked: false,
      },
    ],
  }),
}))

beforeEach(() => { state.features = null })
afterEach(cleanup)

describe('ExperimentalSection', () => {
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
    render(<ExperimentalSection settings={settings} patch={patch} onReset={vi.fn()} />)
    expect(state.features.devMode).toBe(false)
    expect(state.features.flags.some((flag) => flag.id === 'mobx-sidebar')).toBe(false)
    expect(screen.queryByText('MobX pilot')).toBeNull()
    expect(screen.queryByText('Saved immediately for your next app load.')).toBeNull()
    expect(screen.getAllByRole('switch')).toHaveLength(
      state.features.flags.filter((flag) => flag.listed).length,
    )
    expect(patch).not.toHaveBeenCalled()
  })

  it('presents the queue control and patches its durable feature key', () => {
    const patch = vi.fn()
    render(<ExperimentalSection settings={DEFAULT_SETTINGS} patch={patch} onReset={vi.fn()} />)

    const name = screen.getByText('Queues')
    expect(screen.getByText('Show merge and heavy-test queues in the right sidebar.')).toBeTruthy()

    const row = name.closest<HTMLDivElement>('.settings-row')
    expect(row).not.toBeNull()
    const toggle = within(row!).getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)

    expect(patch).toHaveBeenCalledWith({ experimental: { 'merge-queue': true } })
  })

  it('presents the stable runtime-driver control off and patches its durable feature key', () => {
    const patch = vi.fn()
    render(<ExperimentalSection settings={DEFAULT_SETTINGS} patch={patch} onReset={vi.fn()} />)

    expect(screen.getByText('Headless session drivers')).toBeTruthy()
    expect(
      screen.getByText(
        'Route headed sessions through the driver contract by default, keep legacy PTY available, and offer available headless runtime drivers when starting a session.',
      ),
    ).toBeTruthy()

    const row = screen.getByText('Headless session drivers').closest<HTMLDivElement>('.settings-row')
    expect(row).not.toBeNull()
    const toggle = within(row!).getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)

    expect(patch).toHaveBeenCalledWith({ experimental: { 'runtime-drivers': true } })
  })
})
