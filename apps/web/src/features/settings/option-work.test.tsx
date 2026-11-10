import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { MobxPool } from '@podium/client-graph'
import { seedInstancePreferences } from '@podium/client-graph/instance-preferences-fixture'
import { attachPreferenceSource } from '@podium/client-graph/preference-source'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { asUserId, resolveUserPreferences } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../../../tests/worklist/harness/src/work-meter'
import { attachSettingsSource } from '../../test-support/settings-source.test.fixture'

const seam = vi.hoisted(() => ({
  pool: undefined as MobxPool | undefined,
  owner: undefined as any,
}))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => seam.pool,
  useWorklistPoolProjection: <T,>(read: (pool: MobxPool) => T) => {
    const projection = useMemo(() => createPoolProjection(seam.pool!, read), [read])
    return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
  },
}))
vi.mock('./stable-access', () => ({
  useSettingsClient: () => seam.owner,
  useSettingsTrpc: () => seam.owner.trpc,
}))
vi.mock('@/app/store', () => ({
  readFixture: (read: (state: any) => unknown) => read(seam.owner),
}))
vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))
vi.mock('@/lib/use-model-catalog', () => ({
  useModelCatalog: () => ({}),
  useModelCatalogState: () => ({ catalog: {}, status: 'unavailable' }),
}))
vi.mock('@/lib/use-harness-descriptors', () => ({
  useHarnessDescriptors: () => ({ served: undefined, status: 'unavailable' }),
}))

import { SettingsView } from './SettingsView'

afterEach(() => {
  cleanup()
  seam.pool?.dispose()
  vi.restoreAllMocks()
})
const settle = async () => {
  for (let i = 0; i < 8; i++)
    await act(async () => {
      await Promise.resolve()
    })
}

