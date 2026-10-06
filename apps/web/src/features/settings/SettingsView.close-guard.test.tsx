import '@/test-support/mock-core-store-handle'
import type { ReferenceState } from '../../../../../tests/worklist/diagnostics/reference-state'
import { normalizeSettings } from '@podium/runtime'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Store = ReferenceState<import('@/app/trpc').Trpc>

/**
 * CLOSING SETTINGS WITH UNSAVED EDITS (POD-365).
 *
 * Escape and a backdrop click are each one stray input away at all times, and
 * both used to throw a half-finished settings edit away without a word. The
 * guard is the only thing standing between an accidental keypress and lost
 * work, and it lives at a seam — AppSheet owns the Escape key, SettingsView owns
 * the dirty state — which is exactly the kind of wiring a refactor quietly
 * severs. Hence a test at the seam rather than on the boolean.
 */
const storeState = {
  trpc: {} as Store['trpc'],
  settingsTab: 'sessions',
  setSettingsTab: vi.fn(),
  hostMetrics: undefined,
}
const demand = vi.hoisted(() => ({
  metrics: vi.fn(() => []),
  idleCap: vi.fn(() => 3),
}))

vi.mock('@/app/store', () => ({
  useHostMetrics: demand.metrics,
  useRuntimeSelector: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))
vi.mock('@/app/header-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/header-data')>()),
  usePoolIdleCapUnmetCount: demand.idleCap,
}))
vi.mock('./readers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./readers')>()),
  useSettingsTab: () => storeState.settingsTab,
}))
vi.mock('@/lib/use-feature', () => ({
  useFeature: () => false,
  invalidateFeatures: vi.fn(),
}))
vi.mock('@/lib/use-model-catalog', () => ({ useModelCatalog: () => ({}) }))
vi.mock('@/lib/use-harness-descriptors', () => ({
  useHarnessDescriptors: () => ({ served: undefined, status: 'unavailable' as const }),
}))

import { SettingsView } from './SettingsView'

const onClose = vi.fn()

beforeEach(() => {
  demand.metrics.mockClear()
  demand.idleCap.mockClear()
  onClose.mockClear()
  storeState.settingsTab = 'sessions'
  const settings = normalizeSettings({})
  storeState.trpc = {
    settings: {
      get: { query: vi.fn().mockResolvedValue(settings) },
      viewer: { query: vi.fn().mockResolvedValue({ permitted: {} }) },
      secretPresence: { query: vi.fn().mockRejectedValue(new Error('no surface')) },
      set: { mutate: vi.fn().mockResolvedValue({ settings, refusals: [] }) },
    },
    accounts: { list: { query: vi.fn().mockResolvedValue([]) } },
    setup: {
      info: {
        query: vi.fn().mockResolvedValue({
          mode: 'all-in-one',
          publicUrl: 'https://old.tail.ts.net',
          networkOption: 'tailscale-serve',
          serverUrl: null,
        }),
      },
      options: {
        query: vi.fn().mockResolvedValue([
          {
            id: 'tailscale-serve',
            label: 'Tailscale Serve (private)',
            note: 'Reachable only from devices on your tailnet.',
          },
        ]),
      },
      commandFor: {
        query: vi.fn().mockResolvedValue({
          command: 'tailscale serve 18787',
          hint: 'Then paste the URL it prints.',
        }),
      },
      complete: { mutate: vi.fn().mockResolvedValue({ mode: 'all-in-one' }) },
    },
    auth: {
      status: { query: vi.fn().mockResolvedValue({ hasOwnCredential: true }) },
    },
  } as unknown as Store['trpc']
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Make the blob dirty the way a user does: flip the first toggle on the tab. */
async function makeDirty(): Promise<void> {
  const toggle = await waitFor(() => {
    const el = document.querySelector('[data-slot="switch"]')
    if (!el) throw new Error('no toggle rendered yet')
    return el
  })
  fireEvent.click(toggle)
  await screen.findByText('Unsaved changes')
}

describe('Settings sheet — closing with unsaved edits', () => {
  it('demands the cap scalar only on Hibernation and never demands fleet metric rows', async () => {
    const view = render(<SettingsView onClose={onClose} />)
    await makeDirty()
    expect(demand.metrics).not.toHaveBeenCalled()
    expect(demand.idleCap).not.toHaveBeenCalled()

    storeState.settingsTab = 'hibernation'
    view.rerender(<SettingsView onClose={onClose} />)
    expect(await screen.findByText('Cap unmet: 3 protected/ineligible')).toBeTruthy()
    expect(demand.idleCap).toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Maximum idle sessions'), { target: { value: '4' } })
    expect(screen.getByText('Cap unmet: 3 protected/ineligible')).toBeTruthy()
    expect(demand.metrics).not.toHaveBeenCalled()

    demand.idleCap.mockClear()
    storeState.settingsTab = 'sessions'
    view.rerender(<SettingsView onClose={onClose} />)
    expect(screen.queryByText('Cap unmet: 3 protected/ineligible')).toBeNull()
    expect(demand.idleCap).not.toHaveBeenCalled()
    expect(demand.metrics).not.toHaveBeenCalled()
  })

  it('closes on Escape when nothing is dirty', async () => {
    render(<SettingsView onClose={onClose} />)
    await waitFor(() => expect(document.querySelector('[data-slot="switch"]')).not.toBeNull())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('REFUSES Escape while dirty, and says why rather than failing silently', async () => {
    render(<SettingsView onClose={onClose} />)
    await makeDirty()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
    // The refusal points at the bar that resolves it — no second modal layer,
    // which the sheet tier forbids (DESIGN.md §The Sheet Tier).
    const blocked = await screen.findByText('Unsaved changes — save or discard first')
    expect(blocked.getAttribute('role')).toBe('alert')
    expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy()
  })

  it('closes again once the edit is discarded', async () => {
    render(<SettingsView onClose={onClose} />)
    await makeDirty()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull())

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('refuses the backdrop and the ✕ too — one answer to "close", however asked', async () => {
    render(<SettingsView onClose={onClose} />)
    await makeDirty()

    const backdrop = document.querySelector('.app-sheet-backdrop')
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop as Element)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /close settings/i }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('uses the shared save and discard bar for Network settings', async () => {
    storeState.settingsTab = 'network'
    render(<SettingsView onClose={onClose} />)

    const input = (await screen.findByLabelText('Podium URL')) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'https://new.tail.ts.net' } })

    expect(await screen.findByText('Unsaved changes')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save network settings' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(input.value).toBe('https://old.tail.ts.net'))

    fireEvent.change(input, { target: { value: 'https://new.tail.ts.net' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(storeState.trpc.setup.complete.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ publicUrl: 'https://new.tail.ts.net' }),
      ),
    )
    expect(await screen.findByText('Saved ✓')).toBeTruthy()
  })
})
