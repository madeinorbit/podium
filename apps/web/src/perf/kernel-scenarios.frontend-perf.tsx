import { hostname, cpus } from 'node:os'
import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime } from '@podium/client-core/engine'
import { COARSE_CLOCK_MS, openKernelEngineOutbox } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import {
  readRuntimeStoreStats,
  readStoreStats,
  storeStats,
  type StoreCounts,
} from '@podium/client-core/perf'
import {
  StoreProvider,
  StoreStatsProfiler,
  useStoreHandle,
  useStoreSelector,
  useSlice,
} from '@podium/client-core/react'
import type { SocketHub } from '@podium/client-core/socket-transport'
import { createSlicePublisher, worklistSlice } from '@podium/client-core/viewmodels'
import {
  asIssueId,
  asSessionId,
  asUserId,
  type SessionMeta,
  type HostMetricsWire,
} from '@podium/model/browser'
import { InMemoryOutboxStore } from '@podium/sync/outbox'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSessionDraft } from '@/app/store'
import { UnifiedIssueRow } from '@/features/worklist/UnifiedIssueRow'
import { BenchmarkCache, FIXED_NOW, kernelFixture, PROFILES } from './kernel-fixture'

// Only transport is replaced. Runtime, replica facade, selectors, published
// worklist, issue projection, and visible worklist rows are shipped code.
class Hub {
  handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  on(kind: string, callback: (...args: unknown[]) => void) {
    const set = this.handlers.get(kind) ?? new Set()
    set.add(callback)
    this.handlers.set(kind, set)
    return () => set.delete(callback)
  }
  emit(kind: string, value: unknown) {
    for (const callback of this.handlers.get(kind) ?? []) callback(value)
  }
  connectionHealth() {
    return { status: 'down', rttMs: null, since: 0 }
  }
  connect() {}
  connectNow() {}
  dispose() {}
  setVisible() {}
  setViewState() {}
  seedMetadata() {}
  sendSessionDraft() {}
  sendDraftEdit() {
    return true
  }
}
const repositoryFor = (index: number, repositories: number) =>
  index < 3 ? index : 3 + ((index - 3) % (repositories - 3))
const session = (index: number, repositories = 12): SessionMeta =>
  ({
    sessionId: asSessionId(`s${index}`),
    issueId: asIssueId(`i${index}`),
    agentKind: 'codex',
    cwd: `/repo-${repositoryFor(index, repositories)}`,
    title: `Session ${index}`,
    status: 'live',
    controllerId: `c${index}`,
    geometry: { cols: 80, rows: 24 },
    epoch: 1,
    clientCount: 1,
    createdAt: '2026-09-18T10:00:00Z',
    lastActiveAt: '2026-09-18T10:00:00Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: '2026-09-18T11:00:00Z',
    unread: false,
    agentState: { phase: 'working', since: '2026-09-18T10:00:00Z' },
  }) as unknown as SessionMeta

const hostFrame = (iteration: number): HostMetricsWire[] => [
  {
    hostname: 'benchmark-host',
    sampledAt: new Date(FIXED_NOW + iteration * 1000).toISOString(),
    memory: {
      totalBytes: 16_000_000_000,
      availableBytes: 8_000_000_000,
      swapTotalBytes: 0,
      swapFreeBytes: 0,
    },
  },
]

let runtime: ClientRuntime<PodiumClientApi>
function Capture() {
  runtime = useStoreHandle() as ClientRuntime<PodiumClientApi>
  return null
}
function Draft() {
  const text = useSessionDraft(asSessionId('s0'))
  return <output>{text}</output>
}
function Worklist() {
  const slice = useSlice(worklistSlice)
  const select = useStoreSelector((s) => s.setSelectedIssueId)
  const selected = useStoreSelector((s) => s.selectedIssueId)
  const sessions = useStoreSelector((s) => s.sessions)
  const rows = slice.work.filter((row) => row.kind === 'issue')
  // Constant visible neighbourhood. The real derivation still sees ALL rows.
  return (
    <>
      {rows
        .filter((row) => row.issue.id === 'i0' || row.issue.id === 'i1')
        .map((row) => (
          <UnifiedIssueRow
            key={row.issue.id}
            row={row}
            sessions={sessions}
            issues={rows.map((item) => item.issue)}
            allWorktreePaths={slice.allWorktreePaths}
            selectedIssueId={selected}
            paneA={null}
            now={slice.now}
            onSelectIssue={(issue) => select(issue.id)}
            onSelectPanelForIssue={(issue) => select(issue.id)}
            onOpenIssue={select}
            onRenameIssue={() => {}}
          />
        ))}
    </>
  )
}
const settle = async () => {
  await act(async () => {
    await runtime.outbox.drain()
    for (let n = 0; n < 20; n++) await Promise.resolve()
  })
}
const percentile = (samples: number[], q: number) =>
  [...samples].sort((a, b) => a - b)[Math.ceil(q * samples.length) - 1] ?? 0

