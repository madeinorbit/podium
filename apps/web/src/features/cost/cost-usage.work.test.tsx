// @vitest-environment happy-dom
/** POD-5645: count real RPC-backed readers, holding requested output fixed while
 * unrelated resident history and the chip's undisplayed transcripts grow 4x.
 * Proxies count source array slots; no replacement pricing/projection logic. */
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import { createSubscriptionStore } from '@podium/client-core/test-support/local-store'
import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import { taskCostRows } from '@podium/client-core/values'
import {
  asIssueId, asSessionId, asUserId,
  type CostModelTotalWire, type SessionCostWire, type TaskCostRowWire,
  type TaskCostWire, type UsageBucketWire,
} from '@podium/model/browser'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { MissionCostChip } from '@/app/MissionCostChip'
import type { Trpc } from '@/app/trpc'
import { UsageTasks } from '@/features/usage/UsageTasks'
import { UsageView } from '@/features/usage/UsageView'
import { useTaskCosts } from '@/features/usage/useTaskCosts'
import { resetUsageCache } from '@/features/usage/useUsageFeed'
import { resetPolledQueryCache } from '@/lib/use-polled-query'
import { useMissionCost } from './useMissionCost'
import { useTaskCost } from './useTaskCost'

const fixture = vi.hoisted(() => ({ handle: null as unknown }))
vi.mock('../../../../../packages/client-core/src/engine/runtime', () => ({
  createClientRuntime: () => fixture.handle,
}))

