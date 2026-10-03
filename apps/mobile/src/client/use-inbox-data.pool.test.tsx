import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { asClientPrincipal } from '@podium/client-core/principal'
import type { ClientRuntime } from '@podium/client-core/engine'
import { readRuntimeStoreStats, storeStats } from '@podium/client-core/perf'
import { allIssueViewModels } from '@podium/client-core/replica'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { checkMobileInbox } from '@podium/client-graph/diagnostics/mobile-inbox-check'
import { mobileInboxViews } from '@podium/client-graph/mobile-inbox'
import { MOBILE_INBOX_ENTITIES, MOBILE_INBOX_SOURCE_KEY } from '@podium/client-graph/mobile-inbox-schema'
import { MobileInboxSource } from '@podium/client-graph/mobile-inbox-source'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { MobxPool } from '@podium/client-graph/pool'
import { asUserId } from '@podium/model'
import type { PodiumTarget } from '@podium/protocol'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { Linking } from 'react-native'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MobilePool } from './mobile-pool'
import { createInboxFixture } from '../../test/inbox-fixture'
import { AuthStatusContext } from './auth-context'
import { buildScreeningQueue, reconcileScreeningOrder } from '../lib/screening'
import { followPodiumLink, mobilePodiumRoute, setActivePodiumOrigin, setPodiumTargetActivator } from '../lib/podium-link'
import { captureMobileHandoffUrl, markPendingMobileHandoffProfileSelected, pendingMobileHandoffSnapshot, retirePendingMobileHandoff } from './mobile-handoff'

const state = vi.hoisted(() => ({ host: undefined as MobilePool | undefined,
  router: { push: vi.fn(), replace: vi.fn(), canGoBack: () => true, back: vi.fn() },
  profile: { id: 'synthetic', httpOrigin: 'http://offline.invalid', instanceId: 'synthetic', userId: 'operator' } }))
vi.mock('./mobile-pool', async original => {
  const real = await original<typeof import('./mobile-pool')>()
  return { ...real, mobileDataLayer: () => state.host?.layer() ?? 'legacy', useMobilePool: () => state.host!.host.usePool(),
    useMobilePoolProjection: <T,>(...args: Parameters<MobilePool['host']['usePoolProjection']>) => state.host!.host.usePoolProjection(...args) as T }
})
vi.mock('expo-router', () => ({ useRouter: () => state.router, useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]) }))
vi.mock('./server-profile-context', () => ({ useServerProfile: () => ({ profile: state.profile, profiles: [state.profile], activation: 'verified' }) }))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 72 }))
vi.mock('../components/Screen', () => ({ Screen: ({ children, right, title, subtitle }: { children: ReactNode; right: ReactNode; title: string; subtitle: string }) => <section><h1>{title}</h1><p>{subtitle}</p>{right}{children}</section>,
  HeaderButton: ({ children, label, onPress }: { children: ReactNode; label: string; onPress: () => void }) => <button aria-label={label} onClick={onPress}>{children}</button> }))
vi.mock('../components/Icon', () => ({ Icon: () => null }))
vi.mock('../components/NewWorkButton', () => ({ NewWorkButton: () => null }))
vi.mock('../components/StorageNoticeAlert', () => ({ StorageNoticeAlert: () => null }))
vi.mock('../components/RefreshOffer', () => ({ RefreshOffer: () => null }))
vi.mock('../components/LaunchPlaceholders', () => ({ BootstrapCrossfade: ({ children, resolved }: { children: ReactNode; resolved: boolean }) => resolved ? children : <p>Loading inbox</p>, WorkSkeleton: () => null }))
vi.mock('../components/ScreeningCard', () => ({ ScreeningCard: ({ issue, parent }: { issue: { title: string; description: string; brief: string; blockedByNotes: unknown[]; childCount: number }; parent?: { title: string } }) =>
  <article data-testid="screening-card">{issue.title} · {issue.description} · {issue.brief} · {issue.blockedByNotes.length} blocked · {issue.childCount} children · {parent?.title}</article> }))

const { InboxScreen } = await import('../screens/InboxScreen')
const { ProposalScreeningScreen } = await import('../screens/ProposalScreeningScreen')
const { RefChip } = await import('../components/RefChip')
const { PodiumLinkHost } = await import('../components/PodiumLinkHost')
const { usePulseFeed, resetPulseCache } = await import('../screens/usePulseFeed')
const { createMobilePool, useMobilePool } = await import('./mobile-pool')
const { reconcileScreeningIds } = await import('./use-inbox-data')

const NOW = Date.parse('2026-10-03T00:00:00Z')
const targets: PodiumTarget[] = [{ kind: 'issue', issue: 'SYN-1000' }, { kind: 'issue', issue: 'synthetic-1' },
  { kind: 'session', session: 'SYN-1000-A' }, { kind: 'session', session: 'synthetic-session-7' }, { kind: 'issue', issue: 'SYN-9999' }]
