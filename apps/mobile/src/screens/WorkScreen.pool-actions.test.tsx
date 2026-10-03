/** Real native WorkScreen/menu, provider-owned runtime, kernel replica and
 * optimistic outbox. Only platform chrome and sheet animation are replaced. */
import { createEngineOutbox, type ClientRuntime, type OutboxOutcome } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { allIssueViewModels } from '@podium/client-core/replica'
import { planReorderKeys } from '@podium/client-core/viewmodels'
import { legacyDerivationFromStore } from '@podium/client-graph/diagnostics/legacy'
import type { MobxPool } from '@podium/client-graph/pool'
import type { MobileWorkSection } from '@podium/client-graph/worklist/mobile'
import { asUserId, issueStatusMenuEntries, parseIssueStatusValue, spreadSortKeys } from '@podium/model'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { checkMobile } from '../../../../packages/worklist-proto/harness/src/oracle/mobile'
import { createSidebarActionsFixture } from '../../../web/test/sidebar-actions-fixture'
import type { MobilePool } from '../client/mobile-pool'
import { WorkIssueMenu } from '../components/WorkIssueMenu'
import { resolvePoolWorkMenu, type PoolWorkMenuData } from '../lib/pool-work-menu'

const state = vi.hoisted(() => ({ host: null as MobilePool | null, pool: null as MobxPool | null,
  diagnostic: false, errors: [] as string[], sections: [] as readonly MobileWorkSection[] }))
const router = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useRouter: () => router, Stack: { SearchBar: () => null },
    useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }
})
vi.mock('../client/mobile-pool', async original => {
  const real = await original<typeof import('../client/mobile-pool')>()
  return { ...real, mobileDataLayer: () => state.host!.layer(),
    useMobilePool: () => { state.pool = state.host!.host.usePool(); return state.pool },
    useMobilePoolProjection: (read: never, empty: never) => state.host!.host.usePoolProjection(read, empty) }
})
vi.mock('@podium/client-core/react', async original => {
  const real = await original<typeof import('@podium/client-core/react')>()
  const forbidden = () => { throw new Error('mobile pool action subscribed to a legacy list') }
  return { ...real, useSlice: forbidden, useAllIssueViewModels: forbidden, useSessionViews: forbidden }
})
vi.mock('@podium/client-core/viewmodels', async original => {
  const real = await original<typeof import('@podium/client-core/viewmodels')>()
  const guard = <T extends (...args: never[]) => unknown>(fn: T): T => ((...args: never[]) => {
    if (!state.diagnostic) throw new Error('mobile pool action called a legacy row derivation')
    return fn(...args)
  }) as T
  return { ...real, rowMotionPhase: guard(real.rowMotionPhase), rowHasWorkingSession: guard(real.rowHasWorkingSession),
    rowWaitingCount: guard(real.rowWaitingCount), rowPendingDecision: guard(real.rowPendingDecision),
    rowUnreadEmphasized: guard(real.rowUnreadEmphasized), isDraftAgentVessel: guard(real.isDraftAgentVessel),
    deriveFleetPresence: guard(real.deriveFleetPresence) }
})
vi.mock('react-native', async original => {
  const real = await original<typeof import('react-native')>()
  const { createElement } = await import('react')
  return { ...real, SectionList: (props: { sections: readonly MobileWorkSection[] }) => {
    state.sections = props.sections
    return createElement(real.SectionList, props as never)
  } }
})
vi.mock('../components/PressableScale', () => ({ PressableScale: ({ children, accessibilityLabel, accessibilityRole,
  onPress, onLongPress, disabled, ...props }: { children: ReactNode; accessibilityLabel?: string;
  accessibilityRole?: string; onPress?: () => void; onLongPress?: () => void; disabled?: boolean }) =>
  <button type="button" aria-label={accessibilityLabel} disabled={disabled} onClick={onPress} onContextMenu={onLongPress}
    {...('aria-expanded' in props ? { 'aria-expanded': props['aria-expanded'] as boolean } : {})}>{children}</button> }))
