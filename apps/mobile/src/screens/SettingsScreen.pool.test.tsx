import { settingsView } from '@podium/client-graph/settings-views'
import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
import type { ClientRuntime } from '@podium/client-core/engine'
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import type { MobxPool } from '@podium/client-graph'
import { asUserId } from '@podium/model'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Alert, Platform } from 'react-native'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHeaderFixture } from '../../../web/test/header-fixture'
import type { MobilePool } from '../client/mobile-pool'

const seams = vi.hoisted(() => ({
  host: undefined as MobilePool | undefined,
  logout: vi.fn(async () => {}),
  erase: vi.fn(async () => {}),
  credential: vi.fn(async () => {}),
  add: vi.fn(),
  rename: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  switch: vi.fn(async () => {}),
  back: vi.fn(),
  replace: vi.fn(),
}))
vi.mock('../client/mobile-pool', async (importOriginal) => {
  const real = await importOriginal<typeof import('../client/mobile-pool')>()
  return {
    ...real,
    useMobilePool: () => seams.host!.host.usePool(),
    useMobilePoolProjection: <T,>(...args: Parameters<MobilePool['host']['usePoolProjection']>) =>
      seams.host!.host.usePoolProjection(...args) as T,
  }
})
vi.mock('expo-router', () => ({ useRouter: () => ({ back: seams.back, replace: seams.replace }) }))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: async () => {},
}))
vi.mock('expo-clipboard', () => ({
  setStringAsync: async () => {}, getStringAsync: async () => '',
  isPasteButtonAvailable: false, ClipboardPasteButton: () => null,
}))
vi.mock('../client/auth', () => ({ logout: seams.logout }))
vi.mock('../client/shell', () => ({ useMobileShell: () => ({ eraseLocalData: seams.erase }) }))
vi.mock('../client/ServerProfileGate', () => ({
  useServerProfile: () => ({
    profile: {
      id: 'phone',
      name: 'Phone',
      httpOrigin: 'http://offline.invalid',
      workspaceId: 'workspace',
    },
    profiles: [
      { id: 'phone', name: 'Phone', httpOrigin: 'http://offline.invalid', transport: 'https' },
      {
        id: 'other',
        name: 'Other server',
        httpOrigin: 'https://other.invalid',
        transport: 'https',
      },
    ],
    bearer: 'synthetic-credential',
    isEphemeralOverride: false,
    beginAddServer: seams.add,
    switchProfile: seams.switch,
    renameProfile: seams.rename,
    removeProfile: seams.remove,
    updateCredential: seams.credential,
  }),
}))
vi.mock('../client/connected-devices', () => ({
  useConnectedDevices: () => ({ sessions: [], loading: false, failed: false }),
}))
vi.mock('../lib/build-stamp', () => ({
  useBuildStamp: () => ({ text: 'synthetic.invalid\nserver 1 · app 1', reload() {} }),
}))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 0 }))
vi.mock('../components/Screen', () => ({
  Screen: ({ children, onBack }: { children: ReactNode; onBack: () => void }) => (
    <div>
      <button type="button" onClick={onBack}>
        Done
      </button>
      {children}
    </div>
  ),
}))
vi.mock('../components/Icon', () => ({ Icon: () => null }))
const { SettingsScreen } = await import('./SettingsScreen')
const { createMobilePool, useMobilePool } = await import('../client/mobile-pool')

beforeEach(() => {
  vi.clearAllMocks()
  ;(Platform as { OS: string }).OS = 'ios'
})
afterEach(() => {
  cleanup()
  ;(Platform as { OS: string }).OS = 'web'
  storeStats.enable(false)
  storeStats.reset()
  vi.restoreAllMocks()
})

