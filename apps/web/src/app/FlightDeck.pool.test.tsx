import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
// @vitest-environment happy-dom

import { dedupeSessions } from '@podium/client-graph/diagnostics/reference-state'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { allIssueViewModels } from '@podium/client-graph/diagnostics/reference/issue-view-models'
import { type SessionView, sessionViews } from '@podium/client-core/session-values'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { missionIndexStats, sessionOwnershipStats } from '@podium/client-core/values'
import { missionView } from '@podium/client-graph/mission-view'
import { MobxPool } from '@podium/client-graph/pool'
import { screenOptions } from '@podium/client-graph/host'
import { createPoolProjection, createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Profiler, type ProfilerOnRenderCallback, useMemo, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IssueExplorerProvider } from '@/features/issues/explorer/explorer-context'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { buildCorpus } from '../../../../packages/worklist-proto/harness/src/fixture/corpus'
import { expectPoolOutput } from '../../../../packages/worklist-proto/harness/src/oracle/pool-output'
import { seedCacheFromCorpus, startScenarioEngine } from '../../../../packages/worklist-proto/shared/src/scenarios'
import { FlightDeck, type FlightDeckView } from './FlightDeck'
import { FoldedFlightDeckBar } from './FoldedFlightDeckBar'
import { missionLegacyCountsFor, resetMissionLegacyCounts } from './mission-pane-perf'
import { OperatorFocusProvider } from './operator-focus'
import { poolBackedScreens } from './pool-screens'

const state = vi.hoisted(() => ({
  pool: null as unknown,
  issues: [] as unknown[],
  sessions: [] as unknown[],
  repos: [],
  machines: [],
  selectedIssueId: null as string | null,
  paneA: null as string | null,
  paneB: null as string | null,
  split: false,
  coarseNow: 0,
  uiState: { get: (_key: string): string | null => null, set: vi.fn(), subscribe: () => () => {} },
  replica: {} as unknown,
  trpc: {} as unknown,
  issueVisitBaseline: null,
  setSelectedWorktree: vi.fn(),
  setSelectedIssueId: vi.fn(),
  openSessionTab: vi.fn(),
  openSessionAtTranscript: vi.fn(),
  focusIssueSession: vi.fn(),
  setPanelMode: vi.fn(),
  preferPanelMode: vi.fn(),
  setView: vi.fn(),
  markIssueRead: vi.fn(),
  markSessionRead: vi.fn(),
  setIssueTucked: vi.fn(),
  closeIssue: vi.fn(),
  updateIssue: vi.fn(),
  renameSession: vi.fn(),
}))
const owner = withKeyedInputs({ getSnapshot: () => state, subscribe: () => () => {} })
vi.mock('./store', () => ({
  useRuntimeSelector: (read: (store: typeof state) => unknown) => read(state),
  useReplicaIssues: () => {
    throw new Error('Pool pane read legacy issue models')
  },
  useSessionDraft: () => '',
}))
vi.mock('@podium/client-core/react', async (original) => ({
  ...(await original<typeof import('@podium/client-core/react')>()),
  useStoreHandle: () => owner,
}))
vi.mock('./store-worklist-pool', () => {
  const usePool = () => state.pool as MobxPool | null
  return {
    useWorklistPool: usePool,
    useWorklistPoolProjection: (read: (pool: MobxPool) => unknown, empty: unknown) => {
      const currentPool = usePool()
      const projection = useMemo(
        () => (currentPool ? createPoolProjection(currentPool, read) : null),
        [read, currentPool],
      )
      return useSyncExternalStore(
        projection?.subscribe ?? (() => () => {}),
        projection?.getSnapshot ?? (() => empty),
      )
    },
  }
})
vi.mock('@/lib/use-harness-descriptors', () => ({
  useHarnessDescriptors: () => ({ served: undefined, status: 'unavailable' }),
}))
vi.mock('@/lib/use-feature', () => ({ useFeature: () => true }))

