// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { Profiler, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  asIssueId,
  asMachineId,
  asSessionId,
  type IssueWire,
  type SessionMeta,
} from '@podium/model'
import type { Store } from '../../../engine/types'
import {
  readRuntimeStoreStats,
  recordStorePublish,
  recordStoreReactCommit,
  recordStoreSubscriber,
  storeStats,
} from '../../../perf/store-stats'
import { useSlice } from '../../../react/use-slice'
import { createSlicePublisher } from '../publish'
import { worklistSlice, type WorklistSlice } from './published'
import { rowMotionPhase, rowMotionTiming, rowStatusLine } from './row-attention'
import {
  worklistIssuesEqual,
  worklistMachinesEqual,
  worklistPinsEqual,
  worklistReposEqual,
  worklistSessionSignature,
  worklistSessionsEqual,
} from './material'

const context = vi.hoisted(() => ({ handle: undefined as unknown }))
vi.mock('../../../react/provider', () => ({ useStoreHandle: () => context.handle }))
const NOW = Date.parse('2026-09-18T12:00:00Z')
const AT = new Date(NOW).toISOString()
function session(id = 's1', patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: asSessionId(id),
    agentKind: 'codex',
    title: id,
    cwd: '/repo',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: AT,
    lastActiveAt: AT,
    origin: { kind: 'spawn' },
    archived: false,
    readAt: AT,
    unread: false,
    issueId: asIssueId('i1'),
    agentState: { phase: 'working', since: AT, nativeSubagentCount: 0 },
    ...patch,
  }
}
function issue(id = 'i1', patch: Partial<IssueWire> = {}): IssueWire {
  return {
    id,
    seq: 1,
    title: id,
    description: '',
    stage: 'in_progress',
    repoPath: '/repo',
    worktreePath: '/repo',
    branch: 'feature',
    parentBranch: 'main',
    createdAt: AT,
    updatedAt: AT,
    archived: false,
    audience: 'human',
    origin: 'human',
    draft: false,
    pinned: false,
    needsHuman: false,
    blocked: false,
    ready: true,
    deps: [],
    dependents: [],
    labels: [],
    comments: [],
    blockedByNotes: [],
    ...patch,
  } as IssueWire
}
function world(): Store {
  return {
    sessions: [session(), session('s2')],
    issues: [issue(), issue('i2')],
    issueProjections: [],
    repos: [{ path: '/repo', branch: 'main', machineId: asMachineId('m1'), worktrees: [] }],
    machines: [
      { id: asMachineId('m1'), name: 'one' },
      { id: asMachineId('m2'), name: 'two' },
    ],
    pins: { panels: [], repos: [], worktrees: [] },
    coarseNow: NOW,
    selectedIssueId: null,
  } as unknown as Store
}
function handleFor(initial: Store) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const handle = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    publish: (patch: Partial<Store>) => {
      snapshot = { ...snapshot, ...patch }
      const publication = recordStorePublish(handle, new Set(Object.keys(patch)))
      for (const listener of listeners) {
        recordStoreSubscriber(handle, publication)
        listener()
      }
    },
  }
  return handle
}
function visible(slice: WorklistSlice) {
  return {
    rows: slice.work.map((row) => ({
      id: row.kind === 'issue' ? row.issue.id : row.worktree.path,
      title: row.kind === 'issue' ? row.issue.title : row.worktree.branch,
      sessions: (row.kind === 'issue' ? row.sessions : row.worktree.sessions).map((s) => [
        s.sessionId,
        s.title,
      ]),
      phase: rowMotionPhase(row),
      timing: rowMotionTiming(row),
      status: rowStatusLine(row, slice.now),
    })),
    repos: [...slice.sections.pinnedRepos, ...slice.sections.repos].map((repo) => [
      repo.path,
      repo.worktrees.map((w) => [w.path, w.branch, w.sessions.map((s) => s.sessionId)]),
    ]),
    groups: slice.groups.map((group) => ({
      key: group.key,
      snoozed: group.snoozedRows.map((row) => row.issue.id),
      closed: group.closedRows.map((row) => row.issue.id),
    })),
  }
}
afterEach(() => {
  cleanup()
  storeStats.enable(false)
  storeStats.reset()
})

// Exact old source guard for this fixture (no replica/projection builder).
const legacySlice = {
  ...worklistSlice,
  sourceEqual: (a: Store, b: Store) =>
    a.repos === b.repos &&
    a.machines === b.machines &&
    a.sessions === b.sessions &&
    a.pins === b.pins &&
    a.issues === b.issues &&
    a.coarseNow === b.coarseNow &&
    a.selectedIssueId === b.selectedIssueId,
}

