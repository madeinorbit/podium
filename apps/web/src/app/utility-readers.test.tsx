import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'

// @vitest-environment happy-dom
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import { createSubscriptionStore } from '@podium/client-core/test-support/local-store'
import { TranscriptLog } from '@podium/client-core/conversation'
import type { TranscriptPage } from '@podium/client-core/transcript'
import type { IssueNavigationModel } from '@podium/client-core/values'
import { asIssueId, asSessionId, asUserId, type SessionId, type TaskCostWire } from '@podium/model/browser'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { observer } from 'mobx-react-lite'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MessageLedgerView } from '@/features/messages/MessageLedgerView'
import { UsageView } from '@/features/usage/UsageView'
import { resetUsageCache } from '@/features/usage/useUsageFeed'
import { resetPolledQueryCache } from '@/lib/use-polled-query'
import { MissionScreen } from '@podium/client-graph/mission-screen'
import { MobxPool } from '@podium/client-graph/pool'
import { FlightDeckHandoff } from './FlightDeckHandoff'
import { useWaterfallActivity } from './FlightDeckWaterfall'
import { MissionCostChip } from './MissionCostChip'
import type { ReferenceState } from '../../../../tests/worklist/diagnostics/reference-state'
type Store = ReferenceState<import('@/app/trpc').Trpc>
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
  return { useRuntimeSelector: core.useRuntimeSelector }
})

// The handoff reads the session's shared conversation. Stand in a thin shell
// holding a REAL retained TranscriptLog: the hook under test only touches
// conversation.transcript, while the shell boundary itself is owned by the
// conversation suites.
const conversationShells = vi.hoisted(() => new Map<string, { conversation: { transcript: TranscriptLog; start: () => Promise<void> }; started: boolean }>())
vi.mock('@podium/client-core/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/client-core/react')>()
  return {
    ...actual,
    useConversation: (
      sessionId: SessionId | undefined,
      _factory: unknown,
      options?: { enabled?: boolean },
    ) => {
      if (sessionId === undefined || options?.enabled === false) return undefined
      const shell = conversationShells.get(sessionId)
      if (shell && !shell.started) {
        shell.started = true
        void shell.conversation.start()
      }
      return shell?.conversation
    },
  }
})
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => ({}),
}))
vi.mock('@/features/chat/use-conversation', () => ({
  createWebConversation: vi.fn(),
}))

afterEach(() => {
  cleanup()
  resetUsageCache()
  resetPolledQueryCache()
  storeStats.enable(false)
  storeStats.reset()
  for (const shell of conversationShells.values()) shell.conversation.transcript.dispose()
  conversationShells.clear()
})

const session = {
  sessionId: asSessionId('utility-session'),
  issueId: asIssueId('utility-root'),
  agentKind: 'codex',
  cwd: '/synthetic',
  status: 'live',
  archived: false,
  createdAt: '2026-10-02T09:00:00Z',
  lastInputAt: '2026-10-02T10:00:00Z',
  lastActiveAt: '2026-10-02T10:00:00Z',
  transcriptAvailable: true,
} as SessionView
const issue = {
  id: asIssueId('utility-root'),
  seq: 1,
  title: 'Synthetic review',
  stage: 'review',
  updatedAt: '2026-10-02T10:00:00Z',
  deps: [],
  parentId: null,
} as unknown as IssueNavigationModel