const tokens = [{ token: 'SYN-1000', kind: 'issue' as const, prefix: 'SYN' }, { token: 'SYN-1018', kind: 'issue' as const, prefix: 'SYN' },
  { token: 'SYN-9999', kind: 'issue' as const, prefix: 'SYN' }, { token: 'SYN-1000-A', kind: 'session' as const, prefix: 'SYN' },
  { token: 'UTF-8', kind: 'issue' as const, prefix: 'UTF' }]
function PulseProbe() {
  const data = usePulseFeed()
  return <output data-testid="pulse">{JSON.stringify({ machines: data.machines, hosts: data.hosts, quota: data.quota, buckets: data.buckets, history: data.history })}</output>
}
function Screens() { return <><InboxScreen /><ProposalScreeningScreen />{tokens.map(token => <RefChip key={token.token} token={token.token} prefix={token.prefix} refKind={token.kind} />)}<PulseProbe /><PodiumLinkHost /></> }

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW); state.router.push.mockClear(); state.router.replace.mockClear(); resetPulseCache(); storeStats.enable(); storeStats.reset() })
afterEach(() => { cleanup(); retirePendingMobileHandoff(); vi.restoreAllMocks(); storeStats.enable(false) })

async function mount(on: boolean, children: ReactNode = <Screens />) {
  const data = createInboxFixture(), seen: (MobxPool | null)[] = [], errors: string[] = []
  state.host = createMobilePool(false, () => ({ get: () => undefined, device: () => on }))
  let runtime!: ClientRuntime, pool: MobxPool | null = null
  function Surface() {
    runtime = useStoreHandle() as ClientRuntime
    state.host!.initialize(runtime.ui)
    pool = useMobilePool(); seen.push(pool)
    return <>{children}</>
  }
  const view = render(<AuthStatusContext.Provider value={{ authed: true, userId: 'operator', needsAuth: true } as never}>
    <StoreProvider principal={asClientPrincipal(asUserId('operator'))} config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={data.api} createReplicaFn={() => data.newReplica()} networkEnabled={false} routerWindow={createMemoryRouterWindow()}
      onFatalError={error => errors.push(error)} attachRuntime={owner => { data.bindHub(owner.hub); return state.host!.host.attach(owner, error => errors.push(error.message)) }}>
      <Surface />
    </StoreProvider></AuthStatusContext.Provider>)
  await waitFor(() => expect(runtime).toBeTruthy())
  if (on) await waitFor(() => expect(pool && mobileInboxViews(pool)).toBeTruthy(), { timeout: 10000 })
  await act(async () => { data.publishMachines(); data.publishMetrics(0) })
  return { data, view, get runtime() { return runtime }, get pool() { return pool! }, seen, errors }
}
async function painted(app: Awaited<ReturnType<typeof mount>>) {
  await waitFor(() => { expect(app.view.getByTestId('screening-card').textContent).toContain('Summary 2'); expect(app.view.container.textContent).toContain('Synthetic agent 0') })
  await waitFor(() => expect(app.view.getByTestId('pulse').textContent).toContain('Host 1'))
  await waitFor(() => expect(app.view.container.querySelector('[aria-label*="SYN-1018"]')).toBeTruthy())
}
function legacy(app: Awaited<ReturnType<typeof mount>>) {
  const snapshot = app.runtime.getSnapshot(), issues = allIssueViewModels(snapshot.replica, snapshot.issueProjections, snapshot.issueUserStates)
  return { issues, sessions: snapshot.sessions, queue: buildScreeningQueue(issues).map(issue => issue.id), booting: false,
    outboxSize: snapshot.outboxSize, routes: targets.map(target => mobilePodiumRoute(target, { issues, sessions: snapshot.sessions })) }
}

it('preserves rendered phone inbox, proposal, pulse and reference values through real pool attachment', async () => {
  const off = await mount(false); await painted(off)
  const expected = off.view.container.innerHTML; off.view.unmount()
  const on = await mount(true); await painted(on)
  await waitFor(() => expect(on.view.container.innerHTML).toBe(expected))
  expect(on.seen[0]).toBeNull(); expect(on.seen.some(pool => pool !== null)).toBe(true)
  expect(on.errors).toEqual([])
})