type CountBudget = { publishes: number; worklist: number; rowBuilds: number }
function assertBudget(count: StoreCounts, budget: CountBudget, name: string) {
  expect(count.publishes, `${name}: publishes`).toBeLessThanOrEqual(budget.publishes)
  expect(count.slices.worklist ?? 0, `${name}: worklist`).toBeLessThanOrEqual(budget.worklist)
  expect(count.rowBuilds, `${name}: row builds`).toBeLessThanOrEqual(budget.rowBuilds)
}

afterEach(() => {
  cleanup()
  storeStats.enable(false)
  storeStats.reset()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('kernel-backed interaction counts', () => {
  for (const profile of PROFILES)
    for (const coldSample of [0, 1, 2, 3, 4])
      it(`${profile.name}: cold sample ${coldSample} and hot-path distribution`, async () => {
        vi.useFakeTimers({
          toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        })
        vi.setSystemTime(FIXED_NOW)
        localStorage.clear()
        window.history.replaceState(null, '', '/')
        const cache = new BenchmarkCache()
        for (let i = 0; i < profile.issues; i++) {
          cache.put('issueProjection', `i${i}`, {
            id: `i${i}`,
            seq: i + 1,
            repoId: `r${repositoryFor(i, profile.repositories)}`,
            title: `Issue ${i}`,
            stage: 'in_progress',
            description: { value: '' },
            createdAt: '2026-09-18T10:00:00Z',
            updatedAt: '2026-09-18T10:00:00Z',
            readAt: '2026-09-18T11:00:00Z',
          })
          cache.put('issue', `i${i}`, {
            id: `i${i}`,
            title: `Issue ${i}`,
            seq: i + 1,
            stage: 'in_progress',
            createdAt: '2026-09-18T10:00:00Z',
            updatedAt: '2026-09-18T10:00:00Z',
            readAt: '2026-09-18T11:00:00Z',
            repoPath: `/repo-${repositoryFor(i, profile.repositories)}`,
            pinned: false,
            origin: 'human',
            audience: 'human',
            draft: false,
            archived: false,
            labels: [],
            deps: [],
            dependents: [],
            comments: [],
            blockedByNotes: [],
            childCount: 0,
            childDoneCount: 0,
            priority: 2,
            type: 'task',
            ready: true,
            blocked: false,
            deferred: false,
            needsHuman: false,
          })
        }
        for (let i = 0; i < profile.sessions; i++)
          cache.put('session', `s${i}`, session(i, profile.repositories))
        for (let i = 0; i < profile.repositories; i++)
          cache.put('repo', `r${i}`, { id: `r${i}`, prefix: 'POD', path: `/repo-${i}` })
        const repos = Array.from({ length: profile.repositories }, (_, i) => ({
          path: `/repo-${i}`,
          branch: 'main',
          worktrees: Array.from(
            {
              length:
                Math.floor(profile.worktrees / profile.repositories) +
                (i < profile.worktrees % profile.repositories ? 1 : 0),
            },
            (_, j) => ({ path: `/wt-${i}-${j}`, branch: 'task' }),
          ),
        }))
        const { replica, upsert } = kernelFixture(cache)
        const hub = new Hub()
        let rejectRename = false
        const api = {
          sync: { changesSince: { query: () => new Promise(() => {}) } },
          discovery: {
            refreshRepos: {
              mutate: async () => ({ repositories: repos, diagnostics: [], machines: [] }),
            },
          },
          pins: { list: { query: async () => ({ panels: [], worktrees: [], repos: [] }) } },
          tabs: { listOrders: { query: async () => ({}) } },
          settings: {
            get: { query: async () => ({ sidebar: { repoSort: 'lastUsed', repoOrder: [] } }) },
          },
          superagent: { listThreads: { query: async () => [] } },
          quota: { summary: { query: () => new Promise(() => {}) } },
          sessions: {
            rename: {
              mutate: async () => {
                if (rejectRename)
                  throw Object.assign(new Error('fixture rejection'), {
                    data: { code: 'BAD_REQUEST', httpStatus: 400 },
                  })
                return {}
              },
            },
            markRead: { mutate: async () => ({}) },
          },
          issues: { markRead: { mutate: async () => ({}) } },
        } as unknown as PodiumClientApi
        const createOutboxFn = await openKernelEngineOutbox({
          store: new InMemoryOutboxStore(),
          principal: 'benchmark',
          api,
          now: () => FIXED_NOW,
          onDegraded: (detail) => {
            throw new Error(String(detail))
          },
        })
        storeStats.enable()
        storeStats.reset()
        const engineOverrides = {
          spawnConfirmGraceMs: 5000,
          createHub: () => hub as unknown as SocketHub,
        }
        const started = performance.now()
        render(
          <StoreProvider
            principal={asClientPrincipal(asUserId('benchmark'))}
            config={{ httpOrigin: 'http://fixture', wsClientUrl: 'ws://fixture' }}
            api={api}
            createReplicaFn={() => replica}
            createOutboxFn={createOutboxFn}
            engineOverrides={engineOverrides}
            onFatalError={(message) => {
              throw new Error(message)
            }}
          >
            <Capture />
            <StoreStatsProfiler>
              <Worklist />
              <Draft />
            </StoreStatsProfiler>
          </StoreProvider>,
        )
        await settle()
        console.info(
          '[large-state-kernel]',
          JSON.stringify({
            profile: profile.name,
            scenario: 'cold-start',
            ms: performance.now() - started,
            counts: readRuntimeStoreStats(runtime),
          }),
        )
        expect(document.querySelectorAll('[data-issue-row]')).toHaveLength(2)
        expect(replica.rows('sessions')).toHaveLength(profile.sessions)
        expect(replica.rows('issueProjections')).toHaveLength(profile.issues)
        const coldCounts = readRuntimeStoreStats(runtime)!
        assertBudget(
          coldCounts,
          { publishes: 10, worklist: 2, rowBuilds: profile.issues },
          'cold-start',
        )
        expect(coldCounts.rowBuilds).toBe(profile.issues)
        if (coldSample > 0) return
        const measure = async (
          name: string,
          action: (iteration: number) => void | Promise<void>,
          budget: CountBudget,
          afterSample?: () => Promise<void>,
        ) => {
          const samples: number[] = []
          const synchronous: number[] = []
          const counts = []
          const publications = []
          const durableReads: number[] = []
          for (let iteration = 0; iteration < 20; iteration++) {
            storeStats.reset()
            const window = storeStats.begin('feed')
            const scans = cache.scans
            const reads = cache.reads
            const start = performance.now()
            await act(async () => {
              const entered = performance.now()
              const pending = action(iteration)
              synchronous.push(performance.now() - entered)
              await pending
            })
            await settle()
            samples.push(performance.now() - start)
            storeStats.end(window)
            const count = readRuntimeStoreStats(runtime) ?? {
              publishes: 0,
              nestedPublishes: 0,
              subscriberWakes: 0,
              selectorRuns: 0,
              selectorCacheMisses: 0,
              rowBuilds: 0,
              reactCommits: 0,
              slices: {} as Record<string, number>,
            }
            counts.push(count)
            assertBudget(count, budget, name)
            publications.push(
              readStoreStats().publishes.map(({ changedKeys, nested, subscriberWakes }) => ({
                changedKeys,
                nested,
                subscriberWakes,
              })),
            )
            durableReads.push(cache.reads - reads)
            expect(cache.scans, `${name}: full durable scans`).toBe(scans)
            expect(readStoreStats().dropped).toBe(0)
            if (afterSample) {
              await act(afterSample)
              await settle()
            }
          }
          console.info(
            '[large-state-kernel]',
            JSON.stringify({
              profile: profile.name,
              scenario: name,
              runner: { hostname: hostname(), cpu: cpus()[0]?.model, bun: process.versions.bun },
              n: samples.length,
              p50: percentile(samples, 0.5),
              p95: percentile(samples, 0.95),
              syncP50: percentile(synchronous, 0.5),
              syncP95: percentile(synchronous, 0.95),
              counts,
              publications,
              durableReads,
            }),
          )
        }
        await measure(
          'unrelated-session',
          (i) => {
            const changed = {
              ...session(2),
              lastActiveAt: new Date(FIXED_NOW + i * 1000).toISOString(),
            }
            upsert('session', 's2', changed)
            expect(
              runtime.getSnapshot().sessions.find((row) => row.sessionId === 's2')?.lastActiveAt,
            ).toBe(changed.lastActiveAt)
          },
          { publishes: 1, worklist: 1, rowBuilds: 1 },
        )
        await measure(
          'draft-A',
          (i) => {
            runtime.getSnapshot().setSessionDraft(asSessionId('s0'), `Draft ${i}`)
            expect(runtime.getSnapshot().drafts.s0).toBe(`Draft ${i}`)
          },
          { publishes: 1, worklist: 0, rowBuilds: 0 },
        )
        await measure(
          'hostMetrics',
          (i) => {
            const frame = hostFrame(i)
            hub.emit('hostMetrics', frame)
            expect(runtime.hostMetrics.getSnapshot()).toBe(frame)
          },
          { publishes: 0, worklist: 0, rowBuilds: 0 },
        )
        await measure(
          'coarseNow',
          async () => {
            await vi.advanceTimersByTimeAsync(COARSE_CLOCK_MS)
            expect(runtime.getSnapshot().coarseNow).toBe(Date.now())
          },
          { publishes: 1, worklist: 1, rowBuilds: 0 },
        )
        await measure(
          'issue-click',
          (i) => {
            const id = `i${i % 2}`
            const row = document.querySelector(`[data-issue-row="${id}"]`)
            expect(row).not.toBeNull()
            fireEvent.click(row!.querySelector('button[data-pressable]')!)
            expect(runtime.getSnapshot().selectedIssueId).toBe(id)
          },
          { publishes: 1, worklist: 1, rowBuilds: 0 },
        )
        await measure(
          'optimistic-echo',
          async (i) => {
            const pending = runtime.getSnapshot().renameSession(asSessionId('s2'), `Echo ${i}`)
            expect(runtime.getSnapshot().sessions.find((s) => s.sessionId === 's2')?.name).toBe(
              `Echo ${i}`,
            )
            await pending
            upsert('session', 's2', { ...session(2), name: `Echo ${i}` })
            await settle()
            expect(runtime.getSnapshot().sessions.find((s) => s.sessionId === 's2')?.name).toBe(
              `Echo ${i}`,
            )
          },
          { publishes: 7, worklist: 2, rowBuilds: 1 },
        )
        rejectRename = true
        await measure(
          'optimistic-rejection',
          async (i) => {
            const pending = runtime.getSnapshot().renameSession(asSessionId('s2'), `Rejected ${i}`)
            expect(runtime.getSnapshot().sessions.find((s) => s.sessionId === 's2')?.name).toBe(
              `Rejected ${i}`,
            )
            await pending
            await settle()
            expect(runtime.getSnapshot().sessions.find((s) => s.sessionId === 's2')?.name).toBe(
              'Echo 19',
            )
            expect(runtime.outbox.deadLetters()).toHaveLength(1)
          },
          { publishes: 7, worklist: 2, rowBuilds: 0 },
          async () => {
            // A definitive rejection blocks this partition until the user resolves it.
            // Discard BETWEEN samples, outside the measurement window.
            for (const letter of runtime.outbox.deadLetters())
              await runtime.outbox.discard(letter.entry.mutationId)
          },
        )
        await measure(
          'mixed-feed',
          (i) => {
            hub.emit('hostMetrics', hostFrame(i))
            upsert('session', 's2', { ...session(2), title: `Mixed ${i}` })
            runtime.getSnapshot().setSessionDraft(asSessionId('s0'), `Mixed draft ${i}`)
          },
          { publishes: 2, worklist: 1, rowBuilds: 1 },
        )
        // Counterfactual control: restore the pre-guard derivation policy over the
        // SAME runtime and SAME worklist definition. A real draft now derives the
        // slice, and the exact production budget assertion must reject the result.
        const { sourceEqual: _guard, ...unconditional } = worklistSlice
        const control = createSlicePublisher(() => runtime.getSnapshot(), runtime)
        control.read(unconditional)
        const off = runtime.subscribe(() => control.read(unconditional))
        storeStats.reset()
        await act(async () =>
          runtime.getSnapshot().setSessionDraft(asSessionId('s0'), 'control draft'),
        )
        await settle()
        off()
        const before = readRuntimeStoreStats(runtime)!
        expect(before.slices.worklist).toBe(1)
        expect(() =>
          assertBudget(before, { publishes: 1, worklist: 0, rowBuilds: 0 }, 'draft-A'),
        ).toThrow('draft-A: worklist')
        storeStats.reset()
        await act(async () =>
          runtime.getSnapshot().setSessionDraft(asSessionId('s0'), 'guarded draft'),
        )
        await settle()
        const after = readRuntimeStoreStats(runtime)!
        assertBudget(after, { publishes: 1, worklist: 0, rowBuilds: 0 }, 'draft-A')
        console.info(
          '[large-state-kernel]',
          JSON.stringify({
            profile: profile.name,
            scenario: 'guard-negative-control',
            before,
            after,
          }),
        )
      }, 120_000)
})