it('measures the mounted settings sections at 1x and 4x', async () => {
  for (const scale of [1, 4]) {
    const machines = Array.from({ length: 16 * scale }, (_, i) => ({
      id: `machine-${i}`,
      name: `Machine ${i}`,
      hostname: `host-${i}`,
      online: true,
      appVersion: '1.0.0',
    }))
    // Registered roots as `scanReposAll` publishes them: the server stamps the
    // repo id and machine on every registered path (POD-6267).
    const repos = Array.from({ length: 8 * scale }, (_, i) => ({
      path: `/project-${i}`,
      kind: 'repository',
      machineId: `machine-${i % machines.length}`,
      repoId: `repo-${i}`,
      worktrees: [],
    }))
    const devices = Array.from({ length: 8 * scale }, (_, i) => ({
      sessionId: String(i).padStart(24, '0'),
      userId: 'operator',
      label: 'mobile',
      kind: 'mobile',
      deviceId: `device-${i}`,
      deviceName: `Phone ${i}`,
      platform: 'ios',
      lastSeenAt: '2026-10-06T10:00:00Z',
      createdAt: '2026-10-01T10:00:00Z',
      expiresAt: '2026-11-01T10:00:00Z',
      current: false,
    }))
    const listeners = new Set<() => void>(),
      uiListeners = new Set<(keys: ReadonlySet<string>) => void>(),
      values = new Map<string, string>()
    const ui = {
      get: (key: string) => values.get(key) ?? null,
      set(key: string, value: string | null) {
        if (value === null) values.delete(key)
        else values.set(key, value)
        for (const wake of uiListeners) wake(new Set([key]))
      },
      subscribe(wake: (keys: ReadonlySet<string>) => void) {
        uiListeners.add(wake)
        return () => {
          uiListeners.delete(wake)
        }
      },
    } as RoutedUiState
    let state = { machines, repos, settingsTab: 'sessions', sessions: [] }
    const owner = withKeyedInputs({
      getSnapshot: () => state as object,
      ui,
      subscribe(wake: () => void) {
        listeners.add(wake)
        return () => {
          listeners.delete(wake)
        }
      },
    })
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() })
    seam.pool = pool
    // My settings record, as the row source publishes it (POD-6673).
    pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'userPreferences',
          id: 'me',
          value: { ...resolveUserPreferences(undefined, asUserId('me')), id: 'me' } as never,
        },
      ],
    })
    // The instance settings record, as the feed delivers it (POD-6677).
    seedInstancePreferences(pool)
    // The logical repo records the replica carries beside those scans.
    pool.apply({
      type: 'update',
      rows: repos.map((row) => ({
        kind: 'repo' as const,
        id: row.repoId,
        value: {
          id: row.repoId,
          name: row.path.slice(1),
          prefix: null,
          defaultParentBranch: null,
          path: row.path,
        } as never,
      })),
    })
    attachSettingsSource(pool, owner)
    attachPreferenceSource(pool, ui)
    const rowReads = vi.spyOn(pool, 'row')
    const settings = normalizeSettings({})
    const trpc = {
      // The devices route now opens the Account page, which also mounts the
      // profile/password section (POD-6652).
      auth: {
        profile: { query: async () => ({ email: null }) },
        status: { query: async () => null },
      },
      settings: {
        get: { query: async () => settings },
        viewer: {
          query: async () => ({
            permitted: {
              'records.userPreferences.edit': true,
              'records.instancePreferences.edit': true,
            },
          }),
        },
        telegramBotPresence: { query: vi.fn().mockResolvedValue(true) },
        secretPresence: { query: async () => [] },
      },
      accounts: { list: { query: async () => [] } },
      setup: {
        channel: { query: async () => ({ channel: 'stable', envForced: false }) },
        info: { query: async () => ({ appVersion: '1.0.0' }) },
        setChannel: { mutate: async () => ({ channel: 'edge', envForced: false }) },
      },
      updates: {
        fleet: { query: async () => ({ targetVersion: null, machines: [] }) },
        proposal: { query: async () => null },
      },
      operations: { history: { query: async () => [] } },
      repos: {
        listDetailed: {
          query: async () => repos.map((row) => ({ ...row, machineId: 'machine-0', prefix: null })),
        },
      },
    }
    seam.owner = {
      trpc,
      uiState: ui,
      setSettingsTab() {},
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              // An admin's viewer: Updates and Repos are in the admin area (POD-6299).
              String(url).endsWith('/auth/admin/viewer')
                ? { sections: ['people', 'access', 'machines', 'instance', 'audit'] }
                : { sessions: devices },
            ),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    )
    const publish = (patch: Partial<typeof state>) => {
      state = { ...state, ...patch }
      for (const wake of listeners) wake()
    }
    for (const tab of ['sessions', 'updates', 'repos', 'devices']) {
      publish({ machines, repos, settingsTab: tab })
      const Surface = () => insideReader(tab, () => SettingsView({ onClose() {} }))
      let view!: ReturnType<typeof render>
      const record = async (action: string, run: () => void) => {
        rowReads.mockClear()
        const result = await measureWork(
          async () => {
            await act(async () => run())
            await settle()
            if (action === 'open') {
              if (tab === 'updates') await view.findByRole('button', { name: 'Check now' })
              if (tab === 'repos') await view.findByText('project-0')
              if (tab === 'devices') await view.findByText('Phone 0')
            }
          },
          { pool },
        )
        const rowsByEntity: Record<string, number> = {}
        for (const [entity] of rowReads.mock.calls)
          rowsByEntity[entity] = (rowsByEntity[entity] ?? 0) + 1
        console.log(
          'SETTINGS_WORK',
          JSON.stringify({ scale, tab, action, rowsByEntity, ...result.work }),
        )
        if (tab === 'updates') expect(rowsByEntity['settingsRepository'] ?? 0).toBe(0)
        if (tab === 'updates' && action === 'device')
          expect(rowsByEntity['settingsMachine'] ?? 0).toBeLessThanOrEqual(3)
        if (tab === 'updates' && action === 'repository')
          expect(rowsByEntity['settingsMachine'] ?? 0).toBe(0)
      }
      await record('open', () => {
        view = render(<Surface />)
      })
      expect(view.baseElement.textContent?.length).toBeGreaterThan(20)
      await record('setting', () => {
        if (tab === 'sessions')
          fireEvent.click(view.container.querySelector('[data-slot="switch"]')!)
        else ui.set('probe-setting', 'changed')
      })
      await record('device', () =>
        publish({
          machines: machines.map((row, i) => (i === 0 ? { ...row, name: 'Renamed machine' } : row)),
        }),
      )
      await record('repository', () =>
        publish({
          repos: repos.map((row, i) => (i === 0 ? { ...row, path: '/renamed-project' } : row)),
        }),
      )
      await record('heartbeat', () =>
        pool.applyLocals(
          { selectedIssueId: null, coarseNow: Date.now() + 5000 },
          new Set(['coarseNow']),
        ),
      )
      view.unmount()
      await settle()
    }
    pool.dispose()
    vi.unstubAllGlobals()
  }
}, 30_000)
