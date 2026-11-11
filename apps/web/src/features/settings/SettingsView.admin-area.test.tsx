import '@/test-support/mock-core-store-handle'
import '@/test-support/mock-request-pool.test.fixture'
import { normalizeSettings } from '@podium/runtime'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * THE ADMIN AREA IN THE SETTINGS RAIL (POD-6299; design §2.6).
 *
 * The rail draws the Administration, Instance settings and Secrets groups only
 * for a viewer `/auth/admin/viewer` offers them to. A member keeps his
 * preferences, his own password and his own machines.
 */
const storeState = {
  trpc: {} as import('@/app/trpc').Trpc,
  settingsTab: 'agents',
  setSettingsTab: vi.fn(),
  hostMetrics: undefined,
}
const demand = vi.hoisted(() => ({
  metrics: vi.fn(() => []),
  idleCap: vi.fn(() => 3),
}))

vi.mock('@/app/store', () => ({
  useHostMetrics: demand.metrics,
  readFixture: (selector: (s: typeof storeState) => unknown) => selector(storeState),
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
  storeState.settingsTab = 'agents'
  const settings = normalizeSettings({})
  storeState.trpc = {
    settings: {
      get: { query: vi.fn().mockResolvedValue(settings) },
      viewer: { query: vi.fn().mockResolvedValue({ permitted: {} }) },
      telegramBotPresence: { query: vi.fn().mockResolvedValue(true) },
      secretPresence: { query: vi.fn().mockRejectedValue(new Error('no surface')) },
    },
    accounts: { list: { query: vi.fn().mockResolvedValue([]) } },
  } as unknown as import('@/app/trpc').Trpc
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

function pendingResponse() {
  let finish: (response: Response) => void
  const promise = new Promise<Response>((resolve) => {
    finish = resolve
  })
  return { promise, resolve: (response: Response) => finish(response) }
}

function delayedViewer() {
  const read = pendingResponse()
  const fetchMock = vi.fn((url: string) =>
    url.endsWith('/auth/admin/viewer')
      ? read.promise
      : Promise.resolve(Response.json({ events: [], nextBefore: null })),
  )
  vi.stubGlobal('fetch', fetchMock)
  return { read, fetchMock }
}

describe('Settings rail — the admin area', () => {
  it('keeps an admin deep link pending until the viewer answers, then opens that tab', async () => {
    const { read, fetchMock } = delayedViewer()
    storeState.settingsTab = 'audit'
    render(<SettingsView onClose={vi.fn()} />)

    expect(railGroups()).toEqual(['Personal', 'Workspace'])
    expect(
      screen.getByRole('navigation', { name: 'Settings sections' }).querySelector('[aria-current]'),
    ).toBeNull()
    expect(screen.queryByRole('heading', { level: 3, name: /^Audit log/ })).toBeNull()
    expect(fetchMock.mock.calls.some(([url]) => url.includes('/auth/admin/audit'))).toBe(false)
    expect(screen.getByText('Checking administrator access…')).toBeTruthy()

    await act(async () => read.resolve(Response.json({ sections: ['audit'] })))
    expect(await screen.findByRole('heading', { level: 3, name: /^Audit log/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Audit log' }).getAttribute('aria-current')).toBe(
      'page',
    )
  })

  it('falls back from a member deep link only after the viewer confirms no admin access', async () => {
    const { read } = delayedViewer()
    storeState.settingsTab = 'audit'
    render(<SettingsView onClose={vi.fn()} />)
    expect(
      screen.getByRole('navigation', { name: 'Settings sections' }).querySelector('[aria-current]'),
    ).toBeNull()

    await act(async () => read.resolve(Response.json({ sections: [] })))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Agents' }).getAttribute('aria-current')).toBe(
        'page',
      ),
    )
    expect(screen.queryByRole('heading', { level: 3, name: /^Audit log/ })).toBeNull()
  })

  it('Alice, an admin, sees all thirteen Personal and Workspace pages', async () => {
    const fetchMock = viewer(['people', 'access', 'machines', 'instance', 'audit'])
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByRole('button', { name: 'Audit log' })
    expect(railGroups()).toEqual(['Personal', 'Workspace'])
    for (const tab of [
      'Agents',
      'AI accounts',
      'Notifications',
      'Appearance',
      'Account',
      'Machines',
      'Projects',
      'Members',
      'Access',
      'Audit log',
      'Privacy',
      'Updates',
      'Labs',
    ])
      expect(railTabs()).toContain(tab)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/auth\/admin\/viewer$/),
      expect.anything(),
    )
  })

  it('Bob, a member, sees personal pages and shared workspace pages', async () => {
    const fetchMock = viewer([])
    render(<SettingsView onClose={vi.fn()} />)
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/auth\/admin\/viewer$/),
        expect.anything(),
      ),
    )
    await screen.findByRole('navigation', { name: 'Settings sections' })
    expect(railGroups()).toEqual(['Personal', 'Workspace'])
    await screen.findByRole('button', { name: 'Account' })
    expect(railTabs()).toContain('Account')
    for (const tab of ['Machines', 'Projects', 'Members', 'Updates'])
      expect(railTabs()).toContain(tab)
    for (const tab of ['Access', 'Audit log', 'Privacy', 'Labs'])
      expect(railTabs()).not.toContain(tab)
  })

  it('a deep link to an admin tab opens no admin section for Bob', async () => {
    viewer([])
    storeState.settingsTab = 'audit'
    render(<SettingsView onClose={vi.fn()} />)
    await screen.findByRole('navigation', { name: 'Settings sections' })
    expect(screen.queryByRole('heading', { level: 3, name: /^Audit log/ })).toBeNull()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Agents' }).getAttribute('aria-current')).toBe(
        'page',
      ),
    )
  })

  it('shows a quiet failure with Retry and recovers the original admin deep link', async () => {
    const fetchMock = viewer('refused')
    storeState.settingsTab = 'audit'
    render(<SettingsView onClose={vi.fn()} />)
    expect(await screen.findByText('Couldn’t check administrator access.')).toBeTruthy()
    expect(railGroups()).toEqual(['Personal', 'Workspace'])
    expect(
      screen.getByRole('navigation', { name: 'Settings sections' }).querySelector('[aria-current]'),
    ).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Audit log' })).toBeNull()

    const retry = pendingResponse()
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/auth/admin/viewer')
        ? retry.promise
        : Response.json({ events: [], nextBefore: null }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Checking administrator access…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(railGroups()).toEqual(['Personal', 'Workspace'])

    await act(async () => retry.resolve(Response.json({ sections: ['audit'] })))
    expect(await screen.findByRole('heading', { level: 3, name: /^Audit log/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Audit log' }).getAttribute('aria-current')).toBe(
      'page',
    )
  })
})