type Counts = Record<string, number>
let counting: Counts | null = null
function counted<T>(name: string, rows: T[]): T[] {
  return new Proxy(rows, {
    get(target, key, receiver) {
      if (counting && typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key))
        counting[name] = (counting[name] ?? 0) + 1
      return Reflect.get(target, key, receiver)
    },
  })
}
async function capture(run: () => void | Promise<void>): Promise<Counts> {
  const counts: Counts = {}
  counting = counts
  try {
    await act(async () => {
      await run()
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
  } finally {
    counting = null
  }
  return counts
}

afterEach(() => {
  cleanup()
  resetUsageCache()
  resetPolledQueryCache()
  vi.useRealTimers()
})

const NOW = Date.parse('2026-10-06T10:00:00Z')
const ROOT = asIssueId('cost-work-root')
function model(inputTokens = 1_000_000): CostModelTotalWire {
  return {
    model: 'claude-opus-5', inputTokens, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, messages: 25,
  }
}
function transcript(index: number): SessionCostWire {
  return {
    sessionId: asSessionId(`cost-session-${index}`), title: `Session ${index}`,
    harness: 'claude-code', running: false, models: [model()],
    firstTsMs: NOW - 3_600_000, lastTsMs: NOW,
  }
}
function wire(history: number): TaskCostWire {
  return {
    issueId: ROOT, state: 'costed',
    own: { models: [model()], messages: 25, sessionCount: history },
    rollup: { models: [model(2_000_000)], messages: 50, sessionCount: history },
    descendantCount: 4, provisional: false, floor: 'none',
    harnesses: ['claude-code'], uncostedSessionCount: 0,
    sessions: counted('hiddenTranscripts', Array.from({ length: history }, (_, i) => transcript(i))),
  }
}
function taskRows(): TaskCostRowWire[] {
  return counted('requestedTasks', Array.from({ length: 6 }, (_, i) => ({
    issueId: asIssueId(`task-${i}`), seq: i + 1, title: `Task ${i}`, stage: 'closed',
    models: [model()], windowModels: [model()], rollupModels: [model()],
    messages: 25, windowMessages: 25, rollupMessages: 25, sessionCount: 1,
    floor: 'none' as const, harnesses: ['claude-code' as const], uncostedSessionCount: 0,
  })))
}
function buckets(extra = 0): UsageBucketWire[] {
  return counted('requestedBuckets', Array.from({ length: 24 + extra }, (_, i) => ({
    hour: new Date(NOW - i * 3_600_000).toISOString(), model: 'claude-opus-5',
    inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, messages: 1,
  })))
}
function setup(history: number) {
  let cost = wire(history)
  let usage = buckets()
  const reads = {
    task: vi.fn(async () => cost),
    comparison: vi.fn(async ({ includeSessions }: { includeSessions: boolean }) => ({
      task: includeSessions ? cost : { ...cost, sessions: [] },
      cohort: { medianUsdPerReply: 0.2, taskCount: 6 },
    })),
    // RPC responses own fresh arrays, even when their contents are unchanged.
    tasks: vi.fn(async () => taskRows()),
    usage: vi.fn(async () => ({ hostname: 'fixture', buckets: usage })),
    quota: vi.fn(async () => []),
  }
  const trpc = {
    cost: { task: { query: reads.task }, taskComparison: { query: reads.comparison }, tasks: { query: reads.tasks } },
    usage: { summary: { query: reads.usage } }, quota: { history: { query: reads.quota } },
  } as unknown as Trpc
  let snapshot = {
    trpc, coarseNow: NOW,
    sessions: counted('residentHistory', Array.from({ length: history }, (_, i) => ({
      sessionId: asSessionId(`resident-${i}`), archived: true, lastActiveAt: '2026-01-01T00:00:00Z',
    }))),
  }
  const owner = { start() {}, dispose() {}, destroy() {} }
  const store = createSubscriptionStore(snapshot, undefined, owner)
  const subscribe = vi.fn(store.subscribe)
  fixture.handle = withKeyedInputs(Object.assign(owner, store, { subscribe }))
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <StoreProvider principal={asClientPrincipal(asUserId('cost-work'))}
        config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
        api={trpc} networkEnabled={false} onFatalError={() => {}}
        createReplicaFn={() => { throw new Error('fixture owns runtime') }}>
        {children}
      </StoreProvider>
    )
  }
  function heartbeat() {
    snapshot = { ...snapshot, coarseNow: NOW + 1_000 }
    store.publish(snapshot, new Set(['coarseNow']))
  }
  return {
    trpc, reads, Wrapper, subscribe,
    heartbeat,
    sessionUpdate: () => {
      // Preparing the incoming snapshot is outside the reader measurement.
      const next = { ...snapshot, sessions: counted('residentHistory', [...snapshot.sessions, {
        sessionId: asSessionId('incoming-session'), archived: false,
        lastActiveAt: new Date(NOW).toISOString(),
      }]) }
      return () => {
        snapshot = next
        store.publish(snapshot, new Set(['sessions']))
      }
    },
    addTranscript: () => {
      cost = { ...wire(history + 1),
        rollup: { models: [model(3_000_000)], messages: 75, sessionCount: history + 1 } }
    },
    addUsage: () => { usage = buckets(1) },
  }
}