async function mount() {
  seams.host = createMobilePool(false)
  const data = createHeaderFixture(8, 8),
    errors: string[] = [],
    seen: unknown[] = []
  // Include archived, deleted and draft rows in the count, and resume twins in
  // the session summary; count parity must not inherit worklist filtering.
  const issue = data.records.get('issueProjection:synthetic-0')!
  data.records.set('issueProjection:synthetic-0', {
    ...issue,
    value: {
      ...(issue.value as object),
      archived: true,
      deletedAt: '2026-10-01',
      isDraftVessel: true,
    },
  })
  const twin = data.records.get('session:synthetic-session-0')!
  data.records.set('session:synthetic-session-0', {
    ...twin,
    value: {
      ...(twin.value as object),
      status: 'exited',
      stoppedAt: '2026-10-01T00:00:00Z',
      resume: { kind: 'codex.thread', value: 'synthetic-twin' },
    },
  })
  const newer = data.records.get('session:synthetic-session-1')!
  data.records.set('session:synthetic-session-1', {
    ...newer,
    value: {
      ...(newer.value as object),
      resume: { kind: 'codex.thread', value: 'synthetic-twin' },
    },
  })
  let runtime!: ClientRuntime
  function Surface() {
    runtime = useStoreHandle() as ClientRuntime

    seen.push(useMobilePool())
    return <SettingsScreen />
  }
  storeStats.enable()
  storeStats.reset()
  const view = render(
    <StoreProvider
      principal={asClientPrincipal(asUserId('operator'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={data.api}
      createReplicaFn={() => data.newReplica()}
      networkEnabled={false}
      routerWindow={createMemoryRouterWindow()}
      onFatalError={(error) => errors.push(error)}
      attachRuntime={(owner) => {
        data.bindHub(owner.hub)
        return seams.host!.host.attach(owner, (error) => errors.push(error.message))
      }}
    >
      <Surface />
    </StoreProvider>,
  )
  await waitFor(
    () => {
      expect(rowValue(view.container, 'Tasks')).toBe('8')
      expect(rowValue(view.container, 'Sessions')).toBe(
        String(referenceState(runtime).sessions.length),
      )
    },
    { timeout: 5000 },
  )
  await act(async () => {
    data.publishMachines()
    data.publishMetrics(0)
  })
  await waitFor(() => expect(view.getByText('Host 1')).toBeTruthy())
  return { data, view, runtime, errors, seen }
}
function rowValue(container: HTMLElement, label: string): string | undefined {
  return (
    [...container.querySelectorAll('div')].find(
      (node) => node.children.length === 2 && node.children[0]?.textContent === label,
    )?.children[1]?.textContent ?? undefined
  )
}
it('renders the same Settings through the real no-pool to attached-pool transition', async () => {
  const enabled = await mount()
  // The only edited expectation is the explicitly retired pilot row.
  expect(enabled.view.container.innerHTML).toMatchSnapshot('last green pilot-ON Settings')
  expect(enabled.seen[0]).toBeNull()
  expect(enabled.seen.some((pool) => pool !== null)).toBe(true)
  expect(enabled.errors).toEqual([])
})

it('uses zero legacy selectors and issue models while relevant updates still paint', async () => {
  const enabled = await mount()
  const pool = enabled.seen.findLast(pool => pool !== null) as MobxPool
  const roster = vi.spyOn(settingsView(pool), 'sessions'), count = vi.spyOn(settingsView(pool), 'sessionCount')
  await act(async () => {
    enabled.data.activity(1)
    enabled.data.publishMachines()
    enabled.data.publishMetrics(2)
    const machines = referenceState(enabled.runtime).machines
    const hub = enabled.runtime.hub as unknown as { emit: (kind: string, rows: unknown) => void }
    hub.emit(
      'machines',
      machines.map((machine) => ({ ...machine, name: `${machine.name} updated` })),
    )
  })
  await waitFor(() => expect(enabled.view.getByText('Host 1 updated')).toBeTruthy())
  expect(roster).not.toHaveBeenCalled()
  expect(count).toHaveBeenCalled()
  expect(rowValue(enabled.view.container, 'Tasks')).toBe('8')
  expect(enabled.errors).toEqual([])
})

it('keeps server controls and logout on their existing owners', async () => {
  vi.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    buttons?.find((button) => button.style === 'destructive')?.onPress?.()
  })
  {
    const current = await mount()
    fireEvent.click(current.view.getByText('Done'))
    fireEvent.click(current.view.getByLabelText('Add server'))
    fireEvent.click(current.view.getByLabelText('Switch to Other server'))
    fireEvent.change(current.view.getByLabelText('Server name'), {
      target: { value: 'Renamed phone' },
    })
    fireEvent.click(current.view.getByLabelText('Rename server'))
    await act(async () => fireEvent.click(current.view.getByLabelText('Log out')))
    expect(seams.logout).toHaveBeenLastCalledWith(
      'http://offline.invalid',
      'synthetic-credential',
      'workspace',
    )
    expect(seams.erase).toHaveBeenCalled()
    expect(seams.credential).toHaveBeenLastCalledWith(null)
    expect(current.view.getByText('Logged out')).toBeTruthy()
    await act(async () => fireEvent.click(current.view.getByLabelText('Remove Phone')))
    expect(seams.remove).toHaveBeenLastCalledWith('phone')
    expect(seams.replace).toHaveBeenLastCalledWith('/')
    expect(current.errors).toEqual([])
    current.view.unmount()
  }
  expect(seams.back).toHaveBeenCalledTimes(1)
  expect(seams.add).toHaveBeenCalledTimes(1)
  expect(seams.switch).toHaveBeenCalledWith('other')
  expect(seams.rename).toHaveBeenCalledWith('phone', 'Renamed phone')
})
