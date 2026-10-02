// @vitest-environment happy-dom
import { dedupeSessions } from '@podium/client-core/engine'
import { allIssueViewModels, createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { sessionViews, type SessionView } from '@podium/client-core/session-values'
import { missionIndexStats, sessionOwnershipStats } from '@podium/client-core/viewmodels'
import { MobxPool } from '@podium/client-graph/pool'
import { autorun } from 'mobx'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { IssueExplorerProvider } from '@/features/issues/explorer/explorer-context'
import { buildCorpus } from '../../../../packages/worklist-proto/harness/src/fixture/corpus'
import { seedCacheFromCorpus } from '../../../../packages/worklist-proto/shared/src/scenarios'
import { FlightDeck, type FlightDeckView } from './FlightDeck'
import { OperatorFocusProvider } from './operator-focus'
import { FoldedFlightDeckBar } from './FoldedFlightDeckBar'
import { missionLegacyCountsFor, resetMissionLegacyCounts } from './mission-pane-perf'

const state = vi.hoisted(() => ({
  layer: 'legacy' as 'legacy' | 'pool', pool: null as unknown,
  issues: [] as unknown[], sessions: [] as unknown[], repos: [], machines: [],
  selectedIssueId: null as string | null, paneA: null, paneB: null, split: false,
  coarseNow: 0, uiState: { get: (_key: string): string | null => null, set: vi.fn(), subscribe: () => () => {} },
  replica: {} as unknown, trpc: {} as unknown, issueVisitBaseline: null,
  setSelectedWorktree: vi.fn(), setSelectedIssueId: vi.fn(), openSessionTab: vi.fn(), openSessionAtTranscript: vi.fn(),
  focusIssueSession: vi.fn(), setPanelMode: vi.fn(), preferPanelMode: vi.fn(), setView: vi.fn(), markIssueRead: vi.fn(),
  markSessionRead: vi.fn(), setIssueTucked: vi.fn(), closeIssue: vi.fn(), updateIssue: vi.fn(), renameSession: vi.fn(),
}))
const owner = { getSnapshot: () => state, subscribe: () => () => {} }
vi.mock('./store', () => ({
  useStoreSelector: (read: (store: typeof state) => unknown) => read(state),
  useReplicaIssues: () => { if (state.layer === 'pool') throw new Error('Pool pane read legacy issue models'); return state.issues },
  useSessionDraft: () => '',
}))
vi.mock('@podium/client-core/react', async original => ({ ...await original<typeof import('@podium/client-core/react')>(),
  useStoreHandle: () => owner,
}))
vi.mock('./store-worklist-pool', () => ({
  useWorklistPool: () => state.pool,
  useWorklistPoolProjection: (read: (pool: MobxPool) => unknown, empty: unknown) => {
    if (!state.pool) return empty
    let result: unknown
    const stop = autorun(() => { result = read(state.pool as MobxPool) }); stop()
    return result
  },
}))
vi.mock('@/lib/pane-data-layer', () => ({ paneDataLayer: () => state.layer, initializePaneDataLayer: () => {} }))
vi.mock('@/lib/use-harness-descriptors', () => ({ useHarnessDescriptors: () => ({ served: undefined, status: 'unavailable' }) }))
vi.mock('@/lib/use-feature', () => ({ useFeature: () => true }))

const corpus = buildCorpus(1, 1)
let issues: ReturnType<typeof allIssueViewModels>
let sessions: SessionView[]
let pool: MobxPool
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(corpus.fixedNow)
  const replica = createKernelReplica({ cache: seedCacheFromCorpus(corpus), side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  issues = allIssueViewModels(replica)
  sessions = dedupeSessions(sessionViews([...replica.rows('sessions')], {
    userId: 'operator', userStates: [...replica.rows('sessionUserStates')], machines: [...replica.rows('machines')], repos: [...replica.rows('repos')],
  }))
  state.layer = 'legacy'; state.issues = issues; state.sessions = sessions; state.coarseNow = corpus.fixedNow
  state.replica = replica
  state.trpc = { cost: { task: { query: async () => null }, tasks: { query: async () => [] } },
    issues: { events: { query: async () => [] } }, sessions: { transcriptRead: { query: async () => ({ items: [], hasMore: false }) } } }
  pool = new MobxPool({ selectedIssueId: null, coarseNow: corpus.fixedNow })
  pool.apply({ type: 'replace', rows: [
    ...replica.rows('repos').map(value => ({ kind: 'repo' as const, id: value.id, value })),
    ...sessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
    ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })),
  ] })
  state.pool = pool
})
afterEach(() => { cleanup(); pool.dispose(); state.pool = null; vi.useRealTimers(); vi.clearAllMocks() })