it('has zero legacy selectors and issue derivations at mount and on relevant updates, with an active off control', async () => {
  const on = await mount(true); await painted(on)
  expect(readRuntimeStoreStats(on.runtime)?.selectorRuns ?? 0).toBe(0)
  expect(readRuntimeStoreStats(on.runtime)?.rowBuilds ?? 0).toBe(0)
  expect(Object.values(readRuntimeStoreStats(on.runtime)?.slices ?? {}).reduce((a, b) => a + b, 0)).toBe(0)
  await act(async () => { on.data.activity(2); on.data.publishMetrics(1); on.data.patch('issueProjection', 'synthetic-0', { title: 'Updated inbox task' }) })
  await waitFor(() => expect(on.view.container.textContent).toContain('Updated inbox task'))
  expect(readRuntimeStoreStats(on.runtime)?.selectorRuns ?? 0).toBe(0)
  expect(readRuntimeStoreStats(on.runtime)?.rowBuilds ?? 0).toBe(0)
  on.view.unmount(); storeStats.reset()
  const off = await mount(false); await painted(off)
  expect(readRuntimeStoreStats(off.runtime)?.selectorRuns ?? 0).toBeGreaterThan(0)
  expect(readRuntimeStoreStats(off.runtime)?.rowBuilds ?? 0).toBeGreaterThan(0)
})

it('compares every card, triage bucket, screening ancestor and addressed route using the sidebar pattern', async () => {
  const app = await mount(true); await painted(app)
  const input = { now: NOW, tokens, targets, screeningIds: ['synthetic-0', 'synthetic-1', 'synthetic-2', 'synthetic-3'] }
  await waitFor(() => expect(checkMobileInbox(app.pool, legacy(app), input)).toMatchObject({ differences: 0, pending: 0, first: null }))
  const expected = legacy(app)
  expected.issues.find(issue => issue.id === 'synthetic-0')!.title = 'Planted comparison error'
  const red = checkMobileInbox(app.pool, expected, input)
  expect(red.differences).toBeGreaterThan(0)
  expect(red.first).toBeTruthy()
})

it('keeps decided deck order and retry lookup when proposals are promoted or arrive', async () => {
  const app = await mount(true); await painted(app)
  await act(async () => fireEvent.click(app.view.getByLabelText('Skip')))
  await waitFor(() => expect(app.view.getByTestId('screening-card').textContent).toContain('Summary 0'))
  await act(async () => app.data.patch('issueProjection', 'synthetic-0', { stage: 'backlog' }))
  await waitFor(() => expect(app.view.getByTestId('screening-card').textContent).toContain('Summary 1'))
  const issues = legacy(app).issues, order = ['synthetic-2', 'synthetic-0', 'synthetic-1'] as never[], index = 1
  expect(reconcileScreeningIds(order, index, buildScreeningQueue(issues).map(issue => issue.id))).toEqual(reconcileScreeningOrder(order, index, issues))
})

it('reads cold refs through one batched reader and shares prefix work across retained chips', async () => {
  const app = await mount(true, <><RefChip token="SYN-1018" refKind="issue" prefix="SYN" /><RefChip token="UTF-8" refKind="issue" prefix="UTF" /></>)
  const source = await app.pool.sources.ensure(MOBILE_INBOX_SOURCE_KEY, MOBILE_INBOX_ENTITIES, () => { throw new Error('Second source') })
  const views = mobileInboxViews(app.pool)!
  const one = createPoolProjection(app.pool, () => views.chip('SYN-1018', 'issue', 'SYN'))
  const wakes = vi.fn(), stop = one.subscribe(wakes)
  await waitFor(() => expect(one.getSnapshot().model?.availability).toBe('archived'))
  const batches = (source as unknown as { counts: { prefixReads: number } }).counts.prefixReads
  const many = Array.from({ length: 40 }, () => createPoolProjection(app.pool, () => views.chip('SYN-1018', 'issue', 'SYN')))
  const stops = many.map(view => view.subscribe(() => {}))
  for (const view of many) expect(view.getSnapshot()).toEqual(one.getSnapshot())
  expect((source as unknown as { counts: { prefixReads: number } }).counts.prefixReads).toBe(batches)
  wakes.mockClear()
  await act(async () => app.data.patch('issueProjection', 'synthetic-7', { title: 'Unrelated task' }))
  expect(wakes).not.toHaveBeenCalled()
  await act(async () => app.data.patch('issueProjection', 'synthetic-18', { title: 'Changed cold reference' }))
  await waitFor(() => expect(one.getSnapshot().model?.title).toBe('Changed cold reference'))
  expect(views.chip('UTF-8', 'issue', 'UTF').known).toBe(false)
  stop(); for (const stop of stops) stop()
})

