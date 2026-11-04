import '@/test-support/mock-core-store-handle'
import '@/test-support/mock-request-pool.test.fixture'
import { normalizeSettings } from '@podium/runtime'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReferenceState } from '../../../../../tests/worklist/diagnostics/reference-state'

type Store = ReferenceState<import('@/app/trpc').Trpc>

/**
 * THE ADMIN AREA IN THE SETTINGS RAIL (POD-6299; design §2.6).
 *
 * The rail draws the Administration, Instance settings and Secrets groups only
 * for a viewer `/auth/admin/viewer` offers them to. A member keeps his
 * preferences, his own password and his own machines.
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
vi.mock('@/lib/use-model-catalog', () => ({
  useModelCatalog: () => ({}),
  useModelCatalogState: () => ({ catalog: {}, status: 'unavailable' }),
}))
vi.mock('@/lib/use-harness-descriptors', () => ({
  useHarnessDescriptors: () => ({ served: undefined, status: 'unavailable' as const }),
}))

import { SettingsView } from './SettingsView'

beforeEach(() => {
  storeState.settingsTab = 'sessions'
  const settings = normalizeSettings({})
  storeState.trpc = {
    settings: {
      get: { query: vi.fn().mockResolvedValue(settings) },
      viewer: { query: vi.fn().mockResolvedValue({ permitted: {} }) },
      secretPresence: { query: vi.fn().mockRejectedValue(new Error('no surface')) },
    },
    accounts: { list: { query: vi.fn().mockResolvedValue([]) } },
  } as unknown as Store['trpc']
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The server's `/auth/admin/viewer` answer for this viewer. */
function viewer(sections: readonly string[] | 'refused') {
  const fetchMock = vi.fn(async (url: string) =>
    url.endsWith('/auth/admin/viewer') && sections !== 'refused'
      ? { ok: true, status: 200, json: async () => ({ sections }) }
      : { ok: false, status: 403, json: async () => ({ error: 'refused' }) },
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const railTabs = () =>
  [...screen.getByRole('navigation', { name: 'Settings sections' }).querySelectorAll('button')].map(
    (b) => b.textContent,
  )
const railGroups = () =>
  [
    ...screen
      .getByRole('navigation', { name: 'Settings sections' })
      .querySelectorAll('.settings-rail-group'),
  ].map((g) => g.textContent)

describe('Settings rail — the admin area', () => {
  it('Alice, an admin, sees People, Access, Machines, Instance settings and Audit', async () => {
    const fetchMock = viewer(['people', 'access', 'machines', 'instance', 'audit'])
    render(<SettingsView onClose={vi.fn()} />)
    await waitFor(() => expect(railGroups()).toContain('Administration'))
    expect(railGroups()).toEqual([
      'Your preferences',
      'Administration',
      'Instance settings',
      'Secrets',
    ])
    for (const tab of ['People', 'Access', 'Machines', 'Audit', 'Hibernation', 'Secrets'])
      expect(railTabs()).toContain(tab)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/auth\/admin\/viewer$/),
      expect.anything(),
    )
  })

  it('Bob, a member, sees no admin area, only his preferences and his own machines', async () => {
    const fetchMock = viewer([])
    render(<SettingsView onClose={vi.fn()} />)
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/auth\/admin\/viewer$/),
        expect.anything(),
      ),
    )
    await screen.findByRole('navigation', { name: 'Settings sections' })
    expect(railGroups()).toEqual(['Your preferences'])
    expect(railTabs()).toContain('Profile & security')
    expect(railTabs()).toContain('Machines')
    for (const tab of ['People', 'Access', 'Audit', 'Hibernation', 'Secrets', 'Updates'])
      expect(railTabs()).not.toContain(tab)
  })

  it('a deep link to an admin tab opens no admin section for Bob', async () => {
    viewer([])
    storeState.settingsTab = 'audit'
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByRole('navigation', { name: 'Settings sections' })
    expect(screen.queryByRole('heading', { name: 'Audit' })).toBeNull()
    expect(screen.getByRole('button', { name: 'New sessions' }).getAttribute('aria-current')).toBe(
      'page',
    )
  })

  it('draws no admin area while the viewer read fails', async () => {
    viewer('refused')
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByRole('navigation', { name: 'Settings sections' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(railGroups()).toEqual(['Your preferences'])
  })
})
