// @vitest-environment happy-dom
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import { createSubscriptionStore } from '@podium/client-core/store'
import type { IssueNavigationModel } from '@podium/client-core/viewmodels'
import { asIssueId, asSessionId, asUserId, type TaskCostWire } from '@podium/model/browser'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MessageLedgerView } from '@/features/messages/MessageLedgerView'
import { UsageView } from '@/features/usage/UsageView'
import { resetUsageCache } from '@/features/usage/useUsageFeed'
import { resetPolledQueryCache } from '@/lib/use-polled-query'
import { FlightDeckHandoff } from './FlightDeckHandoff'
import { useWaterfallActivity } from './FlightDeckWaterfall'
import { MissionCostChip } from './MissionCostChip'
import type { Store } from './store'
import type { Trpc } from './trpc'
import { useHandoffTranscript } from './use-handoff-transcript'

// Keep the real provider, hooks, subscription store and counters. Only runtime
// construction is replaced; a planted legacy selector therefore really subscribes.
const fixture = vi.hoisted(() => ({ handle: null as unknown }))
vi.mock('../../../../packages/client-core/src/engine/runtime', () => ({
  createClientRuntime: () => fixture.handle,
}))
vi.mock('./store', async () => {
  const core = await import('@podium/client-core/react')
  return { useStoreSelector: core.useStoreSelector }
})

afterEach(() => {
  cleanup()
  resetUsageCache()
  resetPolledQueryCache()
  storeStats.enable(false)
  storeStats.reset()
})

const session = {
  sessionId: asSessionId('utility-session'), issueId: asIssueId('utility-root'),
  agentKind: 'codex', cwd: '/synthetic', status: 'live', archived: false,
  createdAt: '2026-10-02T09:00:00Z', lastInputAt: '2026-10-02T10:00:00Z',
  lastActiveAt: '2026-10-02T10:00:00Z', transcriptAvailable: true,
} as SessionView
const issue = {
  id: asIssueId('utility-root'), seq: 1, title: 'Synthetic review', stage: 'review',
  updatedAt: '2026-10-02T10:00:00Z', deps: [], parentId: null,
} as unknown as IssueNavigationModel