function setup() {
  const reads = {
    usage: vi.fn(async () => ({ hostname: 'synthetic', buckets: [] })),
    quota: vi.fn(async () => []),
    tasks: vi.fn(async () => []),
    cost: vi.fn(
      async () =>
        ({
          issueId: issue.id,
          state: 'pending',
          own: { models: [], messages: 0, sessionCount: 0 },
          rollup: { models: [], messages: 0, sessionCount: 0 },
          descendantCount: 0,
          provisional: false,
          floor: 'none',
          harnesses: [],
          uncostedSessionCount: 0,
          sessions: [],
        }) satisfies TaskCostWire,
    ),
    ledger: vi.fn(async () => []),
    events: vi.fn(async () => []),
    history: vi.fn(async () => ({
      sessions: { [session.sessionId]: [{ at: session.createdAt, phase: 'working' }] },
    })),
    transcript: vi.fn(async (): Promise<TranscriptPage> => ({
      items: [{ id: 'prompt', role: 'user', text: 'Synthetic prompt' }],
      hasMore: false,
    })),
  }
  const trpc = {
    usage: { summary: { query: reads.usage } },
    quota: { history: { query: reads.quota } },
    cost: { task: { query: reads.cost }, tasks: { query: reads.tasks } },
    messages: { ledger: { query: reads.ledger } },
    issues: { events: { query: reads.events } },
    sessions: {
      activityHistory: { query: reads.history },
      transcriptRead: { query: reads.transcript },
    },
  } as unknown as Trpc
  const replica = { transcriptWindow: () => undefined, putTranscriptWindow: vi.fn() }
  const owner = { start() {}, dispose() {}, destroy() {} }
  const snapshot = { trpc, replica, coarseNow: 0 } as unknown as Store
  const store = createSubscriptionStore(snapshot, undefined, owner)
  const subscribe = vi.fn(store.subscribe)
  fixture.handle = withKeyedInputs(Object.assign(owner, store, { subscribe }))
  const log = new TranscriptLog({
    sessionId: session.sessionId,
    source: { read: reads.transcript, subscribe: () => () => {} },
    cache: { read: replica.transcriptWindow, write: replica.putTranscriptWindow },
    retainHistory: () => true,
  })
  conversationShells.set(session.sessionId, {
    conversation: { transcript: log, start: () => log.start() },
    started: false,
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <StoreProvider
        principal={asClientPrincipal(asUserId('utility-test'))}
        config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
        api={trpc}
        networkEnabled={false}
        onFatalError={() => {}}
        createReplicaFn={() => {
          throw new Error('fixture owns runtime')
        }}
      >
        {children}
      </StoreProvider>
    )
  }
  async function prove() {
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
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
      publishes: 20,
      subscriberWakes: 0,
      selectorRuns: 0,
      selectorCacheMisses: 0,
      slices: {},
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
  const view = render(<MessageLedgerView issueId={issue.id} sessionId={session.sessionId} />, {
    wrapper: ctx.Wrapper,
  })
  await ctx.prove()
  expect(ctx.reads.ledger).toHaveBeenCalledExactlyOnceWith({
    issueId: issue.id,
    sessionId: session.sessionId,
  })
  expect(view.getByTestId('message-ledger').textContent).toContain(
    'No messages for this scope yet.',
  )
})

it('MissionCostChip acquires the existing runtime API without a snapshot subscription', async () => {
  const ctx = setup()
  render(<MissionCostChip issueId={issue.id} onOpenInExplorer={() => {}} />, {
    wrapper: ctx.Wrapper,
  })
  await ctx.prove()
  expect(ctx.reads.cost).toHaveBeenCalledExactlyOnceWith({ issueId: issue.id })
  expect(ctx.reads.tasks).not.toHaveBeenCalled()
})

it('FlightDeckHandoff acquires review events without a snapshot subscription', async () => {
  const ctx = setup()
  // The timeline's review-return counts are the opening's request answers.
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(issue.updatedAt) })
  pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: issue.id, value: issue }] })
  const opening = new MissionScreen(pool, issue.id, { issueEvents: ctx.reads.events })
  opening.open()
  const view = render(
    <FlightDeckHandoff
      rootIssue={issue}
      issue={(id) => (id === issue.id ? issue : undefined)}
      reviewReturns={opening}
      lookupSession={() => undefined}
      poolValues={{
        crew: [],
        retired: { count: 0, latestPrompt: null },
        current: [{ kind: 'review', issueId: issue.id, text: 'Ready for review.' }],
        next: [],
      }}
      visitReadAt={null}
      proposed={null}
      onOpenTranscript={() => {}}
      onOpenSession={() => {}}
      onOpenIssue={() => {}}
    />,
    { wrapper: ctx.Wrapper },
  )
  await ctx.prove()
  expect(ctx.reads.events).toHaveBeenCalledExactlyOnceWith({
    since: 0,
    repoPath: null,
    subject: issue.id,
    limit: 200,
  })
  expect(view.getByTestId('flight-deck-handoff').textContent).toContain('Ready for review.')
  opening.close()
  pool.dispose()
})

it('FlightDeckWaterfall activity acquires the existing runtime API without a snapshot subscription', async () => {
  const ctx = setup()
  const { result } = renderHook(() => useWaterfallActivity([session]), { wrapper: ctx.Wrapper })
  await ctx.prove()
  expect(ctx.reads.history).toHaveBeenCalledExactlyOnceWith({ sessionIds: [session.sessionId] })
  expect(result.current.get(session.sessionId)).toEqual([
    { at: Date.parse(session.createdAt), phase: 'working' },
  ])
})

it('useHandoffTranscript acquires the existing runtime and replica without a snapshot subscription', async () => {
  const ctx = setup()
  // The hook reads the shared log while rendering, so its consumer is an
  // observer like the handoff leaf in FlightDeckHandoff.
  const ref: { current: ReturnType<typeof useHandoffTranscript> | undefined } = {
    current: undefined,
  }
  const Probe = observer(function Probe() {
    ref.current = useHandoffTranscript(true, [session])
    return null
  })
  render(<Probe />, { wrapper: ctx.Wrapper })
  await ctx.prove()
  expect(ctx.reads.transcript).toHaveBeenCalledExactlyOnceWith({
    sessionId: session.sessionId,
    direction: 'before',
    limit: 200,
  })
  expect(ref.current?.pair?.prompt.item.text).toBe('Synthetic prompt')
  expect(ctx.replica.putTranscriptWindow).toHaveBeenCalledTimes(1)
})
