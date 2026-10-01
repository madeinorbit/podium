import {
  type ClientRuntime,
  createEngineOutbox,
  type OutboxOutcome,
} from '@podium/client-core/engine'
import { beginSwitch } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { allIssueViewModels } from '@podium/client-core/replica'
import {
  missionIssueIds,
  missionRootFor,
  pickPaneSession,
  planReorderKeys,
  sessionsForIssueNav,
  worklistSlice,
} from '@podium/client-core/viewmodels'
import { LOADING, type MobxPool } from '@podium/client-graph'
import { checkSidebar } from '@podium/client-graph/diagnostics/sidebar-check'
import { spreadSortKeys } from '@podium/model'
import { asIssueId, asSessionId, asUserId } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OperatorFocusProvider, useOperatorFocus } from '@/app/operator-focus'
import { attachWorklistPool, useWorklistPool } from '@/app/store-worklist-pool'
import { IssueContextMenu } from '@/features/issues/IssueContextMenu'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { createSidebarActionsFixture } from '../../../test/sidebar-actions-fixture'
import { SidebarUnified } from './SidebarUnified'
import {
  createPoolWorkActions,
  type PoolWorkActions,
  usePoolUnifiedWork,
} from './use-pool-unified-work'
import type { useRowDrag } from './useRowDrag'

const drag = vi.hoisted(() => ({ options: null as Parameters<typeof useRowDrag>[0] | null }))
const features = vi.hoisted(() => ({ handoff: false }))
vi.mock('@/lib/use-feature', async (original) => ({
  ...(await original<typeof import('@/lib/use-feature')>()),
  useFeature: (id: string) => id === 'session-handoff' && features.handoff,
}))
vi.mock('./useRowDrag', async (original) => {
  const module = await original<typeof import('./useRowDrag')>()
  return {
    ...module,
    useRowDrag: (options: Parameters<typeof useRowDrag>[0]) => {
      drag.options = options
      return module.useRowDrag(options)
    },
  }
})

vi.mock('@/lib/sidebar-data-layer', () => ({
  sidebarDataLayer: () => 'pool',
  initializeSidebarDataLayer: () => {},
  sidebarCheckRequested: () => false,
}))
vi.mock('@/app/store', async (original) => {
  const module = await original<typeof import('@/app/store')>()
  return {
    ...module,
    useSlice: (definition: Parameters<typeof module.useSlice>[0]) => {
      if (definition === worklistSlice) throw new Error('Pool action read worklistSlice')
      return module.useSlice(definition)
    },
  }
})
vi.mock('@podium/client-core/perf', async (original) => ({
  ...(await original<typeof import('@podium/client-core/perf')>()),
  beginSwitch: vi.fn(),
}))
vi.mock('@/lib/nativeDesktop', async (original) => ({
  ...(await original<typeof import('@/lib/nativeDesktop')>()),
  isMacNativeShell: () => true,
}))
vi.mock('@/features/mobile-handoff/MobilePromoCard', () => ({ MobilePromoCard: () => null }))

const NOW = Date.parse('2026-10-01T08:00:00Z')
const ROOT = '/synthetic/project'
const TARGET = 'synthetic-11'
type Fixture = ReturnType<typeof createSidebarActionsFixture>
type Request = {
  procedure: string
  input: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  settled?: boolean
}
let runtime: ClientRuntime
let pool: MobxPool | null
let actions: PoolWorkActions
let focused: string | null
let requests: Request[]
let outcomes: OutboxOutcome[]

function Capture() {
  runtime = useStoreHandle() as ClientRuntime
  pool = useWorklistPool()
  focused = useOperatorFocus().focusedIssueId
  return pool ? <CaptureActions pool={pool} /> : null
}
function CaptureActions({ pool: owner }: { pool: MobxPool }) {
  actions = usePoolUnifiedWork(owner)
  return null
}
function PoolMenuProbe({ id }: { id: string }) {
  const [data, setData] = useState<ReturnType<PoolWorkActions['resolveMenuData']> | null>(null)
  return <>
    <button data-testid="pool-menu-probe" onClick={() => setData(actions.resolveMenuData(id))}>Open nested task menu</button>
    {data && <IssueContextMenu issues={data.single} allIssues={data.all} surface="sidebar"
      anchor={{ x: 40, y: 60 }} onClose={() => setData(null)} onOpen={actions.openIssuePage} />}
  </>
}

