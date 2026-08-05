import { normalizeSettings } from '@podium/runtime'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '@/app/store'

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

vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (s: typeof storeState) => unknown) => selector(storeState),
  useReplicaIssues: () => [],
}))
vi.mock('@/lib/use-feature', () => ({
  useFeature: () => false,
  invalidateFeatures: vi.fn(),
}))
vi.mock('@/lib/use-model-catalog', () => ({ useModelCatalog: () => ({}) }))

import { SettingsView } from './SettingsView'

const onClose = vi.fn()

beforeEach(() => {
  onClose.mockClear()
  const settings = normalizeSettings({})
  storeState.trpc = {
    settings: {
      get: { query: vi.fn().mockResolvedValue(settings) },
      viewer: { query: vi.fn().mockResolvedValue({ permitted: {} }) },
      secretPresence: { query: vi.fn().mockRejectedValue(new Error('no surface')) },
      set: { mutate: vi.fn().mockResolvedValue({ settings, refusals: [] }) },
    },
    accounts: { list: { query: vi.fn().mockResolvedValue([]) } },
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
})