vi.mock('../components/BottomSheet', async () => {
  const { useEffect, useRef } = await import('react')
  return { BottomSheet: ({ visible, head, footer, children, onClose, testID }: { visible: boolean; head: ReactNode;
    footer: ReactNode; children: ReactNode; onClose: () => void; testID?: string }) => {
    const before = useRef(visible)
    useEffect(() => { if (before.current && !visible) onClose(); before.current = visible }, [onClose, visible])
    return visible ? <div data-testid={testID}>{head}{children}{footer}</div> : null
  } }
})
vi.mock('../components/Screen', () => ({ Screen: ({ title, subtitle, right, children }: { title: string; subtitle: ReactNode;
  right: ReactNode; children: ReactNode }) => <div>{title}{subtitle}{right}{children}</div>,
  HeaderButton: ({ children, label, onPress }: { children: ReactNode; label: string; onPress: () => void }) =>
    <button type="button" aria-label={label} onClick={onPress}>{children}</button> }))
vi.mock('../components/LaunchPlaceholders', () => ({ BootstrapCrossfade: ({ resolved, children }: {
  resolved: boolean; children: ReactNode }) => <div data-resolved={resolved}>{children}</div>, WorkSkeleton: () => null }))
vi.mock('../components/StorageNoticeAlert', () => ({ StorageNoticeAlert: () => null }))
vi.mock('../components/RefreshOffer', () => ({ RefreshOffer: () => null }))
vi.mock('../components/WorkspaceContinuityNotice', () => ({ WorkspaceContinuityNotice: () => null }))
vi.mock('../components/PullToRefreshBoundary', () => ({ PullToRefreshBoundary: ({ children }: { children: ReactNode }) => children }))
vi.mock('../components/NewWorkButton', () => ({ NewWorkButton: () => null }))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 0 }))
vi.mock('../hooks/useMinimizeTabBarOnScroll', () => ({ useMinimizeTabBarOnScroll: () => ({}) }))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('../hooks/useRefreshableTab', async () => {
  const { useRef } = await import('react')
  return { useRefreshableTab: () => ({ listRef: useRef(null), refreshAccessibilityProps: {}, connected: true,
    refreshing: false, onRefresh: () => {} }) }
})
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, ImpactFeedbackStyle: { Light: 'light' } }))
vi.stubEnv('EXPO_OS', 'web')
const { createMobilePool } = await import('../client/mobile-pool')
const { WorkScreen } = await import('./WorkScreen')

const NOW = Date.parse('2026-10-03T08:00:00Z')
const TARGET = 'synthetic-3'
const iso = (offset: number) => new Date(NOW + offset).toISOString()
type Fixture = ReturnType<typeof createSidebarActionsFixture>
type Request = { procedure: string; input: Record<string, unknown>; resolve: (value: unknown) => void;
  reject: (error: unknown) => void; settled?: boolean }
let runtime: ClientRuntime
let requests: Request[] = []
let outcomes: OutboxOutcome[] = []
let comparisons = 0
function Capture() { runtime = useStoreHandle() as ClientRuntime; return null }

/** A nested/absent row can be addressed outside the native initial window.
 * The probe uses the same gesture resolver and the real menu, never store data. */
function MenuProbe({ id }: { id: string }) {
  const [menu, setMenu] = useState<PoolWorkMenuData | null>(null)
  const pool = state.host!.host.usePool()
  return <><button type="button" data-testid="menu-probe" onClick={() => pool && setMenu(resolvePoolWorkMenu(pool, id))}>Nested menu</button>
    {menu ? <WorkIssueMenu {...menu} onClose={() => setMenu(null)} /> : null}</>
}