async function mount(prepare?: (fixture: Fixture) => void, count = 12, probeId?: string) {
  const fixture = createSidebarActionsFixture(count, NOW)
  prepare?.(fixture)
  const procedure = (name: string) => ({
    mutate: (input: Record<string, unknown>) =>
      new Promise((resolve, reject) => requests.push({ procedure: name, input, resolve, reject })),
  })
  Object.assign(fixture.api, {
    issues: Object.fromEntries(
      [
        'update',
        'archive',
        'delete',
        'setTucked',
        'markRead',
        'markUnread',
        'defer',
        'undefer',
        'setLabels',
        'setPlacement',
        'close',
        'restore',
        'duplicate',
        'start',
        'assignAgent',
      ].map((name) => [name, procedure(`issues.${name}`)]),
    ),
    sessions: { markRead: procedure('sessions.markRead'), handoff: procedure('sessions.handoff') },
    pins: { set: { mutate: async () => ({ panels: [], worktrees: [], repos: [] }) } },
    tabs: { setOrder: { mutate: async () => ({}) } },
    layout: { set: { mutate: async () => ({}) }, clear: { mutate: async () => ({}) } },
  })
  render(
    <StoreProvider
      principal={asClientPrincipal(asUserId('sidebar-pool-actions'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={fixture.api}
      createReplicaFn={() => fixture.replica}
      // Only the synthetic procedure promises are online. No hub/feed/network.
      createOutboxFn={(options) => createEngineOutbox({ ...options, isOnline: () => true })}
      networkEnabled={false}
      onFatalError={(message) => {
        throw new Error(message)
      }}
      attachRuntime={(owner) =>
        attachWorklistPool(owner, (error) => {
          throw error
        })
      }
    >
      <ConfirmProvider>
        <OperatorFocusProvider missionId={null}>
          <Capture />
          <SidebarUnified />
          {probeId && <PoolMenuProbe id={probeId} />}
        </OperatorFocusProvider>
      </ConfirmProvider>
    </StoreProvider>,
  )
  await act(async () => {
    await runtime.getSnapshot().refreshRepos()
  })
  await waitFor(() => expect(pool).not.toBeNull())
  await waitFor(() => expect(pool!.sidebar.sections().bands.length).toBeGreaterThan(0))
  runtime.subscribeOutboxOutcomes((outcome) => outcomes.push(outcome))
  await parity()
  return fixture
}

async function parity() {
  await act(async () => {
    await Promise.resolve()
  })
  const store = runtime.getSnapshot()
  const result = checkSidebar(pool!, store, {
    pinnedRepos: store.pins.repos,
    pinnedWorktrees: store.pins.worktrees,
    projectOrder: store.sidebarSettings.repoOrder,
    paneA: store.paneA,
    selectedWorktree: store.selectedWorktree,
  })
  expect(result.pending).toBe(0)
  expect(result.first, JSON.stringify({
    target: pool!.sidebar.row(TARGET),
    legacy: allIssueViewModels(runtime.replica, store.issueProjections, store.issues).find((i) => i.id === TARGET),
  })).toBeNull()
  expect(result.differences).toBe(0)
}
function row(id = TARGET) {
  return document.querySelector<HTMLElement>(`[data-issue-row="${id}"]`)!
}
function value(id = TARGET) {
  const result = pool!.sidebar.row(id)
  expect(result).not.toBe(LOADING)
  expect(result).toBeDefined()
  if (result === undefined || result === LOADING) throw new Error('Expected resident row')
  return result
}
async function request(name: string, id = TARGET) {
  await waitFor(() =>
    expect(
      requests.filter((r) => !r.settled).map(({ procedure, input }) => ({ procedure, input })),
    ).toContainEqual({
      procedure: name,
      input: expect.objectContaining(name.startsWith('sessions.') ? { sessionId: id } : { id }),
    }),
  )
  return requests.find(
    (r) =>
      !r.settled && r.procedure === name && (r.input['id'] === id || r.input['sessionId'] === id),
  )!
}
async function accept(write: Request) {
  const before = outcomes.length
  write.settled = true
  await act(async () => {
    write.resolve({ ok: true })
  })
  await waitFor(() => expect(outcomes.slice(before).some((o) => o.type === 'applied')).toBe(true))
  await parity()
}
async function refuse(write: Request) {
  const before = outcomes.length
  write.settled = true
  await act(async () => {
    write.reject(
      Object.assign(new Error('Synthetic refusal'), {
        data: { code: 'BAD_REQUEST', httpStatus: 400 },
      }),
    )
  })
  await waitFor(() => expect(outcomes.slice(before).some((o) => o.type === 'rejected')).toBe(true))
  await parity()
}
async function menu(id = TARGET) {
  const target = row(id)?.querySelector('button')
  if (target) fireEvent.contextMenu(target, { clientX: 40, clientY: 60 })
  else fireEvent.click(screen.getByTestId('pool-menu-probe'))
  return screen.findByRole('menu', { name: 'Task actions' })
}
async function item(name: string | RegExp) {
  return screen.findByRole('menuitem', {
    name: typeof name === 'string' ? new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : name,
  })
}
function patchIssue(fixture: Fixture, id: string, patch: Record<string, unknown>) {
  fixture.patchIssue(id, patch)
}
function discoveredFrom(fixture: Fixture, fromId: string, toId: string) {
  fixture.patchIssue(fromId, { deps: [{ id: toId, type: 'discovered-from' }] })
  const id = `synthetic-edge-${fromId}`
  const record = {
    entity: 'issueDep',
    entityId: id,
    value: { id, fromId, toId, type: 'discovered-from' },
    provenance: { seq: 1 },
  }
  fixture.records.set(`issueDep:${id}`, record)
  fixture.replica.onKernelEvent({ type: 'upserted', record, readmitted: false })
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(beginSwitch).mockReset()
  requests = []
  outcomes = []
  pool = null
  focused = null
  features.handoff = false
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('pool navigation uses the existing gesture semantics', () => {
  it('selects the mission root, traces the explicit pane and batches read/defer before focus once', async () => {
    await mount((fixture) =>
      patchIssue(fixture, 'synthetic-3', { deferUntil: new Date(NOW - 1000).toISOString() }),
    )
    const calls: string[] = []
    const store = {
      ...runtime.getSnapshot(),
      batchGesture: vi.fn((fn: () => void) => {
        calls.push('batch')
        fn()
        calls.push('end')
      }),
      navigateWorkspace: vi.fn(() => {
        calls.push('navigate')
        return false
      }),
      markIssueRead: vi.fn(async () => {
        calls.push('issue-read')
      }),
      deferIssue: vi.fn(async () => {
        calls.push('defer')
      }),
      markSessionRead: vi.fn(async () => {
        calls.push('session-read')
      }),
    }
    vi.mocked(beginSwitch).mockImplementation(() => {
      calls.push('trace')
    })
    const focus = vi.fn(() => {
      calls.push('focus')
    })
    const work = createPoolWorkActions(pool!, { getSnapshot: () => store }, focus)
    work.selectPanelForIssue('synthetic-3', asSessionId('synthetic-session-3'))
    expect(calls).toEqual([
      'trace',
      'batch',
      'navigate',
      'issue-read',
      'defer',
      'session-read',
      'end',
      'focus',
    ])
    expect(store.navigateWorkspace).toHaveBeenCalledExactlyOnceWith({
      selectedIssueId: 'synthetic-1',
      selectedWorktree: ROOT,
      tabId: 'synthetic-session-3',
      firstPane: true,
    })
    expect(beginSwitch).toHaveBeenCalledWith({
      sessionId: 'synthetic-session-3',
      issueId: 'synthetic-3',
    })
    work.selectPanelForIssue('synthetic-3', asSessionId('synthetic-session-3'))
    expect(store.markIssueRead).toHaveBeenCalledTimes(1)
    expect(store.deferIssue).toHaveBeenCalledExactlyOnceWith('synthetic-3', null)
    expect(store.markSessionRead).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledWith('synthetic-3')
    store.navigateWorkspace.mockImplementation(() => {
      throw new Error('invalid plan')
    })
    focus.mockClear()
    expect(() => work.selectIssue(TARGET)).toThrow('invalid plan')
    expect(focus).not.toHaveBeenCalled()
    vi.mocked(beginSwitch).mockReset()
  })

  it.each([
    'grandchild',
    'filed-chain',
    'headless-starter',
    'archived-starter',
    'unstarted-spin',
    'departed-spin',
    'shell-and-guest',
    'archived-parent',
  ])('chooses the same mission pane as legacy for %s', async (scenario) => {
    await mount((fixture) => {
      patchIssue(fixture, 'synthetic-7', { parentId: 'synthetic-3' })
      fixture.patch('session', 'synthetic-session-7', {
        lastActiveAt: new Date(NOW - 20).toISOString(),
      })
      if (scenario !== 'grandchild') {
        patchIssue(fixture, 'synthetic-7', {
          parentId: null,
          startedBySession: 'synthetic-session-3',
          stage: scenario === 'unstarted-spin' ? 'backlog' : 'in_progress',
          deps: scenario.includes('spin') ? [{ id: 'synthetic-3', type: 'discovered-from' }] : [],
        })
        if (scenario.includes('spin')) discoveredFrom(fixture, 'synthetic-7', 'synthetic-3')
      }
      if (['filed-chain', 'headless-starter', 'archived-starter'].includes(scenario)) {
        patchIssue(fixture, 'synthetic-8', { startedBySession: 'synthetic-session-7' })
        fixture.patch('session', 'synthetic-session-8', {
          lastActiveAt: new Date(NOW - 10).toISOString(),
        })
        if (scenario === 'headless-starter')
          fixture.patch('session', 'synthetic-session-7', { headless: true })
        if (scenario === 'archived-starter')
          fixture.patch('session', 'synthetic-session-7', { archived: true })
      }
      if (scenario === 'shell-and-guest') {
        fixture.patch('session', 'synthetic-session-7', { agentKind: 'shell' })
        fixture.patch('session', 'synthetic-guest-1', {
          cwd: ROOT,
          lastActiveAt: new Date(NOW - 1).toISOString(),
        })
      }
      if (scenario === 'archived-parent') patchIssue(fixture, 'synthetic-1', { archived: true })
    })
    const store = runtime.getSnapshot()
    const models = allIssueViewModels(runtime.replica, store.issueProjections, store.issues)
    const clicked = models.find((issue) => issue.id === 'synthetic-3')!
    const root = missionRootFor(models, clicked.id)!
    const mission = missionIssueIds(models, root.id, store.sessions)
    const members = [
      ...new Map(
        models
          .filter((i) => mission.has(i.id))
          .flatMap((i) =>
            sessionsForIssueNav(i, store.sessions, [ROOT, `${ROOT}/guests`], {
              includeShells: true,
            }),
          )
          .map((s) => [s.sessionId, s]),
      ).values(),
    ]
    const expected = pickPaneSession(members, null)
    if (scenario === 'filed-chain') {
      expect([...pool!.graph.many('session', 'synthetic-session-7', 'startedIssues')]).toContain(
        'synthetic-8',
      )
      expect(pool!.row('issue', 'synthetic-8')).not.toBe(LOADING)
      expect(actions.resolveMenuData('synthetic-8').single[0]?.memberSessionIds).toEqual([
        'synthetic-session-8',
      ])
      expect(pool!.row('session', 'synthetic-session-8')).toMatchObject({
        lastActiveAt: new Date(NOW - 10).toISOString(),
      })
    }
    await act(async () => {
      actions.selectIssue('synthetic-3')
    })
    expect(beginSwitch).toHaveBeenLastCalledWith({ sessionId: expected, issueId: 'synthetic-3' })
    expect(runtime.getSnapshot().selectedIssueId).toBe(root.id)
    expect(runtime.getSnapshot().paneA, JSON.stringify({
      mission: [...mission], issueKeys: [...pool!.tables.issue.keys()],
      members: [...members.keys()],
      issueSessions: [...mission].map((id) => [id, actions.resolveMenuData(id).single[0]?.memberSessionIds]),
      reads: [...pool!.tables.session.keys()].map((id) => pool!.row('session', id)),
    })).toBe(expected)
    expect(focused).toBe('synthetic-3')
    await parity()
  })

  it('keeps a mission file pane, avoids redundant/file traces, and still focuses a sessionless child', async () => {
    await mount((fixture) => fixture.patch('session', 'synthetic-session-3', { archived: true }))
    const file = asSessionId('file:synthetic')
    const store = {
      ...runtime.getSnapshot(),
      paneA: file,
      fileTabs: [{ id: file, worktreePath: ROOT }],
      navigateWorkspace: vi.fn(() => false),
      batchGesture: (fn: () => void) => fn(),
      markIssueRead: vi.fn(async () => {}),
    }
    const focus = vi.fn()
    const work = createPoolWorkActions(
      pool!,
      { getSnapshot: () => store as ReturnType<typeof runtime.getSnapshot> },
      focus,
    )
    work.selectIssue('synthetic-3')
    expect(store.navigateWorkspace).toHaveBeenCalledWith(expect.objectContaining({ tabId: file }))
    expect(focus).toHaveBeenCalledWith('synthetic-3')
    expect(store.markIssueRead).toHaveBeenCalledWith('synthetic-3')
    expect(beginSwitch).not.toHaveBeenCalled()
    work.selectPanelForIssue('synthetic-3', file)
    expect(beginSwitch).not.toHaveBeenCalled()
  })

  it('selects a worktree and its explicit panel with the same trace and mark-read actions', async () => {
    await mount((fixture) =>
      fixture.patch('session', 'synthetic-guest-1', {
        lastActiveAt: new Date(NOW - 1).toISOString(),
        cwd: `${ROOT}/guests/src`,
      }),
    )
    await act(async () => {
      actions.selectWorktree(`${ROOT}/guests`)
    })
    expect(runtime.getSnapshot()).toMatchObject({
      selectedIssueId: null,
      selectedWorktree: `${ROOT}/guests`,
      paneA: 'synthetic-guest-1',
      view: 'workspace',
    })
    expect(beginSwitch).toHaveBeenLastCalledWith({ sessionId: 'synthetic-guest-1', issueId: null })
    const read = await request('sessions.markRead', 'synthetic-guest-1')
    expect(read.input).toMatchObject({
      sessionId: 'synthetic-guest-1',
    })
    await accept(read)
    await act(async () => {
      actions.selectPanel(`${ROOT}/guests`, asSessionId('synthetic-guest-0'))
    })
    expect(runtime.getSnapshot().paneA).toBe('synthetic-guest-0')
    expect(beginSwitch).toHaveBeenLastCalledWith({ sessionId: 'synthetic-guest-0', issueId: null })
    await refuse(await request('sessions.markRead', 'synthetic-guest-0'))
    await parity()
  })

  it('waits without a mutation for unloaded rows and loads repeated clicks in one batch', async () => {
    await mount()
    const owner = pool!
    const residency = owner.residency!
    const ids = ['synthetic-9', TARGET]
    const rows = ids.map((id) => owner.row('issue', id))
    const coldRule = residency.coldRule.bind(residency)
    const hidden = residency.hidden.bind(residency)
    residency.coldRule = (entity, record) =>
      entity === 'issue' && ids.includes((record as { id: string }).id)
        ? true
        : coldRule(entity, record)
    residency.hidden = (entity, id) =>
      entity === 'issue' && ids.includes(id) ? false : hidden(entity, id)
    try {
      act(() => {
        ids.forEach((id, index) => {
          owner.apply({ type: 'update', rows: [{ kind: 'issue', id, value: undefined }] })
          owner.apply({
            type: 'update',
            rows: [{ kind: 'issue', id, value: rows[index] as Record<string, unknown> }],
          })
        })
      })
      const fetch = vi.spyOn(runtime.replica, 'row')
      act(() => {
        for (const id of [...ids, ...ids]) actions.selectIssue(id)
        expect(ids.map((id) => owner.sidebar.row(id))).toEqual([LOADING, LOADING])
        expect(requests).toHaveLength(0)
        expect(runtime.getSnapshot().selectedIssueId).toBeNull()
        expect(focused).toBeNull()
        expect(fetch).not.toHaveBeenCalled()
        expect(owner.hydrate()).toBe(2)
      })
      fetch.mockRestore()
      expect(ids.map((id) => owner.sidebar.row(id))).not.toContain(LOADING)
    } finally {
      residency.coldRule = coldRule
      residency.hidden = hidden
    }
    await parity()
  })
})

describe('real pool row mutations and receipts', () => {
  it('backfills missing sort keys through planReorderKeys and the existing outbox, then rewinds every refusal', async () => {
    await mount()
    const original = [...pool!.sidebar.sections().bands[0]!.rowIds]
    const movedId = original.at(-1)!
    const order = [movedId, ...original.slice(0, -1)]
    const patches = planReorderKeys(order, movedId, () => undefined)
    expect(patches).toHaveLength(original.length)
    await act(async () => {
      await drag.options!.onDrop({
        sourceScope: 'group:synthetic-repo',
        targetScope: 'group:synthetic-repo',
        movedId,
        order,
      })
    })
    expect(
      runtime.outbox.pending().map((entry) => {
        const input = entry.input as { id: string; patch: object }
        return { id: input.id, ...input.patch }
      }),
    ).toEqual(patches)
    expect(pool!.sidebar.sections().bands[0]!.rowIds).toEqual(order)
    await parity()
    for (const patch of patches) await refuse(await request('issues.update', patch.id))
    expect(pool!.sidebar.sections().bands[0]!.rowIds).toEqual(original)
  })

  it.each([
    true,
    false,
  ])('crosses the pinned boundary (%s) with only the moved row patch', async (pinned) => {
    await mount((fixture) => {
      const keys = spreadSortKeys(12)
      for (let index = 0; index < 12; index += 1)
        patchIssue(fixture, `synthetic-${index}`, { sortKey: keys[index] })
    })
    const movedId = pinned ? TARGET : 'synthetic-0'
    const sourceScope = pinned ? 'group:synthetic-repo' : 'pinned'
    const targetScope = pinned ? 'pinned' : 'group:synthetic-repo'
    const existing = pinned
      ? [...pool!.sidebar.sections().pinnedIds]
      : [...pool!.sidebar.sections().bands[0]!.rowIds]
    const order = [...existing, movedId]
    expect(drag.options!.allowedTargets?.(sourceScope, movedId)).toEqual([targetScope])
    await act(async () => {
      await drag.options!.onDrop({ sourceScope, targetScope, movedId, order })
    })
    const write = await request('issues.update', movedId)
    expect(requests).toHaveLength(1)
    expect(write.input).toMatchObject({
      id: movedId,
      patch: { pinned, sortKey: expect.any(String) },
    })
    expect(pool!.sidebar.sections().pinnedIds.includes(movedId)).toBe(pinned)
    await parity()
    await refuse(write)
    expect(pool!.sidebar.sections().pinnedIds.includes(movedId)).toBe(!pinned)
  })

  it('renames inline on Enter, paints before the receipt and rewinds on refusal', async () => {
    await mount()
    fireEvent.doubleClick(screen.getByText('Only responsive target'))
    const input = screen.getByDisplayValue('Only responsive target') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length])
    fireEvent.change(input, { target: { value: 'Optimistic title' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const write = await request('issues.update')
    expect(write.input).toMatchObject({ id: TARGET, patch: { title: 'Optimistic title' } })
    expect(row().textContent).toContain('Optimistic title')
    expect(value().title).toBe('Optimistic title')
    await parity()
    await refuse(write)
    expect(value().title).toBe('Only responsive target')
    expect(row().textContent).toContain('Only responsive target')
    expect(runtime.getSnapshot().outboxDeadLetters).toHaveLength(1)
  })

  it('retains an accepted rename until the echo, composes a later edit and rewinds only that edit', async () => {
    const fixture = await mount()
    act(() => actions.renameIssue(TARGET, 'Accepted title'))
    const first = await request('issues.update')
    await act(async () => {
      first.resolve({ ok: true })
    })
    await waitFor(() => expect(outcomes.some((o) => o.type === 'applied')).toBe(true))
    expect(value().title).toBe('Accepted title')
    await parity()
    act(() => actions.renameIssue(TARGET, 'Second pending title'))
    await waitFor(() =>
      expect(requests.filter((r) => r.procedure === 'issues.update')).toHaveLength(2),
    )
    const second = requests.filter((r) => r.procedure === 'issues.update')[1]!
    await act(async () => {
      patchIssue(fixture, TARGET, { title: 'Accepted title' })
    })
    expect(value().title).toBe('Second pending title')
    await parity()
    await refuse(second)
    expect(value().title).toBe('Accepted title')
    expect(runtime.pendingOverlaysByRow('issues').has(TARGET)).toBe(false)
  })

  it('cancels Escape and whitespace edits; menu Rename uses the same editor', async () => {
    await mount()
    await menu()
    fireEvent.click(await item('Rename'))
    let input = screen.getByDisplayValue('Only responsive target')
    fireEvent.change(input, { target: { value: 'Cancelled' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(row().textContent).toContain('Only responsive target')
    fireEvent.doubleClick(screen.getByText('Only responsive target'))
    input = screen.getByDisplayValue('Only responsive target')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(requests).toHaveLength(0)
    await parity()
    fireEvent.doubleClick(screen.getByText('Only responsive target'))
    input = screen.getByDisplayValue('Only responsive target')
    fireEvent.change(input, { target: { value: '  Blurred title  ' } })
    fireEvent.blur(input)
    const write = await request('issues.update')
    expect(write.input).toMatchObject({ patch: { title: 'Blurred title' } })
    expect(value().title).toBe('Blurred title')
    await parity()
    await refuse(write)
  })

  it('pins immediately from the actual issue menu and returns to the original band on refusal', async () => {
    await mount()
    await menu()
    fireEvent.click(await item('Pin'))
    const write = await request('issues.update')
    expect(write.input).toMatchObject({ patch: { pinned: true } })
    expect(pool!.sidebar.sections().pinnedIds).toContain(TARGET)
    expect(screen.getByTestId('pinned-section').contains(row())).toBe(true)
    await parity()
    await refuse(write)
    expect(pool!.sidebar.sections().pinnedIds).not.toContain(TARGET)
    expect(screen.getByTestId('pinned-section').contains(row())).toBe(false)
  })

  it('tucks and brings back with the shared action and keeps a clicked closed row folded', async () => {
    const fixture = await mount((fixture) =>
      patchIssue(fixture, TARGET, {
        stage: 'done',
        closedReason: 'done',
        closedAt: new Date(NOW - 600000).toISOString(),
      }),
    )
    fireEvent.click(within(row()).getByTestId('tuck-away'))
    const tuck = await request('issues.setTucked')
    expect(tuck.input).toMatchObject({ id: TARGET, tucked: true })
    await waitFor(() => expect(pool!.sidebar.sections().bands[0]!.closedIds).toContain(TARGET))
    await parity()
    await refuse(tuck)
    expect(pool!.sidebar.sections().bands[0]!.rowIds).toContain(TARGET)
    fireEvent.click(within(row()).getByTestId('tuck-away'))
    await accept(await request('issues.setTucked'))
    await act(async () => patchIssue(fixture, TARGET, { tuckedAt: new Date(NOW).toISOString() }))
    fireEvent.click(screen.getByTestId('closed-fold-toggle'))
    const folded = await screen.findByText('Only responsive target', {
      selector: '[data-testid="folded-work-row"] *',
    })
    fireEvent.click(folded)
    await parity()
    expect(pool!.foldLatch.get()).toBe(true)
    for (const queued of runtime.outbox.pending().filter((entry) => entry.kind === 'issueMarkRead'))
      await accept(await request('issues.markRead', (queued.input as { id: string }).id))
    fireEvent.contextMenu(folded, { clientX: 30, clientY: 40 })
    fireEvent.click(await screen.findByTestId('bring-back'))
    const bringBack = await request('issues.setTucked')
    expect(bringBack.input).toMatchObject({ id: TARGET, tucked: false })
    await waitFor(() => expect(pool!.sidebar.sections().bands[0]!.rowIds).toContain(TARGET))
    expect(row().textContent).toContain('Only responsive target')
    await parity()
    await refuse(bringBack)
    expect(pool!.sidebar.sections().bands[0]!.closedIds).toContain(TARGET)
  })

  it('keeps Bring back disabled with its explanation after the grace window', async () => {
    await mount((fixture) =>
      patchIssue(fixture, 'synthetic-5', {
        closedAt: new Date(NOW - 2 * 86400000).toISOString(),
      }),
    )
    fireEvent.click(screen.getByTestId('closed-fold-toggle'))
    const folded = screen.getByTestId('folded-work-row')
    fireEvent.contextMenu(folded)
    const blocked = await screen.findByTestId('bring-back-blocked')
    expect((blocked as HTMLButtonElement).disabled).toBe(true)
    expect(blocked.textContent).toContain('older than a day')
    fireEvent.click(blocked)
    expect(requests).toHaveLength(0)
    await parity()
  })

  it('archives through the closed-fold dismiss, hides optimistically and returns on refusal', async () => {
    await mount()
    fireEvent.click(screen.getByTestId('closed-fold-toggle'))
    fireEvent.click(screen.getByTestId('closed-issue-archive'))
    expect(pool!.sidebar.sections().bands[0]!.closedIds, JSON.stringify({
      pending: runtime.outbox.pending(), row: pool!.sidebar.row('synthetic-5'), requests,
    })).not.toContain('synthetic-5')
    const write = await request('issues.archive', 'synthetic-5')
    expect(write.input).toMatchObject({ id: 'synthetic-5' })
    expect(pool!.sidebar.sections().bands[0]!.closedIds).not.toContain('synthetic-5')
    await parity()
    await refuse(write)
    expect(pool!.sidebar.sections().bands[0]!.closedIds).toContain('synthetic-5')
    await waitFor(() =>
      expect(screen.getByTestId('folded-work-row').textContent).toContain('Synthetic task 5'),
    )
  })

  it('opens the task page without changing the workspace pane', async () => {
    await mount()
    const pane = runtime.getSnapshot().paneA
    await menu()
    fireEvent.click(await item('Open in tasks'))
    expect(runtime.getSnapshot()).toMatchObject({
      openIssueId: TARGET,
      view: 'issues',
      paneA: pane,
    })
    expect(requests).toHaveLength(0)
    await parity()
  })

  it.each([
    ['Set status', 'Review', 'issues.update', { patch: { stage: 'review' } }],
    [
      'Snooze / defer',
      'For 1 hour',
      'issues.defer',
      { until: new Date(NOW + 3600000).toISOString() },
    ],
  ] as const)('dispatches %s through the existing menu and outbox', async (entry, option, name, expected) => {
    await mount((fixture) => patchIssue(fixture, 'synthetic-8', { labels: ['synthetic-label'] }))
    await menu()
    fireEvent.click(await item(entry))
    fireEvent.click(await item(option))
    const write = await request(name)
    expect(write.input).toMatchObject({ id: TARGET, ...expected })
    await parity()
    await refuse(write)
  })

  it('sets colour and unread state through the shared menu actions', async () => {
    await mount()
    await menu()
    fireEvent.click(await item('Set colour'))
    fireEvent.click(screen.getByRole('button', { name: 'Violet' }))
    const color = await request('issues.update')
    expect(color.input).toMatchObject({ patch: { color: 'violet' } })
    expect(value().issue.color).toBe('violet')
    await refuse(color)
    await menu()
    fireEvent.click(await item('Mark as unread'))
    const unread = await request('issues.markUnread')
    expect(value().issue.unread).toBe(true)
    await parity()
    await refuse(unread)
    expect(value().issue.unread).toBe(false)
  })

  it('offers the same sidebar menu vocabulary and resolves live cascade counts and members on open', async () => {
    await mount()
    const resolved = actions.resolveMenuData('synthetic-1').single[0]!
    expect(resolved.childCount).toBe(2)
    expect(resolved.memberSessionIds).toEqual(['synthetic-session-1'])
    await menu()
    for (const name of [
      'Open in tasks',
      'Rename',
      'Mark as unread',
      'Set status',
      'Set colour',
      'Snooze / defer',
      'Pin',
      'Archive…',
      'Delete…',
    ])
      expect(await item(name)).toBeTruthy()
    for (const name of [
      'Set priority',
      'Labels',
      'Assign agent',
      'Run now',
      'Duplicate of',
      'Restore',
    ])
      expect(screen.queryByRole('menuitem', { name })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await parity()
  })

  it('marks an unread task read, clears deferral and unpins through the actual menu', async () => {
    await mount((fixture) =>
      patchIssue(fixture, TARGET, {
        readAt: null,
        pinned: true,
        deferUntil: new Date(NOW + 3600000).toISOString(),
      }),
    )
    expect(value().issue.unread).toBe(true)
    expect(actions.resolveMenuData(TARGET).single[0]?.unread).toBe(true)
    await menu()
    fireEvent.click(await item('Mark as read'))
    const read = await request('issues.markRead')
    expect(value().issue.unread).toBe(false)
    await parity()
    await refuse(read)
    expect(value().issue.unread).toBe(true)
    await menu()
    fireEvent.click(await item('Snooze / defer'))
    fireEvent.click(await item('Unsnooze'))
    const unsnooze = await request('issues.undefer')
    expect(value().deferred).toBe(false)
    await parity()
    await refuse(unsnooze)
    await menu()
    fireEvent.click(await item('Unpin'))
    const unpin = await request('issues.update')
    expect(unpin.input).toMatchObject({ patch: { pinned: false } })
    expect(pool!.sidebar.sections().pinnedIds).not.toContain(TARGET)
    await refuse(unpin)
    expect(pool!.sidebar.sections().pinnedIds).toContain(TARGET)
  })

  it('closes from Set status with the existing lifecycle action and rewinds a refusal', async () => {
    await mount()
    await menu()
    fireEvent.click(await item('Set status'))
    fireEvent.click(await item('Done'))
    const close = await request('issues.close')
    expect(close.input).toMatchObject({ id: TARGET, reason: 'done' })
    expect(value().issue.closedReason).toBe('done')
    await parity()
    await refuse(close)
    expect(value().issue.closedReason).toBeFalsy()
  })

  it.each([
    'own',
    'mission',
  ] as const)('moves discovered work to %s through the existing placement action', async (placement) => {
    const id = placement === 'own' ? 'synthetic-3' : TARGET
    await mount((fixture) => {
      if (placement === 'own') patchIssue(fixture, TARGET, { parentId: 'synthetic-1' })
      if (placement === 'mission') discoveredFrom(fixture, id, 'synthetic-1')
    }, 12, placement === 'own' ? TARGET : undefined)
    const targetId = placement === 'own' ? TARGET : id
    await menu(targetId)
    fireEvent.click(await item(placement === 'own' ? /^Move to top level/ : /^Move into/))
    const write = await request('issues.setPlacement', targetId)
    expect(write.input).toMatchObject({ id: targetId, placement, originId: 'synthetic-1' })
    expect(value(targetId).issue.parentId ?? null).toBe(
      placement === 'mission' ? 'synthetic-1' : null,
    )
    await parity()
    await refuse(write)
    expect(value(targetId).issue.parentId ?? null).toBe(placement === 'own' ? 'synthetic-1' : null)
  })

  it('hands the pool-resolved session to the same shared Handoff menu command', async () => {
    features.handoff = true
    await mount((fixture) => {
      fixture.patch('session', 'synthetic-session-11', {
        machineId: 'source',
        harnessHandoff: true,
        cwd: `${ROOT}/guests`,
      })
      patchIssue(fixture, TARGET, { worktreePath: `${ROOT}/guests` })
      const refresh = fixture.api.discovery.refreshRepos.mutate
      fixture.api.discovery.refreshRepos.mutate = async (...args) => {
        const result = await refresh(...args)
        return {
          ...result,
          repositories: ['source', 'target'].map((machineId) => ({
            path: machineId === 'source' ? ROOT : '/synthetic/target',
            machineId,
            repoId: 'synthetic-repo',
            kind: 'repository',
            branch: 'main',
            worktrees: machineId === 'source' ? [{ path: `${ROOT}/guests`, branch: 'synthetic' }] : [],
          })),
          machines: ['source', 'target'].map((id) => ({
            id,
            name: `Synthetic ${id}`,
            online: true,
            serviceAssignment: { server: false, agentExecution: true },
            availability: { daemon: true },
            inventory: { agents: [{ kind: 'codex', installed: true, login: { state: 'in' } }] },
          })),
        } as typeof result
      }
    })
    await menu()
    fireEvent.click(await item('Handoff'))
    fireEvent.click(await item('Synthetic target'))
    const write = await request('sessions.handoff', 'synthetic-session-11')
    expect(write.input).toEqual({ sessionId: 'synthetic-session-11', machineId: 'target' })
    // Handoff retains the shared menu's existing direct command semantics.
    expect(runtime.outbox.pending()).toHaveLength(0)
    await act(async () => write.reject(new Error('Synthetic handoff refusal')))
    await parity()
  })

  it('archives every closed row from the fold footer through the same outbox', async () => {
    await mount((fixture) =>
      patchIssue(fixture, TARGET, {
        stage: 'done',
        closedReason: 'done',
        closedAt: new Date(NOW - 1000).toISOString(),
        tuckedAt: new Date(NOW - 500).toISOString(),
      }),
    )
    fireEvent.click(screen.getByTestId('closed-fold-toggle'))
    fireEvent.click(screen.getByTestId('closed-issues-archive-all'))
    expect(
      runtime.outbox
        .pending()
        .filter((entry) => entry.kind === 'issueArchive')
        .map((entry) => (entry.input as { id: string }).id)
        .sort(),
    ).toEqual(['synthetic-5', TARGET].sort())
    expect(pool!.sidebar.sections().bands[0]!.closedIds).toHaveLength(0)
    await parity()
    for (const entry of runtime.outbox.pending().filter((entry) => entry.kind === 'issueArchive'))
      await refuse(await request('issues.archive', (entry.input as { id: string }).id))
    expect(pool!.sidebar.sections().bands[0]!.closedIds).toHaveLength(2)
  })

  it('preserves archive and delete confirmation before enqueuing and rewinds both refusals', async () => {
    await mount()
    await menu()
    fireEvent.click(await item('Archive…'))
    const archiveDialog = await screen.findByRole('alertdialog')
    expect(archiveDialog.textContent).toContain('1 agent')
    expect(requests).toHaveLength(0)
    fireEvent.click(within(archiveDialog).getByRole('button', { name: 'Archive' }))
    const archive = await request('issues.update')
    expect(archive.input).toMatchObject({ patch: { archived: true } })
    await parity()
    await refuse(archive)
    await menu()
    fireEvent.click(await item('Delete…'))
    const deleteDialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(deleteDialog).getByRole('button', { name: 'Delete' }))
    const deletion = await request('issues.delete')
    expect(value().issue.deletedAt).toBeTruthy()
    await parity()
    await refuse(deletion)
    expect(value().issue.deletedAt).toBeFalsy()
  })

  it('treats eviction as absence, never requests the evicted row, and accepts readmission', async () => {
    const fixture = await mount()
    await act(async () => {
      runtime.getSnapshot().setSelectedIssueId(asIssueId(TARGET))
    })
    expect(runtime.getSnapshot().selectedIssueId).toBe(TARGET)
    const records = ['issue', 'issueProjection'].map(
      (entity) => fixture.records.get(`${entity}:${TARGET}`)!,
    )
    await act(async () => {
      for (const entity of ['issue', 'issueProjection']) {
        fixture.records.delete(`${entity}:${TARGET}`)
        fixture.replica.onKernelEvent({ type: 'evicted', entity, entityId: TARGET })
      }
    })
    await waitFor(() => expect(runtime.getSnapshot().selectedIssueId).toBeNull())
    expect(pool!.sidebar.row(TARGET)).toBeUndefined()
    expect(requests).toHaveLength(0)
    await parity()
    await act(async () => {
      for (const record of records) {
        fixture.records.set(`${record.entity}:${TARGET}`, record)
        fixture.replica.onKernelEvent({
          type: 'upserted',
          record,
          readmitted: true,
        })
      }
    })
    expect(value().title).toBe('Only responsive target')
    await parity()
  })
})

describe('pool command-hold row shortcuts', () => {
  it('numbers and selects the settled first nine tasks in column order, excluding folded/collapsed bands', async () => {
    await mount(undefined, 18)
    const ids = [...document.querySelectorAll('[data-issue-row]')].map(
      (node) => node.getAttribute('data-issue-row')!,
    )
    fireEvent.keyDown(window, { key: 'Meta', code: 'MetaLeft', metaKey: true })
    const badges = [...document.querySelectorAll('[data-shortcut-digit]')]
    expect(badges.map((node) => node.getAttribute('data-shortcut-digit'))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ])
    for (let digit = 1; digit <= 9; digit += 1) {
      fireEvent.keyDown(window, { key: String(digit), code: `Digit${digit}`, metaKey: true })
      expect(runtime.getSnapshot().selectedIssueId).toBe(ids[digit - 1])
      expect(focused).toBe(ids[digit - 1])
      await parity()
    }
    fireEvent.keyUp(window, { key: 'Meta', metaKey: false })
    expect(document.querySelectorAll('[data-shortcut-digit]')).toHaveLength(0)
    fireEvent.click(screen.getByTestId('pinned-section-label'))
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', metaKey: true })
    expect(runtime.getSnapshot().selectedIssueId).toBe(ids[1])
    fireEvent.keyDown(window, { key: '2', code: 'Digit2', metaKey: true, shiftKey: true })
    expect(runtime.getSnapshot().selectedIssueId).toBe(ids[1])
    fireEvent.blur(window)
    expect(document.querySelectorAll('[data-shortcut-digit]')).toHaveLength(0)
    await parity()
  })
})