const corpus = buildCorpus(1, 1)
let issues: ReturnType<typeof allIssueViewModels>
let sessions: SessionView[]
let pool: MobxPool
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(corpus.fixedNow)
  const replica = createKernelReplica({
    cache: seedCacheFromCorpus(corpus),
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  issues = allIssueViewModels(replica)
  sessions = dedupeSessions(
    sessionViews([...replica.rows('sessions')], {
      userId: 'operator',
      userStates: [...replica.rows('sessionUserStates')],
      machines: [...replica.rows('machines')],
      repos: [...replica.rows('repos')],
    }),
  )
  state.issues = issues
  state.sessions = sessions
  state.coarseNow = corpus.fixedNow
  state.paneA = null
  state.paneB = null
  state.split = false
  state.replica = replica
  state.trpc = {
    cost: { task: { query: async () => null }, tasks: { query: async () => [] } },
    issues: { events: { query: async () => [] } },
    sessions: { transcriptRead: { query: async () => ({ items: [], hasMore: false }) } },
  }
  pool = new MobxPool({ selectedIssueId: null, coarseNow: corpus.fixedNow })
  pool.attachPreferences(state.uiState as RoutedUiState)
  pool.apply({
    type: 'replace',
    rows: [
      ...replica.rows('repos').flatMap((value) =>
        value.repoPath
          ? [
              {
                kind: 'worktree' as const,
                id: value.repoPath,
                value: {
                  path: value.repoPath,
                  repoId: value.id,
                  repoPath: value.repoPath,
                  repoName: value.repoPath.split('/').at(-1) ?? '',
                  prefix: value.prefix,
                },
              },
            ]
          : [],
      ),
      ...sessions.map((value) => ({ kind: 'session' as const, id: value.sessionId, value })),
      ...issues.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
    ],
  })
  state.pool = pool
}, 60_000)
afterEach(() => {
  cleanup()
  pool.dispose()
  state.pool = null
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function mount(view: FlightDeckView, onRender?: ProfilerOnRenderCallback) {
  vi.setSystemTime(corpus.fixedNow)
  state.uiState.get = (key) => (key === 'podium.flightDeck.mode' ? view : null)
  return render(
    onRender ? (
      <Profiler id="mission" onRender={onRender}>
        {deck()}
      </Profiler>
    ) : (
      deck()
    ),
  )
}
function deck() {
  return (
    <ConfirmProvider>
      <OperatorFocusProvider missionId={state.selectedIssueId}>
        <IssueExplorerProvider>
          <FlightDeck onCollapse={() => {}} />
        </IssueExplorerProvider>
      </OperatorFocusProvider>
    </ConfirmProvider>
  )
}
/** Text, labels, tag/order, CSS classes and authored layout styles. React/Base
 * UI's generated IDs and animation progress are not authored presentation. */
function renderedOutput(container: Element) {
  return [...container.querySelectorAll('*')].map((node) => ({
    tag: node.tagName,
    text: node.childElementCount === 0 ? node.textContent : null,
    label: node.getAttribute('aria-label'),
    title: node.getAttribute('title'),
    role: node.getAttribute('role'),
    class: node.getAttribute('class'),
    hidden: node.getAttribute('hidden'),
    issue: node.getAttribute('data-flight-issue'),
    session: node.getAttribute('data-flight-session'),
    style:
      (node as HTMLElement).style?.cssText.replace(
        /(?:opacity|transform|transition)[^;]*;?/g,
        '',
      ) ?? '',
  }))
}
async function settled() {
  await waitFor(() => expect(document.querySelector('[data-testid="flight-settling"]')).toBeNull())
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
}

describe('rendered mission pane parity', () => {
  it.each([1, 4] as const)('paints a cold runtime mission at %sx using the automatic loader', async (scale) => {
    const ctx = await startScenarioEngine(scale, { seed: 4443 })
    const handle = createRuntimeWorklistPool(ctx.engine, screenOptions(poolBackedScreens, ctx.engine))
    pool.dispose()
    pool = handle.pool
    state.pool = pool
    state.replica = ctx.engine.replica
    state.selectedIssueId = scale === 1 ? 'i1766' : 'i13916'
    state.paneA = 's0'
    const errors = vi.spyOn(console, 'error')
    try {
      const current = mount('full')
      await waitFor(() => expect(current.container.querySelector('[data-testid="flight-deck-scroller"]')).not.toBeNull(), { timeout: 10_000 })
      const root = missionView(pool).issue(state.selectedIssueId)
      expect(root && typeof root !== 'symbol' ? current.container.querySelector('.deck-header')?.textContent : '').toContain(root && typeof root !== 'symbol' ? root.displayRef : 'missing root')
      expect(errors.mock.calls.filter(([message]) => String(message).includes('same key'))).toEqual([])
    } finally {
      cleanup()
      handle.dispose()
      ctx.engine.destroy()
    }
  }, 60_000)

  it('does not commit another roster render when the host catalog publishes equal values', async () => {
    const root = issues.find(
      (issue) =>
        !issue.archived &&
        !issue.deletedAt &&
        !issue.parentId &&
        issue.childCount >= 2 &&
        issue.childCount < 12,
    )
    if (!root) throw new Error('Missing mission fixture')
    const renamed = { ...root, title: 'Changed mission catalog check' }
    state.selectedIssueId = root.id
    const publishCatalog = (prefix: string) =>
      pool.apply({
        type: 'update',
        rows: [
          {
            kind: 'worktree',
            id: '/catalog-only',
            value: {
              path: '/catalog-only',
              repoPath: '/catalog-only',
              repoName: 'Catalog only',
              prefix,
            },
          },
        ],
      })
    publishCatalog('before')
    vi.spyOn(pool.headerViews, 'machines').mockImplementation(() => {
      pool.row('worktree', '/catalog-only')
      return []
    })
    const committed = vi.fn()
    const current = mount('full', committed)
    await settled()
    const before = committed.mock.calls.length
    await act(async () => {
      publishCatalog('after')
    })
    expect(committed).toHaveBeenCalledTimes(before)
    await act(async () => {
      pool.apply({ type: 'update', rows: [{ kind: 'issue', id: root.id, value: renamed }] })
    })
    await waitFor(() =>
      expect(current.container.querySelector('.deck-header')?.textContent).toContain(renamed.title),
    )
  }, 120_000)

  it('derives a mission once and retains its rows when only the selected session changes', async () => {
    const root = issues.find(
      (issue) =>
        !issue.archived &&
        !issue.deletedAt &&
        !issue.parentId &&
        issue.childCount >= 2 &&
        issue.childCount < 12 &&
        sessions.some(
          (session) =>
            session.issueId === issue.id &&
            !session.archived &&
            !session.headless &&
            session.agentKind !== 'shell',
        ),
    )
    if (!root) throw new Error('Missing mission fixture')
    state.selectedIssueId = root.id
    const reader = missionView(pool)
    const current = mount('full')
    await settled()
    expect(reader.stats.values).toBe(1)
    const before = renderedOutput(current.container)
    const selected = sessions.find((session) => session.issueId === root.id)
    if (!selected) throw new Error('Missing mission session fixture')
    state.paneA = selected.sessionId
    current.rerender(deck())
    await settled()
    expect(reader.stats.values).toBe(1)
    expect(current.container.querySelectorAll('[data-flight-issue]').length).toBeGreaterThan(1)
    expect(renderedOutput(current.container).map(({ class: _class, ...node }) => node)).toEqual(
      before.map(({ class: _class, ...node }) => node),
    )
  }, 120_000)

  it('selecting another row of the same mission reuses the mission derived for its root', async () => {
    const child = issues.find(
      (issue) =>
        !issue.archived &&
        !issue.deletedAt &&
        issue.parentId &&
        issues.some(
          (parent) =>
            parent.id === issue.parentId &&
            !parent.archived &&
            !parent.deletedAt &&
            !parent.parentId,
        ),
    )
    if (!child?.parentId) throw new Error('Missing mission child fixture')
    state.selectedIssueId = child.parentId
    const reader = missionView(pool)
    const current = mount('full')
    await settled()
    expect(reader.stats.values).toBe(1)
    const rows = () =>
      [...current.container.querySelectorAll('[data-flight-issue]')].map((node) =>
        node.getAttribute('data-flight-issue'),
      )
    const before = rows()
    // A large mission now mounts a viewport, so select a row in that viewport
    // while holding the existing per-root derivation contract.
    const mountedChild = before[0]
    expect(mountedChild).toBeTruthy()
    state.selectedIssueId = mountedChild!
    current.rerender(deck())
    await settled()
    // Review finding 2: the pane is cached per mission root, not per selection.
    expect(reader.stats.values).toBe(1)
    expect(rows()).toEqual(before)
  }, 120_000)

  for (const view of ['full', 'working', 'needs-you', 'waterfall', 'handoff'] as const)
    it(`preserves visible words, labels, order and layout in ${view}`, async () => {
      const root = issues.find(
        (issue) =>
          !issue.archived &&
          !issue.deletedAt &&
          !issue.parentId &&
          issue.childCount >= 2 &&
          issue.childCount < 12,
      )!
      state.selectedIssueId = root.id
      resetMissionLegacyCounts(owner)
      const baseline = missionIndexStats(),
        ownership = sessionOwnershipStats()
      const current = mount(view)
      await settled()
      expectPoolOutput(renderedOutput(current.container), 'rendered output')
      expect(missionIndexStats()).toEqual(baseline)
      expect(sessionOwnershipStats()).toEqual(ownership)
      expect(missionLegacyCountsFor(owner)).toEqual({})
    }, 120_000)

  it('keeps archived-session reveal names/order and opens the same session', async () => {
    const root = issues.find(
      (issue) =>
        !issue.archived &&
        !issue.deletedAt &&
        !issue.parentId &&
        sessions.some(
          (session) =>
            session.issueId === issue.id &&
            session.archived &&
            !session.headless &&
            session.agentKind !== 'shell',
        ),
    )!
    state.selectedIssueId = root.id
    const archivedId = sessions.find(
      (session) =>
        session.issueId === root.id &&
        session.archived &&
        !session.headless &&
        session.agentKind !== 'shell',
    )!.sessionId
    const selector = `[data-flight-session="${archivedId}"] button.deck-agent`
    const current = mount('full')
    await settled()
    fireEvent.click(screen.getByRole('button', { name: /archived session/i }))
    await settled()
    expectPoolOutput(renderedOutput(current.container), 'rendered output')
    fireEvent.keyDown(current.container.querySelector(selector)!, { key: 'Enter' })
    await settled()
    expect(state.openSessionTab.mock.calls.at(-1)).toEqual([archivedId, { permanent: true }])
  }, 120_000)

  for (const menu of ['issue', 'session'] as const)
    it(`preserves ${menu} action labels and order`, async () => {
      state.selectedIssueId = issues.find(
        (issue) =>
          !issue.archived &&
          !issue.deletedAt &&
          !issue.parentId &&
          issue.childCount > 1 &&
          issue.childCount < 12 &&
          sessions.some(
            (session) =>
              session.issueId === issue.id &&
              !session.archived &&
              !session.headless &&
              session.agentKind !== 'shell',
          ),
      )!.id
      const target = menu === 'issue' ? '.deck-header' : 'button.deck-agent'
      resetMissionLegacyCounts(owner)
      const baseline = missionIndexStats(),
        ownership = sessionOwnershipStats()
      const current = mount('full')
      await settled()
      fireEvent.contextMenu(current.container.querySelector(target)!, { clientX: 10, clientY: 20 })
      await settled()
      expectPoolOutput(renderedOutput(await screen.findByRole('menu')), 'menu output')
      expect(missionIndexStats()).toEqual(baseline)
      expect(sessionOwnershipStats()).toEqual(ownership)
      expect(missionLegacyCountsFor(owner)).toEqual({})
    }, 120_000)

  it('preserves folded bar words, labels, tick order and layout', async () => {
    state.selectedIssueId = 'i1884'
    const baseline = missionIndexStats(),
      ownership = sessionOwnershipStats()
    const current = render(<FoldedFlightDeckBar onExpand={() => {}} />)
    await waitFor(() =>
      expect(current.container.querySelector('[data-testid="flight-deck-gauge"]')).not.toBeNull(),
    )
    expectPoolOutput(renderedOutput(current.container), 'rendered output')
    expect(missionIndexStats()).toEqual(baseline)
    expect(sessionOwnershipStats()).toEqual(ownership)
  }, 120_000)
})