async function mount(prepare?: (fixture: Fixture) => void, probeId?: string) {
  requests = []; outcomes = []; state.errors = []; state.diagnostic = false; router.push.mockClear()
  state.host = createMobilePool(false, () => ({ get: () => undefined, device: () => true }))
  state.host.initialize({} as Parameters<MobilePool['initialize']>[0])
  const fixture = createSidebarActionsFixture(6, NOW, true)
  prepare?.(fixture)
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const procedure = (name: string) => ({ mutate: (input: Record<string, unknown>) =>
    new Promise((resolve, reject) => requests.push({ procedure: name, input, resolve, reject })) })
  Object.assign(fixture.api, {
    issues: Object.fromEntries(['update', 'markRead', 'markUnread', 'setTucked', 'undefer', 'setPlacement', 'delete', 'close']
      .map(name => [name, procedure(`issues.${name}`)])),
    pins: { list: { query: async () => ({ panels: [], worktrees: [], repos: [] }) } },
    tabs: { listOrders: { query: async () => ({}) } }, layout: { get: { query: async () => [] } },
    superagent: { listThreads: { query: async () => [] } },
  })
  const view = render(<StoreProvider principal={asClientPrincipal(asUserId('sidebar-pool-actions'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }} api={fixture.api}
    createReplicaFn={() => fixture.replica} createOutboxFn={options => createEngineOutbox({ ...options, isOnline: () => true })}
    networkEnabled={false} onFatalError={message => { throw new Error(message) }}
    attachRuntime={owner => state.host!.host.attach(owner, cause => state.errors.push(cause.message))}>
    <Capture /><WorkScreen />{probeId ? <MenuProbe id={probeId} /> : null}
  </StoreProvider>)
  await act(async () => { await runtime.getSnapshot().refreshRepos() })
  await waitFor(() => expect(view.container.querySelector('[data-resolved="true"]')).not.toBeNull(), { timeout: 30_000 })
  runtime.subscribeOutboxOutcomes(outcome => outcomes.push(outcome))
  await parity()
  return fixture
}
function pool() { if (!state.pool) throw new Error('Pool not attached'); return state.pool }
function value(id = TARGET) {
  const row = pool().mobileWork.row({ kind: 'issue', id })
  if (!row || typeof row === 'symbol' || !row.sidebar) throw new Error(`Missing resident ${id}`)
  return row
}
function button(id = TARGET) { return screen.getByRole('button', { name: `${value(id).sidebar!.issue.displayRef} ${value(id).label}`, exact: true }) }
async function parity() {
  await act(async () => {
    for (let turn = 0; turn < 100; turn++) {
      pool().mobileWork.sections()
      if (!pool().hydrate()) break
    }
    await Promise.resolve()
  })
  state.diagnostic = true
  try {
    const result = checkMobile(pool(), legacyDerivationFromStore(runtime.getSnapshot(), pool().clock.current))
    expect(result.pending).toBe(0)
    expect(result.first, JSON.stringify(result.first)).toBeNull()
    expect(result.differences).toBe(0)
    comparisons++
  } finally { state.diagnostic = false }
  expect(state.errors).toEqual([])
}
async function request(procedure: string, id = TARGET) {
  await waitFor(() => expect(requests.some(write => !write.settled && write.procedure === procedure && write.input.id === id)).toBe(true))
  return requests.find(write => !write.settled && write.procedure === procedure && write.input.id === id)!
}
async function settle(write: Request, accepted = false) {
  const count = outcomes.length
  write.settled = true
  await act(async () => {
    if (accepted) write.resolve({ ok: true })
    else write.reject(Object.assign(new Error('Synthetic refusal'), { data: { code: 'BAD_REQUEST', httpStatus: 400 } }))
  })
  await waitFor(() => expect(outcomes.slice(count).some(outcome => outcome.type === (accepted ? 'applied' : 'rejected'))).toBe(true))
  await parity()
}
async function openMenu(id = TARGET) {
  fireEvent.contextMenu(button(id))
  await screen.findByRole('button', { name: 'Rename', exact: true })
}
async function choose(name: string) { fireEvent.click(await screen.findByRole('button', { name, exact: true })) }
async function patch(fixture: Fixture, id: string, fields: Record<string, unknown>) {
  await act(async () => { fixture.patchIssue(id, fields) })
  await parity()
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })
afterAll(() => { vi.unstubAllEnvs(); console.info('[mobile action parity]', comparisons, 'clean comparisons') })