function mount(view: FlightDeckView) {
  vi.setSystemTime(corpus.fixedNow)
  state.uiState.get = key => key === 'podium.flightDeck.mode' ? view : null
  return render(<ConfirmProvider><OperatorFocusProvider missionId={state.selectedIssueId}>
    <IssueExplorerProvider><FlightDeck onCollapse={() => {}} /></IssueExplorerProvider>
  </OperatorFocusProvider></ConfirmProvider>)
}
/** Text, labels, tag/order, CSS classes and authored layout styles. React/Base
 * UI's generated IDs and animation progress are not authored presentation. */
function renderedOutput(container: Element) {
  return [...container.querySelectorAll('*')].map(node => ({
    tag: node.tagName, text: node.childElementCount === 0 ? node.textContent : null,
    label: node.getAttribute('aria-label'), title: node.getAttribute('title'), role: node.getAttribute('role'),
    class: node.getAttribute('class'), hidden: node.getAttribute('hidden'),
    issue: node.getAttribute('data-flight-issue'), session: node.getAttribute('data-flight-session'),
    style: (node as HTMLElement).style?.cssText.replace(/(?:opacity|transform|transition)[^;]*;?/g, '') ?? '',
  }))
}
async function settled() {
  await waitFor(() => expect(document.querySelector('[data-testid="flight-settling"]')).toBeNull())
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
}

describe('rendered mission pane parity', () => {
  for (const view of ['full', 'working', 'needs-you', 'waterfall', 'handoff'] as const) it(`preserves visible words, labels, order and layout in ${view}`, async () => {
    const root = issues.find(issue => !issue.archived && !issue.deletedAt && !issue.parentId && issue.childCount >= 2 && issue.childCount < 12)!
    state.selectedIssueId = root.id
    const legacy = mount(view); await settled()
    const expected = renderedOutput(legacy.container)
    expect(missionLegacyCountsFor(owner)['root']).toBeGreaterThan(0)
    cleanup()
    state.layer = 'pool'
    resetMissionLegacyCounts(owner)
    const baseline = missionIndexStats(), ownership = sessionOwnershipStats()
    const current = mount(view); await settled()
    expect(renderedOutput(current.container)).toEqual(expected)
    expect(missionIndexStats()).toEqual(baseline)
    expect(sessionOwnershipStats()).toEqual(ownership)
    expect(missionLegacyCountsFor(owner)).toEqual({})
  }, 120_000)

  it('keeps archived-session reveal names/order and opens the same session', async () => {
    const root = issues.find(issue => !issue.archived && !issue.deletedAt && !issue.parentId &&
      sessions.some(session => session.issueId === issue.id && session.archived && !session.headless && session.agentKind !== 'shell'))!
    state.selectedIssueId = root.id
    const legacy = mount('full'); await settled()
    fireEvent.click(screen.getByRole('button', { name: /archived session/i })); await settled()
    const expected = renderedOutput(legacy.container)
    cleanup(); state.layer = 'pool'
    const current = mount('full'); await settled()
    fireEvent.click(screen.getByRole('button', { name: /archived session/i })); await settled()
    expect(renderedOutput(current.container)).toEqual(expected)
    const first = current.container.querySelector<HTMLElement>('[data-flight-session]')!
    fireEvent.doubleClick(first); await settled()
    expect(state.openSessionTab).toHaveBeenCalled()
  }, 120_000)

  it('preserves folded bar words, labels, tick order and layout', async () => {
    state.selectedIssueId = 'i1884'
    const legacy = render(<FoldedFlightDeckBar onExpand={() => {}} />)
    const expected = renderedOutput(legacy.container)
    cleanup(); state.layer = 'pool'
    const baseline = missionIndexStats(), ownership = sessionOwnershipStats()
    const current = render(<FoldedFlightDeckBar onExpand={() => {}} />)
    await waitFor(() => expect(current.container.querySelector('[data-testid="flight-deck-gauge"]')).not.toBeNull())
    expect(renderedOutput(current.container)).toEqual(expected)
    expect(missionIndexStats()).toEqual(baseline); expect(sessionOwnershipStats()).toEqual(ownership)
  }, 120_000)
})