it('routes issue and permanent session references and preserves scoped handoff decisions', async () => {
  const app = await mount(true, <PodiumLinkHost />)
  followPodiumLink('podium://issues/SYN-1018')
  await waitFor(() => expect(state.router.push).toHaveBeenCalledWith('/issue/synthetic-18'))
  followPodiumLink('podium://sessions/SYN-1000-A')
  await waitFor(() => expect(state.router.push).toHaveBeenCalledWith('/session/synthetic-session-0'))
  act(() => { captureMobileHandoffUrl('podium://sessions/synthetic-session-7?origin=http%3A%2F%2Foffline.invalid&instance=synthetic'); markPendingMobileHandoffProfileSelected(pendingMobileHandoffSnapshot().id) })
  await waitFor(() => expect(state.router.replace).toHaveBeenCalledWith('/session/synthetic-session-7'))
  expect(app.errors).toEqual([])
})

it('updates pulse machines and streamed health without rebuilding quota polling for unrelated rows', async () => {
  const app = await mount(true, <PulseProbe />)
  await waitFor(() => expect(app.view.getByTestId('pulse').textContent).toContain('Host 1'))
  const quota = vi.spyOn(app.data.api.quota.summary, 'query'), history = vi.spyOn((app.data.api.quota as never as { history: { query: () => Promise<unknown[]> } }).history, 'query')
  await act(async () => { app.data.activity(1); app.data.publishMetrics(2) })
  expect(quota).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled()
  expect(readRuntimeStoreStats(app.runtime)?.selectorRuns ?? 0).toBe(0)
  expect(app.errors).toEqual([])
})

it('coalesces readiness loads and releases the existing cursor subscription on disposal', async () => {
  const app = await mount(true, null)
  let cursor: number | null = null, publish = () => {}, stopped = 0
  const source = new MobileInboxSource({ replica: { getCursor: () => cursor } as never,
    subscribe: callback => { publish = callback; return () => { stopped++ } } }, app.pool)
  expect(source.read('mobileInboxState', 'state')).toBe(LOADING)
  expect(source.read('mobileInboxState', 'state')).toBe(LOADING)
  await act(async () => { await Promise.resolve() })
  expect(source.counts.batches).toBe(1)
  expect(source.read('mobileInboxState', 'state')).toEqual({ hasCursor: false })
  cursor = 7
  await act(async () => { publish(); publish() })
  expect(source.counts.batches).toBe(2)
  expect(source.read('mobileInboxState', 'state')).toEqual({ hasCursor: true })
  publish(); source.dispose()
  await act(async () => { await Promise.resolve() })
  expect(stopped).toBe(1); expect(source.counts.batches).toBe(2)
  expect(source.read('mobileInboxState', 'state')).toBe(LOADING)
})

it('shows the original outbox pending count and optimistically renamed card', async () => {
  const app = await mount(true); await painted(app)
  let finish = () => {}
  vi.spyOn((app.data.api as never as { issues: { update: { mutate: () => Promise<void> } } }).issues.update, 'mutate')
    .mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await act(async () => { void app.runtime.getSnapshot().updateIssue('synthetic-2', { title: 'Pending inbox rename' }) })
  await waitFor(() => expect(app.view.container.textContent).toContain('1 queued'))
  expect(app.view.getByTestId('screening-card').textContent).toContain('Pending inbox rename')
  expect(mobileInboxViews(app.pool)!.inbox().outboxSize).toBe(app.runtime.getSnapshot().outboxSize)
  await act(async () => { finish() })
})

it('keeps the switch-off link activator synchronous with the same single OS fallback', () => {
  const open = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  setActivePodiumOrigin('http://offline.invalid')
  setPodiumTargetActivator(() => false)
  followPodiumLink('podium://issues/SYN-9999')
  expect(open).toHaveBeenCalledTimes(1)
  expect(open).toHaveBeenCalledWith('http://offline.invalid/issues/SYN-9999')
  setPodiumTargetActivator(() => true)
  followPodiumLink('podium://issues/SYN-1000')
  expect(open).toHaveBeenCalledTimes(1)
  setPodiumTargetActivator(null); setActivePodiumOrigin(null)
})

it('defers the cold not-found OS fallback until the addressed lookup settles and opens it once', async () => {
  const app = await mount(true, <PodiumLinkHost />)
  const open = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  followPodiumLink('podium://issues/SYN-9999')
  expect(open).not.toHaveBeenCalled()
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
  expect(open).toHaveBeenCalledWith('http://offline.invalid/issues/SYN-9999')
  await act(async () => { app.data.activity(1) })
  expect(open).toHaveBeenCalledTimes(1)
})

it('holds an early reference tap through null-to-pool attachment without opening the OS', async () => {
  const open = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  function FirstTap() {
    useEffect(() => { followPodiumLink('podium://issues/SYN-1018') }, [])
    return <PodiumLinkHost />
  }
  const app = await mount(true, <FirstTap />)
  expect(app.seen[0]).toBeNull()
  await waitFor(() => expect(state.router.push).toHaveBeenCalledWith('/issue/synthetic-18'))
  expect(open).not.toHaveBeenCalled()
})