describe('mobile pool work-list actions', () => {
  it('opens the mission before the deferred mark-read, then restores unread on refusal', async () => {
    await mount(f => f.patchIssue(TARGET, { readAt: null }))
    expect(value().unread).toBe(true)
    fireEvent.click(button())
    expect(router.push).toHaveBeenCalledWith(`/mission/${TARGET}`)
    expect(requests).toEqual([])
    const write = await request('issues.markRead')
    expect(write.input).toMatchObject({ id: TARGET, mutationId: expect.any(String) })
    expect(pool().readCursor(TARGET)).toBe(iso(0))
    expect(value().unread).toBe(false)
    await parity()
    await settle(write)
    expect(value().unread).toBe(true)
  })

  for (const kind of ['draft', 'worktree'] as const) it(`opens a ${kind} session through the current pool target`, async () => {
    await mount(f => {
      if (kind === 'draft') f.patchIssue(TARGET, { isDraftVessel: true, title: '', worktreePath: null })
      else f.patch('session', 'synthetic-session-3', { issueId: null })
    })
    fireEvent.click(kind === 'draft' ? button() : screen.getByRole('button', { name: /^Worktree / }))
    expect(router.push).toHaveBeenCalledWith({ pathname: '/session/[sessionId]',
      params: { sessionId: 'synthetic-session-3', backTo: '/work' } })
    expect(requests).toEqual([])
    await parity()
  })

  for (const unread of [true, false]) it(`menu marks ${unread ? 'read' : 'unread'} through the shared outbox and rolls back`, async () => {
    await mount(f => {
      f.patchIssue(TARGET, { readAt: unread ? null : iso(-3_600_000) })
      // Raw unread stays true even when working suppresses its painted badge.
      if (unread) f.patch('session', 'synthetic-session-3', { busy: true, agentState: { phase: 'working', since: iso(-60_000) } })
    })
    const before = value().sidebar!.issue.unread
    expect(before).toBe(unread)
    if (unread) expect(value().unread).toBe(false)
    await openMenu()
    await choose(unread ? 'Mark as read' : 'Mark as unread')
    const write = await request(unread ? 'issues.markRead' : 'issues.markUnread')
    expect(value().sidebar!.issue.unread).toBe(!unread)
    await parity()
    await settle(write)
    expect(value().sidebar!.issue.unread).toBe(unread)
  })

  it('tucks a completed row immediately, rolls back, and holds accepted tuck until echo', async () => {
    const fixture = await mount(f => f.patchIssue(TARGET, { stage: 'done', closedAt: iso(-600_000), closedReason: 'done' }))
    expect(value().tuckable).toBe(true)
    const label = button().getAttribute('aria-label')!
    await choose('Tuck Synthetic task 3 into Closed')
    const first = await request('issues.setTucked')
    expect(first.input).toMatchObject({ id: TARGET, tucked: true, mutationId: expect.any(String) })
    expect(screen.queryByRole('button', { name: label, exact: true })).toBeNull()
    expect(pool().mobileWork.sections().sections.some(section => section.closedIds.includes(TARGET))).toBe(true)
    await parity()
    await settle(first)
    expect(button()).toBeDefined()
    await choose('Tuck Synthetic task 3 into Closed')
    const second = await request('issues.setTucked')
    await settle(second, true)
    expect(value().sidebar!.issue.tuckedAt).toBe(iso(0))
    await patch(fixture, TARGET, { tuckedAt: iso(0) })
    expect(screen.queryByRole('button', { name: label, exact: true })).toBeNull()
  })

  it('brings a recent closed row back and returns it to Closed on refusal', async () => {
    await mount(f => f.patchIssue(TARGET, { stage: 'done', closedAt: iso(-600_000), closedReason: 'done', tuckedAt: iso(-300_000) }))
    await choose('Show closed · 1')
    fireEvent.contextMenu(button())
    await choose('Bring back from Closed')
    const write = await request('issues.setTucked')
    expect(write.input).toMatchObject({ tucked: false })
    expect(value().sidebar!.issue.tuckedAt).toBeNull()
    expect(value().tuckable).toBe(true)
    await parity()
    await settle(write)
    expect(pool().mobileWork.sections().sections.some(section => section.closedIds.includes(TARGET))).toBe(true)
  })

  it('keeps Bring back disabled for closures older than a day', async () => {
    await mount(f => f.patchIssue(TARGET, { stage: 'done', closedAt: iso(-172_800_000), closedReason: 'done', tuckedAt: iso(-300_000) }))
    await choose('Show closed · 1')
    fireEvent.contextMenu(button())
    const bringBack = await screen.findByRole('button', { name: 'Bring back from Closed', exact: true })
    expect((bringBack as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(bringBack)
    expect(requests).toEqual([])
    await parity()
  })

  it('unsnoozes through the fold menu and restores the snoozed lane on refusal', async () => {
    await mount(f => f.patchIssue(TARGET, { deferUntil: iso(3_600_000) }))
    await choose('Show snoozed · 1')
    fireEvent.contextMenu(button())
    await choose('Unsnooze')
    const write = await request('issues.undefer')
    expect(value().snoozed).toBe(false)
    expect(pool().mobileWork.sections().sections.some(section => section.data.some(row => row.id === TARGET))).toBe(true)
    await parity()
    await settle(write)
    expect(value().snoozed).toBe(true)
  })

  it('renames from the real prompt and keeps the earlier accepted write when a later rename refuses', async () => {
    const fixture = await mount()
    const rename = async (title: string) => {
      await openMenu(); await choose('Rename')
      fireEvent.change(await screen.findByRole('textbox', { name: 'Rename task' }), { target: { value: title } })
      await choose('Rename')
    }
    await rename('  First rename  ')
    const first = await request('issues.update')
    expect(first.input).toMatchObject({ patch: { title: 'First rename' } })
    expect(button().textContent).toContain('First rename')
    await settle(first, true)
    await rename('Second rename')
    const second = await request('issues.update')
    expect(value().label).toBe('Second rename')
    await parity(); await settle(second)
    expect(value().label).toBe('First rename')
    await patch(fixture, TARGET, { title: 'First rename' })
    expect(value().label).toBe('First rename')
  })

  for (const input of ['cancel', '   ', 'Synthetic task 3']) it(`rename ${JSON.stringify(input)} queues no write`, async () => {
    await mount(); await openMenu(); await choose('Rename')
    if (input !== 'cancel') fireEvent.change(await screen.findByRole('textbox', { name: 'Rename task' }), { target: { value: input } })
    await choose(input === 'cancel' ? 'Cancel' : 'Rename')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(value().label).toBe('Synthetic task 3')
    expect(requests).toEqual([])
    await parity()
  })

  it('changes stage with the existing update action and restores it on refusal', async () => {
    await mount(); await openMenu(); await choose('Set status'); await choose('Planning')
    const write = await request('issues.update')
    expect(write.input).toMatchObject({ patch: { stage: 'planning' } })
    expect(value().sidebar!.issue.stage).toBe('planning')
    await parity(); await settle(write)
    expect(value().sidebar!.issue.stage).toBe('in_progress')
  })

  for (const entry of issueStatusMenuEntries().filter(entry => entry.terminal)) it(`closes as ${entry.label} and restores on refusal`, async () => {
    await mount(); await openMenu(); await choose('Set status'); await choose(entry.label)
    const write = await request('issues.close')
    const intent = parseIssueStatusValue(entry.value)
    if (intent?.kind !== 'close') throw new Error('Expected a terminal status')
    expect(write.input).toMatchObject({ reason: intent.reason })
    expect(value().sidebar!.issue.stage).toBe('done')
    await parity(); await settle(write)
    expect(value().sidebar!.issue.stage).toBe('in_progress')
  })

  it('requires explicit close confirmation for active agents and open children', async () => {
    await mount(f => {
      f.patchIssue('synthetic-4', { parentId: TARGET })
      f.patch('session', 'synthetic-session-3', { busy: true, agentState: { phase: 'working', since: iso(-60_000) } })
    })
    await openMenu(); await choose('Set status'); await choose('Done')
    await screen.findByText('1 open sub-task')
    expect(screen.getByText('1 agent is still working')).toBeDefined()
    expect(requests).toEqual([])
    await choose('Close anyway')
    const write = await request('issues.close')
    await parity(); await settle(write)
    expect(value().sidebar!.issue.stage).toBe('in_progress')
  })

  for (const color of ['green', null] as const) it(`sets colour ${color ?? 'none'} and restores on refusal`, async () => {
    await mount(f => f.patchIssue(TARGET, { color: 'blue' }))
    await openMenu(); await choose('Set colour'); await choose(color ?? 'No colour')
    const write = await request('issues.update')
    expect(write.input).toMatchObject({ patch: { color } })
    expect(value().color).toBe(color)
    await parity(); await settle(write)
    expect(value().color).toBe('blue')
  })

  for (const placement of ['own', 'mission'] as const) it(`moves placement to ${placement} and rolls back the native bands`, async () => {
    await mount(f => {
      f.patchIssue(TARGET, { parentId: placement === 'own' ? 'synthetic-1' : null })
      if (placement === 'mission') {
        const record = { entity: 'issueDep', entityId: 'origin-edge', provenance: { seq: 1 },
          value: { id: 'origin-edge', fromId: TARGET, toId: 'synthetic-1', type: 'discovered-from' } }
        f.records.set('issueDep:origin-edge', record)
        f.replica.onKernelEvent({ type: 'upserted', record, readmitted: false })
      }
    }, TARGET)
    fireEvent.click(screen.getByTestId('menu-probe'))
    await choose(placement === 'own' ? 'Move to top level (out of SYN-1001)' : 'Move into SYN-1001')
    const write = await request('issues.setPlacement')
    expect(write.input).toMatchObject({ placement, originId: 'synthetic-1' })
    expect(value().sidebar!.issue.parentId ?? null).toBe(placement === 'own' ? null : 'synthetic-1')
    await parity(); await settle(write)
    expect(value().sidebar!.issue.parentId ?? null).toBe(placement === 'own' ? 'synthetic-1' : null)
  })

  it('delete confirms the raw non-shell cascade count and restores the row on refusal', async () => {
    await mount(f => {
      f.patch('session', 'synthetic-session-4', { issueId: TARGET, archived: true })
      f.patch('session', 'synthetic-session-5', { issueId: TARGET, agentKind: 'shell' })
    })
    const menu = resolvePoolWorkMenu(pool(), TARGET)!
    state.diagnostic = true
    try {
      expect(menu.target.issue.memberSessionIds).toEqual(allIssueViewModels(runtime.replica,
        runtime.getSnapshot().issueProjections, runtime.getSnapshot().issueUserStates).find(issue => issue.id === TARGET)!.memberSessionIds)
    } finally { state.diagnostic = false }
    expect(menu.target.issue.memberSessionIds).toEqual(['synthetic-session-3', 'synthetic-session-4'])
    await openMenu(); await choose('Delete…')
    expect(requests).toEqual([])
    expect(await screen.findByText(/2 agents/)).toBeDefined()
    await choose('Delete')
    const write = await request('issues.delete')
    expect(pool().mobileWork.sections().sections.every(section => section.data.every(row => row.id !== TARGET))).toBe(true)
    await parity(); await settle(write)
    expect(button()).toBeDefined()
  })

  for (const scope of ['project', 'pinned'] as const) for (const keyed of [true, false]) it(`reorders ${keyed ? 'keyed' : 'unkeyed'} ${scope} scope and rolls back every sort-key write`, async () => {
    await mount(f => {
      const keys = spreadSortKeys(6)
      for (let index = 0; index < keys.length; index++) f.patchIssue(`synthetic-${index}`,
        { sortKey: keyed ? keys[index] : null, pinned: scope === 'pinned' })
      f.patch('session', 'synthetic-session-1', { agentState: { phase: 'waiting', since: iso(-60_000),
        waiting: { kind: 'permission' } } })
    })
    const split = pool().mobileWork.sections()
    expect(split.sections.some(section => section.kind === 'attention')).toBe(true)
    const ordering = split.orderingSections.find(section => section.kind === scope)!
    expect(ordering.data.some(row => row.id === 'synthetic-1')).toBe(true)
    expect(split.orderingSections.every(section => section.kind !== 'attention')).toBe(true)
    const before = ordering.data.map(ref => ref.id)
    const moving = before.at(-1)!
    const patches = planReorderKeys([moving, ...before.filter(id => id !== moving)], moving,
      id => value(id).sidebar!.issue.sortKey)
    expect(patches.length).toBeGreaterThan(0)
    await act(async () => { await Promise.all(patches.map(({ id, ...fields }) => runtime.getSnapshot().updateIssue(id, fields))) })
    expect(pool().mobileWork.sections().orderingSections.find(section => section.key === ordering.key)!.data[0]!.id).toBe(moving)
    await parity()
    for (const changed of patches) await settle(await request('issues.update', changed.id))
    expect(pool().mobileWork.sections().orderingSections.find(section => section.key === ordering.key)!.data.map(ref => ref.id)).toEqual(before)
  })

  it('loading and absent menu targets never open a menu or mutate, and loads batch', async () => {
    let loads: ReturnType<typeof vi.spyOn>
    await mount(f => {
      f.patchIssue('synthetic-5', { archived: true, stage: 'done', closedAt: iso(-172_800_000) })
      f.patch('session', 'synthetic-session-5', { archived: true })
      loads = vi.spyOn(f.replica, 'row')
    }, 'synthetic-5')
    loads!.mockClear()
    expect(pool().tables.issue.has('synthetic-5')).toBe(false)
    fireEvent.click(screen.getByTestId('menu-probe'))
    fireEvent.click(screen.getByTestId('menu-probe'))
    expect(screen.queryByRole('button', { name: 'Rename', exact: true })).toBeNull()
    expect(requests).toEqual([])
    await act(async () => { pool().hydrate() })
    expect(loads!.mock.calls.filter(([kind, id]) => kind === 'issueProjections' && id === 'synthetic-5')).toHaveLength(1)
    expect(resolvePoolWorkMenu(pool(), 'absent')).toBeNull()
    expect(requests).toEqual([])
    await parity()
  })
})