function setup() {
  const reads = {
    usage: vi.fn(async () => ({ hostname: 'synthetic', buckets: [] })),
    quota: vi.fn(async () => []), tasks: vi.fn(async () => []),
    cost: vi.fn(async () => ({ issueId: issue.id, state: 'pending',
      own: { models: [], messages: 0, sessionCount: 0 }, rollup: { models: [], messages: 0, sessionCount: 0 },
      descendantCount: 0, provisional: false, floor: 'none', harnesses: [], uncostedSessionCount: 0, sessions: [] } satisfies TaskCostWire)),
    ledger: vi.fn(async () => []),
    events: vi.fn(async () => []),
    history: vi.fn(async () => ({ sessions: { [session.sessionId]: [{ at: session.createdAt, phase: 'working' }] } })),
    transcript: vi.fn(async () => ({ items: [{ id: 'prompt', role: 'user', text: 'Synthetic prompt' }], hasMore: false })),
  }
  const trpc = {
    usage: { summary: { query: reads.usage } }, quota: { history: { query: reads.quota } },
    cost: { task: { query: reads.cost }, tasks: { query: reads.tasks } },
    messages: { ledger: { query: reads.ledger } }, issues: { events: { query: reads.events } },
    sessions: { activityHistory: { query: reads.history }, transcriptRead: { query: reads.transcript } },
  } as unknown as Trpc
  const replica = { transcriptWindow: () => undefined, putTranscriptWindow: vi.fn() }
  const owner = { start() {}, dispose() {}, destroy() {} }
  const snapshot = { trpc, replica, coarseNow: 0 } as unknown as Store
  const store = createSubscriptionStore(snapshot, undefined, owner)
  const subscribe = vi.fn(store.subscribe)
  fixture.handle = Object.assign(owner, store, { subscribe })
  function Wrapper({ children }: { children: ReactNode }) {
    return <StoreProvider
      principal={asClientPrincipal(asUserId('utility-test'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={trpc} networkEnabled={false} onFatalError={() => {}}
      createReplicaFn={() => { throw new Error('fixture owns runtime') }}
    >{children}</StoreProvider>
  }
  async function prove() {
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
    expect(subscribe).not.toHaveBeenCalled()
    storeStats.enable()
    storeStats.reset()
    act(() => {
      for (let coarseNow = 1; coarseNow <= 20; coarseNow++) {
        store.publish({ ...snapshot, coarseNow }, new Set(['coarseNow']))
      }
    })
    expect(storeStats.snapshot().runtimes).toHaveLength(1)
    expect(storeStats.snapshot().runtimes[0]).toMatchObject({
      publishes: 20, subscriberWakes: 0, selectorRuns: 0, selectorCacheMisses: 0, slices: {},
    })
    expect(subscribe).not.toHaveBeenCalled()
  }
  return { reads, replica, Wrapper, prove }
}

it('UsageView acquires the existing runtime API without a snapshot subscription', async () => {
  const ctx = setup()
  const view = render(<UsageView onClose={() => {}} />, { wrapper: ctx.Wrapper })
  await ctx.prove()
  expect(view.getByTestId('usage-sheet').textContent).toContain('No token usage recorded yet.')
  expect(ctx.reads.usage).toHaveBeenCalledTimes(1)
  expect(ctx.reads.quota).toHaveBeenCalledExactlyOnceWith({})
  expect(ctx.reads.tasks).toHaveBeenCalledTimes(1)
})

it('MessageLedgerView acquires the existing runtime API without a snapshot subscription', async () => {
  const ctx = setup()
  const view = render(<MessageLedgerView issueId={issue.id} sessionId={session.sessionId} />, { wrapper: ctx.Wrapper })
  await ctx.prove()
  expect(ctx.reads.ledger).toHaveBeenCalledExactlyOnceWith({ issueId: issue.id, sessionId: session.sessionId })
  expect(view.getByTestId('message-ledger').textContent).toContain('No messages for this scope yet.')
})

it('MissionCostChip acquires the existing runtime API without a snapshot subscription', async () => {
  const ctx = setup()
  render(<MissionCostChip issueId={issue.id} onOpenInExplorer={() => {}} />, { wrapper: ctx.Wrapper })
  await ctx.prove()
  expect(ctx.reads.cost).toHaveBeenCalledExactlyOnceWith({ issueId: issue.id })
  expect(ctx.reads.tasks).not.toHaveBeenCalled()
})

it('FlightDeckHandoff acquires review events without a snapshot subscription', async () => {
  const ctx = setup()
  const view = render(<FlightDeckHandoff rootIssue={issue} issues={[issue]} sessions={[]}
    visitReadAt={null} proposed={null} onOpenTranscript={() => {}} onOpenSession={() => {}} onOpenIssue={() => {}}
  />, { wrapper: ctx.Wrapper })
  await ctx.prove()
  expect(ctx.reads.events).toHaveBeenCalledExactlyOnceWith({ since: 0, repoPath: null, subject: issue.id, limit: 200 })
  expect(view.getByTestId('flight-deck-handoff').textContent).toContain('Ready for review.')
})

it('FlightDeckWaterfall activity acquires the existing runtime API without a snapshot subscription', async () => {
  const ctx = setup()
  const { result } = renderHook(() => useWaterfallActivity([session]), { wrapper: ctx.Wrapper })
  await ctx.prove()
  expect(ctx.reads.history).toHaveBeenCalledExactlyOnceWith({ sessionIds: [session.sessionId] })
  expect(result.current.get(session.sessionId)).toEqual([{ at: Date.parse(session.createdAt), phase: 'working' }])
})

it('useHandoffTranscript acquires the existing runtime and replica without a snapshot subscription', async () => {
  const ctx = setup()
  const { result } = renderHook(() => useHandoffTranscript(true, [session]), { wrapper: ctx.Wrapper })
  await ctx.prove()
  expect(ctx.reads.transcript).toHaveBeenCalledExactlyOnceWith({ sessionId: session.sessionId, direction: 'before', limit: 200 })
  expect(result.current.pair?.prompt.item.text).toBe('Synthetic prompt')
  expect(ctx.replica.putTranscriptWindow).toHaveBeenCalledTimes(1)
})
