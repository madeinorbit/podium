import type { ClientRuntime } from '@podium/client-core/engine'
import { readRuntimeStoreStats, storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import type { MobilePool } from '../client/mobile-pool'
import { asUserId } from '@podium/model'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Alert, Platform } from 'react-native'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHeaderFixture } from '../../../web/test/header-fixture'

const seams = vi.hoisted(() => ({
  host: undefined as MobilePool | undefined,
  logout: vi.fn(async () => {}), erase: vi.fn(async () => {}), credential: vi.fn(async () => {}),
  add: vi.fn(), rename: vi.fn(async () => {}), remove: vi.fn(async () => {}),
  switch: vi.fn(async () => {}), back: vi.fn(), replace: vi.fn(),
}))
vi.mock('../client/mobile-pool', async importOriginal => {
  const real = await importOriginal<typeof import('../client/mobile-pool')>()
  return { ...real, mobileDataLayer: () => seams.host?.layer() ?? 'legacy',
    useMobilePool: () => seams.host!.host.usePool(),
    useMobilePoolProjection: <T,>(...args: Parameters<MobilePool['host']['usePoolProjection']>) =>
      seams.host!.host.usePoolProjection(...args) as T }
})
vi.mock('expo-router', () => ({ useRouter: () => ({ back: seams.back, replace: seams.replace }) }))
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' }, impactAsync: async () => {} }))
vi.mock('../client/auth', () => ({ logout: seams.logout }))
vi.mock('../client/shell', () => ({ useMobileShell: () => ({ eraseLocalData: seams.erase }) }))
vi.mock('../client/ServerProfileGate', () => ({ useServerProfile: () => ({
  profile: { id: 'phone', name: 'Phone', httpOrigin: 'http://offline.invalid', workspaceId: 'workspace' },
  profiles: [{ id: 'phone', name: 'Phone', httpOrigin: 'http://offline.invalid', transport: 'https' },
    { id: 'other', name: 'Other server', httpOrigin: 'https://other.invalid', transport: 'https' }],
  bearer: 'synthetic-credential', isEphemeralOverride: false, beginAddServer: seams.add,
  switchProfile: seams.switch, renameProfile: seams.rename, removeProfile: seams.remove,
  updateCredential: seams.credential,
}) }))
vi.mock('../client/connected-devices', () => ({ useConnectedDevices: () => ({ sessions: [], loading: false, failed: false }) }))
vi.mock('../lib/build-stamp', () => ({ useBuildStamp: () => ({ text: 'synthetic.invalid\nserver 1 · app 1', reload() {} }) }))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 0 }))
vi.mock('../components/Screen', () => ({ Screen: ({ children, onBack }: { children: ReactNode; onBack: () => void }) =>
  <div><button onClick={onBack}>Done</button>{children}</div> }))
vi.mock('../components/Icon', () => ({ Icon: () => null }))
// POD-5247 owns this sibling reader; compare/count only this issue's screen.
vi.mock('../components/OutboxRecoveryPanel', () => ({ OutboxRecoveryPanel: () => null }))
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