for (const scale of [1, 4]) {
  it(`measures cost and usage readers with ${scale}x history`, async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const history = 80 * scale
    const report: Record<string, unknown> = { scale, history, visibleTasks: 6, visibleBuckets: 24 }
    for (const surface of ['MissionCostChip', 'useMissionCost', 'useTaskCost', 'useTaskCosts', 'UsageView']) {
      resetUsageCache()
      resetPolledQueryCache()
      const ctx = setup(history)
      let getValue: () => unknown = () => undefined
      const mount = await capture(() => {
        if (surface === 'MissionCostChip') {
          render(<MissionCostChip issueId={ROOT} onOpenInExplorer={() => {}} />, { wrapper: ctx.Wrapper })
        } else if (surface === 'UsageView') {
          render(<UsageView onClose={() => {}} />, { wrapper: ctx.Wrapper })
        } else {
          const hook = renderHook(() => surface === 'useMissionCost'
            ? useMissionCost(ctx.trpc, ROOT, false)
            : surface === 'useTaskCost'
              ? useTaskCost(ctx.trpc, ROOT)
              : useTaskCosts(ctx.trpc), { wrapper: ctx.Wrapper })
          getValue = () => hook.result.current
        }
      })
      expect(mount.residentHistory ?? 0).toBe(0)
      if (surface === 'MissionCostChip' || surface === 'useMissionCost' || surface === 'useTaskCost') {
        // Task detail requests the sessions; the mission total and popover do not.
        expect(mount.hiddenTranscripts ?? 0).toBe(surface === 'useTaskCost' ? history : 0)
        expect(surface === 'useTaskCost' ? ctx.reads.comparison : ctx.reads.task).toHaveBeenCalledTimes(1)
      }
      if (surface === 'MissionCostChip') {
        expect(screen.getByTestId('mission-cost-chip').textContent).toContain('$10')
        expect(ctx.reads.tasks).not.toHaveBeenCalled()
      }
      if (surface === 'UsageView') {
        expect(document.querySelectorAll('.usage-tasks tbody tr')).toHaveLength(6)
        expect(document.querySelectorAll('.usage-hour')).toHaveLength(168)
        expect(mount.hiddenTranscripts ?? 0).toBe(0)
        expect(mount.requestedBuckets).toBe(24)
      }
      if (surface === 'useTaskCosts') {
        expect(getValue()).toMatchObject({ rows: expect.arrayContaining([
          expect.objectContaining({ estCostUsd: 5, rollupCostUsd: 5, windowCostUsd: 5 }),
        ]) })
        expect(mount.requestedTasks).toBe(12)
      }
      expect(ctx.subscribe).not.toHaveBeenCalled()
      const unchanged = getValue()
      // Build the incoming fixture outside the measured consumer work.
      const publishSession = ctx.sessionUpdate()
      const sessionUpdate = await capture(publishSession)
      expect(sessionUpdate).toEqual({})
      expect(getValue()).toBe(unchanged)
      const heartbeat = await capture(ctx.heartbeat)
      expect(heartbeat).toEqual({})
      expect(ctx.subscribe).not.toHaveBeenCalled()
      ctx.addTranscript()
      ctx.addUsage()
      const refresh = await capture(() => { vi.advanceTimersByTime(90_000) })
      if (surface === 'MissionCostChip' || surface === 'useMissionCost' || surface === 'useTaskCost')
        expect(refresh.hiddenTranscripts ?? 0).toBe(surface === 'useTaskCost' ? history + 1 : 0)
      if (surface === 'useMissionCost' || surface === 'useTaskCost') {
        expect(getValue()).toMatchObject({ view: {
          own: { estCostUsd: 5 }, rollup: { estCostUsd: 15 },
          ratePerReplyUsd: 0.2,
        } })
      }
      if (surface === 'UsageView') expect(refresh.requestedBuckets).toBe(25)
      if (surface === 'MissionCostChip') {
        expect(screen.getByTestId('mission-cost-chip').textContent).toContain('$15')
        const disclosure = await capture(() => {
          fireEvent.click(screen.getByTestId('mission-cost-chip'))
        })
        expect(screen.getByTestId('mission-cost-popover')).toBeTruthy()
        expect(disclosure.hiddenTranscripts ?? 0).toBe(0)
        expect(disclosure.requestedTasks ?? 0).toBe(0)
        expect(ctx.reads.comparison).toHaveBeenCalledTimes(1)
        expect(ctx.reads.tasks).not.toHaveBeenCalled()
        report.missionDisclosure = disclosure
      }
      report[surface] = { mount, sessionUpdate, heartbeat, incomingRpcAnswer: refresh }
      cleanup()
    }
    // The standalone table is fed exactly the six rows it actually displays.
    const priced = taskCostRows(taskRows())
    const feed = { rows: counted('requestedTaskViews', priced.rows), cohort: priced.cohort,
      waiting: false, failed: false, retry: () => {} }
    const tableMount = await capture(() => { render(<UsageTasks feed={feed} cold={false} />) })
    const tableRanking = await capture(() => { fireEvent.click(screen.getByRole('button', { name: 'Rate' })) })
    expect(document.querySelectorAll('.usage-tasks tbody tr')).toHaveLength(6)
    report.UsageTasks = { mount: tableMount, ranking: tableRanking }
    console.log('POD-5645 real-reader work', JSON.stringify(report))
  })
}