describe('worklist material inputs', () => {
  it('A/B: unrelated session and machine publications cause zero derivations and seven-reader commits', async () => {
    const results = []
    for (const legacy of [true, false]) {
      const handle = handleFor(world())
      context.handle = handle
      const definition = legacy ? legacySlice : worklistSlice
      const commits = Array<number>(7).fill(0)
      let controlCommits = 0
      function Reader({ index }: { index: number }) {
        const slice = useSlice(definition)
        return (
          <Profiler
            id={`worklist-${index}`}
            onRender={() => {
              commits[index]!++
              recordStoreReactCommit(handle)
            }}
          >
            <span data-testid={`reader-${index}`}>{JSON.stringify(visible(slice))}</span>
          </Profiler>
        )
      }
      function Control() {
        const snapshot = useSyncExternalStore(handle.subscribe, handle.getSnapshot)
        return (
          <Profiler id="transport-control" onRender={() => controlCommits++}>
            <span data-testid="control">
              {snapshot.sessions[0]!.geometry.cols}:{snapshot.machines[0]!.name}
            </span>
          </Profiler>
        )
      }
      const root = render(
        <>
          {commits.map((_, index) => (
            <Reader key={index} index={index} />
          ))}
          <Control />
        </>,
      )
      const initial = root.getByTestId('reader-0').textContent
      for (const kind of ['sessions', 'machines'] as const) {
        commits.fill(0)
        controlCommits = 0
        storeStats.reset()
        storeStats.enable()
        for (let frame = 1; frame <= 3; frame++) {
          const before = handle.getSnapshot()
          await act(async () =>
            handle.publish(
              kind === 'sessions'
                ? {
                    sessions: before.sessions.map((s) => ({
                      ...s,
                      geometry: { cols: 80 + frame, rows: 24 },
                      agentState: {
                        ...s.agentState!,
                        stateObservedAt: String(frame),
                        stateConfidence: frame / 3,
                      },
                    })),
                  }
                : { machines: before.machines.map((m) => ({ ...m, name: `machine-${frame}` })) },
            ),
          )
          expect(root.getByTestId('control').textContent).toBe(
            kind === 'sessions' ? `${80 + frame}:one` : `83:machine-${frame}`,
          )
          for (let index = 0; index < 7; index++)
            expect(root.getByTestId(`reader-${index}`).textContent).toBe(initial)
        }
        const stats = readRuntimeStoreStats(handle)!
        const counts = {
          publishes: stats.publishes,
          derivations: stats.slices.worklist ?? 0,
          readerCommits: stats.reactCommits,
          controlCommits,
          eachReader: [...commits],
        }
        results.push({ legacy, kind, ...counts })
        const accepted = {
          publishes: 3,
          derivations: 0,
          readerCommits: 0,
          controlCommits: 3,
          eachReader: Array(7).fill(0),
        }
        if (legacy) expect(() => expect(counts).toEqual(accepted)).toThrow()
        expect(counts).toEqual(
          legacy
            ? { ...accepted, derivations: 3, readerCommits: 21, eachReader: Array(7).fill(3) }
            : accepted,
        )
      }
      // Material controls: all seven real useSlice readers must still commit.
      const original = handle.getSnapshot()
      const changes: Partial<Store>[] = [
        { sessions: original.sessions.map((s) => ({ ...s, title: 'renamed' })) },
        { sessions: original.sessions.map((s) => ({ ...s, status: 'hibernated' })) },
        {
          sessions: original.sessions.map((s) => ({
            ...s,
            agentState: { ...s.agentState!, phase: 'needs_user' },
          })),
        },
        { issues: original.issues.map((i) => ({ ...i, stage: 'review' })) },
        {
          issues: original.issues.map((i) => ({
            ...i,
            deferUntil: new Date(NOW + 60_000).toISOString(),
          })),
        },
        { sessions: original.sessions.map((s) => ({ ...s, issueId: asIssueId('i2') })) },
        { sessions: [original.sessions[0]!] },
        { sessions: original.sessions },
        { sessions: [...original.sessions].reverse() },
        { issues: [original.issues[0]!] },
        { issues: original.issues },
        { machines: [original.machines[1]!] },
        { machines: original.machines },
        { coarseNow: NOW + 60_000 },
      ]
      for (const patch of changes) {
        commits.fill(0)
        storeStats.reset()
        await act(async () => handle.publish(patch))
        expect(commits).toEqual(Array(7).fill(1))
        expect(readRuntimeStoreStats(handle)?.slices.worklist).toBe(1)
        const expected = JSON.stringify(visible(worklistSlice.derive(handle.getSnapshot())))
        for (let index = 0; index < 7; index++)
          expect(root.getByTestId(`reader-${index}`).textContent).toBe(expected)
      }
      root.unmount()
    }
    console.info('worklist A/B (3 frames per class, 7 real useSlice readers)', results)
  })

  it('dependency mutation control: omitting title freezes a rendered value and fails the same oracle', () => {
    const verify = (definition: typeof worklistSlice) => {
      let store = world()
      const publisher = createSlicePublisher(() => store)
      publisher.read(definition)
      store = { ...store, sessions: store.sessions.map((s) => ({ ...s, title: 'new title' })) }
      expect(visible(publisher.read(definition))).toEqual(visible(worklistSlice.derive(store)))
    }
    verify(worklistSlice)
    const withoutTitle = {
      ...worklistSlice,
      sourceEqual: (a: Store, b: Store) =>
        worklistSlice.sourceEqual!(a, {
          ...b,
          sessions: b.sessions.map((s, index) => ({ ...s, title: a.sessions[index]!.title })),
        }),
    }
    expect(() => verify(withoutTitle)).toThrow()
  })

  it.each([
    ['title', { title: 'renamed' }],
    ['name', { name: 'curated' }],
    ['status', { status: 'exited' }],
    ['phase', { agentState: { phase: 'idle', since: AT, nativeSubagentCount: 0 } }],
    [
      'since',
      { agentState: { phase: 'working', since: '2026-09-17T12:00:00Z', nativeSubagentCount: 0 } },
    ],
    [
      'workingMsTotal',
      { agentState: { phase: 'working', since: AT, nativeSubagentCount: 0, workingMsTotal: 100 } },
    ],
    ['subagents', { agentState: { phase: 'working', since: AT, nativeSubagentCount: 2 } }],
    ['lastActiveAt', { lastActiveAt: '2026-09-17T12:00:00Z' }],
    ['draftUpdatedAt', { draftUpdatedAt: AT }],
    ['createdAt', { createdAt: '2026-09-17T12:00:00Z' }],
    ['snooze', { snoozedUntil: null }],
    ['readAt', { readAt: null }],
    ['unread', { unread: true }],
    ['archived', { archived: true }],
    ['headless', { headless: true }],
    ['agentKind', { agentKind: 'shell' }],
    ['cwd', { cwd: '/other' }],
    ['issueId', { issueId: asIssueId('other') }],
    ['stoppedAt', { stoppedAt: AT }],
    ['stopReason', { stopReason: 'oom' }],
    ['busy', { busy: true }],
    ['offer', { offer: { message: 'Choose', actions: [], createdAt: AT } }],
    ['displayRef', { displayRef: 'POD-1-A' }],
    ['agentColor', { agentColor: 'red' }],
    ['handoffTarget', { handoffTarget: 'other' }],
  ] satisfies [string, Partial<SessionMeta>][])('keeps %s material', (_name, patch) => {
    const before = session()
    expect(worklistSessionsEqual([before], [{ ...before, ...patch }])).toBe(false)
  })

  it('ignores only audited transport/reporting fields and preserves unknown fields', () => {
    const before = session()
    expect(
      worklistSessionsEqual(
        [before],
        [
          {
            ...before,
            controllerId: 'viewer',
            epoch: 4,
            clientCount: 3,
            requestsGated: 8,
            requestsDuplicate: 9,
            requestsUnanswered: 10,
            geometry: { cols: 120, rows: 50 },
            agentState: {
              ...before.agentState!,
              stateSource: 'poll',
              stateObservedAt: AT,
              stateConfidence: 0.8,
            },
          },
        ],
      ),
    ).toBe(true)
    expect(
      worklistSessionSignature({ ...before, futureVisibleField: 'new' } as SessionMeta),
    ).not.toBe(worklistSessionSignature(before))
  })

  it('compares ordered membership for every collection and retains no evicted rows', () => {
    const store = world()
    expect(worklistSessionsEqual(store.sessions, [...store.sessions].reverse())).toBe(false)
    expect(worklistSessionsEqual(store.sessions, store.sessions.slice(1))).toBe(false)
    expect(worklistIssuesEqual(store.issues, [...store.issues].reverse())).toBe(false)
    expect(worklistIssuesEqual(store.issues, store.issues.slice(1))).toBe(false)
    expect(worklistMachinesEqual(store.machines, [...store.machines].reverse())).toBe(false)
    expect(worklistMachinesEqual(store.machines, store.machines.slice(1))).toBe(false)
    expect(worklistMachinesEqual(store.machines, [])).toBe(false)
    expect(worklistReposEqual(store.repos, [])).toBe(false)
    expect(
      worklistReposEqual(
        store.repos,
        store.repos.map((r) => ({ ...r, branch: 'other' })),
      ),
    ).toBe(false)
    expect(
      worklistReposEqual(
        store.repos,
        store.repos.map((r) => ({ ...r, machineId: asMachineId('m2') })),
      ),
    ).toBe(false)
    expect(
      worklistReposEqual(
        store.repos,
        store.repos.map((r) => ({ ...r, worktrees: [{ path: '/new' }] })),
      ),
    ).toBe(false)
    expect(
      worklistReposEqual(
        store.repos,
        store.repos.map((r) => ({ ...r, futureDiagnostic: 1 })),
      ),
    ).toBe(true)
    expect(
      worklistIssuesEqual(
        store.issues,
        store.issues.map((i) => ({ ...i })),
      ),
    ).toBe(true)
    expect(
      worklistIssuesEqual(
        store.issues,
        store.issues.map((i) => ({ ...i, title: 'new' })),
      ),
    ).toBe(false)
    expect(worklistPinsEqual(store.pins, { ...store.pins, panels: [asSessionId('s1')] })).toBe(true)
    expect(worklistPinsEqual(store.pins, { ...store.pins, repos: ['/repo'] })).toBe(false)
    expect(
      worklistPinsEqual(
        { ...store.pins, worktrees: ['a', 'b'] },
        { ...store.pins, worktrees: ['b', 'a'] },
      ),
    ).toBe(false)
  })
})