async function mount(on: boolean) {
  seams.host = createMobilePool(false, () => ({ get: () => undefined, device: () => on }))
  const data = createHeaderFixture(8, 8), errors: string[] = [], seen: unknown[] = []
  // Include archived, deleted and draft rows in the count, and resume twins in
  // the session summary; count parity must not inherit worklist filtering.
  const issue = data.records.get('issueProjection:synthetic-0')!
  data.records.set('issueProjection:synthetic-0', { ...issue,
    value: { ...(issue.value as object), archived: true, deletedAt: '2026-10-01', isDraftVessel: true } })
  const twin = data.records.get('session:synthetic-session-0')!
  data.records.set('session:synthetic-session-0', { ...twin, value: { ...(twin.value as object),
    status: 'exited', stoppedAt: '2026-10-01T00:00:00Z', resume: { kind: 'codex.thread', value: 'synthetic-twin' } } })
  const newer = data.records.get('session:synthetic-session-1')!
  data.records.set('session:synthetic-session-1', { ...newer, value: { ...(newer.value as object),
    resume: { kind: 'codex.thread', value: 'synthetic-twin' } } })
  let runtime!: ClientRuntime
  function Surface() {
    runtime = useStoreHandle() as ClientRuntime
    seams.host!.initialize(runtime.ui)
    seen.push(useMobilePool())
    return <SettingsScreen />
  }
  storeStats.enable(); storeStats.reset()
  const view = render(<StoreProvider principal={asClientPrincipal(asUserId('operator'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }} api={data.api}
    createReplicaFn={() => data.newReplica()} networkEnabled={false} routerWindow={createMemoryRouterWindow()}
    onFatalError={error => errors.push(error)} attachRuntime={owner => {
      data.bindHub(owner.hub)
      return seams.host!.host.attach(owner, error => errors.push(error.message))
    }}><Surface /></StoreProvider>)
  await waitFor(() => {
    expect(rowValue(view.container, 'Tasks')).toBe('8')
    expect(rowValue(view.container, 'Sessions')).toBe(String(runtime.getSnapshot().sessions.length))
  }, { timeout: 5000 })
  await act(async () => {
    data.publishMachines()
    data.publishMetrics(0)
  })
  await waitFor(() => expect(view.getByText('Host 1')).toBeTruthy())
  return { data, view, runtime, errors, seen }
}
function rowValue(container: HTMLElement, label: string): string | undefined {
  return [...container.querySelectorAll('div')].find(node =>
    node.children.length === 2 && node.children[0]?.textContent === label)?.children[1]?.textContent ?? undefined
}
function comparableHtml(container: HTMLElement): string {
  // The Experimental hint intentionally reports the launch's chosen data layer.
  return container.innerHTML.replaceAll(/This launch: (?:on|off)\./g, 'This launch: <choice>.')
}

it('renders the same Settings through the real no-pool to attached-pool transition', async () => {
  const legacy = await mount(false)
  const expected = comparableHtml(legacy.view.container)
  expect(rowValue(legacy.view.container, 'Tasks')).toBe('8')
  legacy.view.unmount()
  const enabled = await mount(true)
  expect(comparableHtml(enabled.view.container)).toBe(expected)
  expect(enabled.seen[0]).toBeNull()
  expect(enabled.seen.some(pool => pool !== null)).toBe(true)
  expect(enabled.errors).toEqual([])
})

it('uses zero legacy selectors and issue models while relevant updates still paint', async () => {
  const enabled = await mount(true)
  expect(readRuntimeStoreStats(enabled.runtime)).toBeDefined()
  expect(readRuntimeStoreStats(enabled.runtime)?.selectorRuns).toBe(0)
  expect(readRuntimeStoreStats(enabled.runtime)?.rowBuilds).toBe(0)
  await act(async () => {
    enabled.data.activity(1)
    enabled.data.publishMachines()
    enabled.data.publishMetrics(2)
    const machines = enabled.runtime.getSnapshot().machines
    const hub = enabled.runtime.hub as unknown as { emit: (kind: string, rows: unknown) => void }
    hub.emit('machines', machines.map(machine => ({ ...machine, name: `${machine.name} updated` })))
  })
  await waitFor(() => expect(enabled.view.getByText('Host 1 updated')).toBeTruthy())
  expect(readRuntimeStoreStats(enabled.runtime)).toBeDefined()
  expect(readRuntimeStoreStats(enabled.runtime)?.selectorRuns).toBe(0)
  expect(readRuntimeStoreStats(enabled.runtime)?.rowBuilds).toBe(0)
  expect(rowValue(enabled.view.container, 'Tasks')).toBe('8')
  expect(enabled.errors).toEqual([])
  enabled.view.unmount()
  const legacy = await mount(false)
  expect(readRuntimeStoreStats(legacy.runtime)?.selectorRuns).toBeGreaterThan(0)
})

it('keeps server controls and logout on their existing owners in both arms', async () => {
  vi.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    buttons?.find(button => button.style === 'destructive')?.onPress?.()
  })
  for (const on of [false, true]) {
    const current = await mount(on)
    fireEvent.click(current.view.getByText('Done'))
    fireEvent.click(current.view.getByLabelText('Add server'))
    fireEvent.click(current.view.getByLabelText('Switch to Other server'))
    fireEvent.change(current.view.getByLabelText('Server name'), { target: { value: 'Renamed phone' } })
    fireEvent.click(current.view.getByLabelText('Rename server'))
    await act(async () => fireEvent.click(current.view.getByLabelText('Log out')))
    expect(seams.logout).toHaveBeenLastCalledWith('http://offline.invalid', 'synthetic-credential', 'workspace')
    expect(seams.erase).toHaveBeenCalled()
    expect(seams.credential).toHaveBeenLastCalledWith(null)
    expect(current.view.getByText('Logged out')).toBeTruthy()
    await act(async () => fireEvent.click(current.view.getByLabelText('Remove Phone')))
    expect(seams.remove).toHaveBeenLastCalledWith('phone')
    expect(seams.replace).toHaveBeenLastCalledWith('/')
    expect(current.errors).toEqual([])
    current.view.unmount()
  }
  expect(seams.back).toHaveBeenCalledTimes(2)
  expect(seams.add).toHaveBeenCalledTimes(2)
  expect(seams.switch).toHaveBeenCalledWith('other')
  expect(seams.rename).toHaveBeenCalledWith('phone', 'Renamed phone')
})
