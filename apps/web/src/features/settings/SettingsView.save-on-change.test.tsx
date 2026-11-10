import '@/test-support/mock-core-store-handle'
import '@/test-support/mock-request-pool.test.fixture'
import { seedInstancePreferences } from '@podium/client-graph/instance-preferences-fixture'
import { INSTANCE_PREFERENCES_ROW_ID } from '@podium/model/browser'
import { normalizeSettings } from '@podium/runtime'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorklistPool } from '@/app/store-worklist-pool'
import type { ReferenceState } from '../../../../../tests/worklist/diagnostics/reference-state'

type Store = ReferenceState<import('@/app/trpc').Trpc>

const storeState = {
  trpc: {} as import('@/app/trpc').Trpc,
  setInstancePreferences: vi.fn(async (_values: Record<string, unknown>) => {}),
  settingsTab: 'sessions',
  setPreferences: vi.fn(async (_values: Record<string, unknown>) => {}),
  setSettingsTab: vi.fn(),
  hostMetrics: undefined,
}
const demand = vi.hoisted(() => ({
  metrics: vi.fn(() => []),
  idleCap: vi.fn(() => 3),
}))
let notificationsEnabled = false

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
  useFeature: (name: string) => name === 'notifications' && notificationsEnabled,
}))
vi.mock('@/lib/use-model-catalog', () => ({
  useModelCatalog: () => ({}),
  useModelCatalogState: () => ({ catalog: {}, status: 'unavailable' }),
}))
vi.mock('@/lib/use-harness-descriptors', () => ({
  useHarnessDescriptors: () => ({ served: undefined, status: 'unavailable' as const }),
}))

import { SettingsView } from './SettingsView'

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: Object.assign(toastMock, { error: vi.fn() }) }))
const onClose = vi.fn()

beforeEach(() => {
  notificationsEnabled = false
  toastMock.mockClear()
  storeState.setInstancePreferences = vi.fn(async () => {})
  demand.metrics.mockClear()
  demand.idleCap.mockClear()
  onClose.mockClear()
  storeState.settingsTab = 'sessions'
  // An admin's viewer: the instance tabs below are in the admin area (POD-6299).
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/auth/admin/viewer')
        ? {
            ok: true,
            status: 200,
            json: async () => ({ sections: ['people', 'access', 'machines', 'instance', 'audit'] }),
          }
        : { ok: false, status: 404, json: async () => ({}) },
    ),
  )
  const settings = normalizeSettings({})
  storeState.trpc = {
    settings: {
      viewer: {
        query: vi.fn().mockResolvedValue({
          permitted: {
            'records.userPreferences.edit': true,
            'records.instancePreferences.edit': true,
            'settings.setSecret': true,
          },
        }),
      },
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
  } as unknown as import('@/app/trpc').Trpc
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Settings save on change', () => {
  it('counts Telegram seconds in its label and expires the setup at its exact deadline', async () => {
    notificationsEnabled = true
    storeState.settingsTab = 'notifications'
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const poll = vi.fn().mockResolvedValue({ status: 'pending' })
    Object.assign(storeState.trpc.settings, {
      secretPresence: {
        query: vi
          .fn()
          .mockResolvedValue([{ key: 'notifications.telegramBotToken', present: true }]),
      },
      telegramSetupStart: {
        mutate: vi.fn().mockResolvedValue({
          setupId: 'setup-one',
          code: 'test-code',
          botUsername: 'test_bot',
          telegramUrl: 'https://t.me/test_bot',
          expiresAt: new Date(102_250).toISOString(),
        }),
      },
      telegramSetupPoll: { mutate: poll },
    })
    await act(async () => {
      render(<SettingsView onClose={onClose} />)
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect Telegram' }))
    })
    expect(screen.getByText('0:03 left')).toBeTruthy()
    act(() => vi.advanceTimersByTime(999))
    expect(screen.getByText('0:03 left')).toBeTruthy()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByText('0:02 left')).toBeTruthy()
    act(() => vi.advanceTimersByTime(1_250))
    expect(screen.getByText('Setup expired. Start again.')).toBeTruthy()
    expect(poll).toHaveBeenCalledTimes(1)
  })

  it('keeps typing local, commits once on Enter, and restores only that leaf with Undo', async () => {
    storeState.settingsTab = 'hibernation'
    const pool = useWorklistPool()!
    const update = vi.fn(async (values: Record<string, unknown>) => {
      const current = pool.tables.instancePreferences!.get(INSTANCE_PREFERENCES_ROW_ID)!
      seedInstancePreferences(pool, {
        hibernation: {
          ...(current.hibernation as object),
          memoryPct: values['hibernation.memoryPct'] as number,
        },
      })
    })
    storeState.setInstancePreferences = update
    render(<SettingsView onClose={onClose} />)
    const memory = (await screen.findByDisplayValue('80')) as HTMLInputElement
    fireEvent.focus(memory)
    fireEvent.change(memory, { target: { value: '8' } })
    expect(memory.value).toBe('8')
    expect(update).not.toHaveBeenCalled()
    fireEvent.change(memory, { target: { value: '85' } })
    act(() => seedInstancePreferences(pool, { hibernation: { memoryPct: 90, idleMinutes: 123 } }))
    expect(memory.value).toBe('85')
    fireEvent.keyDown(memory, { key: 'Enter' })
    fireEvent.blur(memory)
    await waitFor(() =>
      expect(update).toHaveBeenCalledExactlyOnceWith({ 'hibernation.memoryPct': 85 }),
    )
    await waitFor(() => expect(toastMock).toHaveBeenCalled())
    expect(await screen.findByDisplayValue('123')).toBeTruthy()
    const undo = toastMock.mock.calls.at(-1)![1].action.onClick
    await act(async () => undo())
    expect(update).toHaveBeenLastCalledWith({ 'hibernation.memoryPct': 90 })
    expect(screen.getByDisplayValue('123')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
  })

  it('reverts a refused control and puts the reason on its row', async () => {
    storeState.settingsTab = 'hibernation'
    storeState.setInstancePreferences = vi.fn(async () => {
      throw new Error('This setting is locked by the deployment.')
    })
    render(<SettingsView onClose={onClose} />)
    const memory = (await screen.findByDisplayValue('80')) as HTMLInputElement
    fireEvent.change(memory, { target: { value: '85' } })
    fireEvent.blur(memory)
    const error = await screen.findByRole('alert')
    expect(error.textContent).toContain('locked by the deployment')
    expect(error.closest('.settings-row')?.contains(memory)).toBe(true)
    expect(memory.value).toBe('80')
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('saves Mirror transcripts immediately on the Privacy page', async () => {
    storeState.settingsTab = 'privacy'
    render(<SettingsView onClose={onClose} />)
    const mirror = await screen.findByTestId('transcript-mirror')
    fireEvent.click(mirror)
    await waitFor(() =>
      expect(storeState.setInstancePreferences).toHaveBeenCalledWith({
        'transcripts.mirror': false,
      }),
    )
  })

  it('closes on Escape, the backdrop and the close button after a setting changes', async () => {
    render(<SettingsView onClose={onClose} />)
    const toggle = await waitFor(() => {
      const toggle = document.querySelector('[data-slot="switch"]')
      if (!toggle) throw new Error('waiting for settings')
      return toggle
    })
    fireEvent.click(toggle)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(document.querySelector('.app-sheet-backdrop')!)
    fireEvent.click(screen.getByRole('button', { name: /close settings/i }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})
