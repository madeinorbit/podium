import {
  beginSwitch,
  markSwitch,
  resetSwitchTraces,
  setSwitchTraceReporter,
} from '@podium/client-core/perf'
import { createReplica, memoryStorage } from '@podium/client-core/replica'
import { indexSessionOwnership, sidebarSections } from '@podium/client-core/viewmodels'
import {
  type ClientSwitchTrace,
  type GitRepositoryWire,
  ISSUE_STAGES,
  type IssueWire,
  type SessionMeta,
} from '@podium/protocol'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssuesView } from '@/features/issues/IssuesView'
import { ISSUE_RENDER_CHUNK } from '@/features/issues/progressive-render'

/** Generated/anonymized Ludovico cardinalities captured in POD-981/POD-991. */
const SCALE = {
  issues: 674,
  sessions: 530,
  repositories: 12,
  worktreesPerRepository: 8,
} as const

const BUDGET = {
  tasksInitialElements: 4_000,
  tasksInitialButtons: 225,
  tasksInitialIssueReads: 55_000,
  sidebarCwdReads: SCALE.sessions * 2,
  sidebarIssueReads: SCALE.issues * 30,
  replicaIncomingReads: SCALE.issues * 100,
  syntheticWarmSwitchMs: 100,
} as const

type Counter = { gets: number; ownKeys: number }

const bench = vi.hoisted(() => ({ store: {} as Record<string, unknown> }))

vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (store: Record<string, unknown>) => unknown) =>
    selector(bench.store),
}))

vi.mock('@/lib/hooks/use-is-mobile', () => ({ useIsMobile: () => false }))

function counted<T extends object>(value: T, counter: Counter): T {
  return new Proxy(value, {
    get(target, key, receiver) {
      counter.gets++
      return Reflect.get(target, key, receiver)
    },
    ownKeys(target) {
      counter.ownKeys++
      return Reflect.ownKeys(target)
    },
  })
}

function worktreePath(index: number): string {
  const repo = Math.floor(index / SCALE.worktreesPerRepository)
  const slot = index % SCALE.worktreesPerRepository
  return slot === 0 ? `/srv/repos/repo-${repo}` : `/srv/worktrees/wt-${index}`
}

function issueAt(index: number): IssueWire {
  const stage = ISSUE_STAGES[index % ISSUE_STAGES.length] ?? 'backlog'
  const worktree = index % (SCALE.repositories * SCALE.worktreesPerRepository)
  return {
    id: `issue-${String(index).padStart(4, '0')}`,
    displayRef: `POD-${10_000 + index}`,
    repoPath: `/srv/repos/repo-${Math.floor(worktree / SCALE.worktreesPerRepository)}`,
    seq: 10_000 + index,
    title: `Generated benchmark task ${index}`,
    description: `Anonymized deterministic task ${index % 17}`,
    stage,
    worktreePath: worktreePath(worktree),
    branch: `issue/${10_000 + index}-generated`,
    parentBranch: 'main',
    defaultAgent: index % 2 === 0 ? 'codex' : 'claude-code',
    blockedBy: [],
    createdAt: `2026-07-${String((index % 17) + 1).padStart(2, '0')}T08:00:00.000Z`,
    updatedAt: `2026-07-${String((index % 17) + 1).padStart(2, '0')}T12:00:00.000Z`,
    archived: false,
    needsHuman: index % 19 === 0,
    sessions: [],
    sessionSummary: { total: index < SCALE.sessions ? 1 : 0, byPhase: {} },
    origin: index % 7 === 0 ? 'agent' : 'human',
    audience: 'human',
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    priority: index % 5,
    type: index % 23 === 0 ? 'bug' : 'task',
    pinned: false,
    labels: [`area-${index % 8}`, `lane-${index % 3}`],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
  } as unknown as IssueWire
}

function sessionAt(index: number): SessionMeta {
  const worktree = index % (SCALE.repositories * SCALE.worktreesPerRepository)
  return {
    sessionId: `session-${String(index).padStart(4, '0')}`,
    agentKind: index % 2 === 0 ? 'codex' : 'claude-code',
    cwd: `${worktreePath(worktree)}/apps/web`,
    title: `Generated session ${index}`,
    status: 'live',
    controllerId: `controller-${index % 12}`,
    geometry: { cols: 120, rows: 36 },
    epoch: 1,
    clientCount: 1,
    createdAt: '2026-07-18T08:00:00.000Z',
    lastActiveAt: `2026-07-18T${String(8 + (index % 10)).padStart(2, '0')}:00:00.000Z`,
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: index % 11 === 0,
    issueId: index % 3 === 0 ? `issue-${String(index).padStart(4, '0')}` : undefined,
    agentState: { phase: 'working', since: '2026-07-18T08:00:00.000Z' },
  } as unknown as SessionMeta
}

function repositories(): GitRepositoryWire[] {
  return Array.from({ length: SCALE.repositories }, (_, repoIndex) => ({
    path: `/srv/repos/repo-${repoIndex}`,
    branch: 'main',
    originUrl: `github.com/anonymized/repo-${repoIndex}`,
    machineId: `machine-${repoIndex % 3}`,
    worktrees: Array.from({ length: SCALE.worktreesPerRepository - 1 }, (_, child) => {
      const worktree = repoIndex * SCALE.worktreesPerRepository + child + 1
      return { path: `/srv/worktrees/wt-${worktree}`, branch: `issue/${worktree}-generated` }
    }),
  })) as unknown as GitRepositoryWire[]
}

function metric(name: string, values: Record<string, number>): void {
  console.info(`[large-state] ${JSON.stringify({ name, ...values })}`)
}

afterEach(() => {
  cleanup()
  setSwitchTraceReporter(null)
  resetSwitchTraces()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Ludovico-scale frontend budgets [spec:SP-0b2e] [spec:SP-e2c8] [spec:SP-d562]', () => {
  it('bounds initial Tasks DOM and preserves progressive reveal plus full-order navigation', () => {
    const issueReads: Counter = { gets: 0, ownKeys: 0 }
    const issues = Array.from({ length: SCALE.issues }, (_, index) =>
      counted(issueAt(index), issueReads),
    )
    const setOpenIssueId = vi.fn()
    bench.store = {
      issues,
      openIssueId: null,
      setOpenIssueId,
      uiState: { get: () => null, set: vi.fn() },
      trpc: {
        issues: {
          update: { mutate: vi.fn(async () => ({})) },
          setLabels: { mutate: vi.fn(async () => ({})) },
          delete: { mutate: vi.fn(async () => ({})) },
        },
      },
    }

    const started = performance.now()
    const originalConsoleError = console.error
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (!String(args[0]).startsWith('Base UI: A component that acts as a button')) {
        originalConsoleError(...args)
      }
    })
    const { container } = render(<IssuesView />)
    const renderMs = performance.now() - started
    const initialElements = container.querySelectorAll('*').length
    const initialButtons = container.querySelectorAll('button').length
    const initialCards = container.querySelectorAll('[data-issue-id]').length
    const initialIssueReads = issueReads.gets
    const boundedInitialCards = ISSUE_STAGES.length * ISSUE_RENDER_CHUNK

    expect(ISSUE_RENDER_CHUNK).toBe(40)
    expect(initialCards).toBe(boundedInitialCards)
    expect(initialCards).toBeLessThan(SCALE.issues)
    expect(initialElements).toBeLessThanOrEqual(BUDGET.tasksInitialElements)
    expect(initialButtons).toBeLessThanOrEqual(BUDGET.tasksInitialButtons)
    expect(initialIssueReads).toBeLessThanOrEqual(BUDGET.tasksInitialIssueReads)

    const reveal = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith(`Show ${ISSUE_RENDER_CHUNK} more tasks`),
    )
    expect(reveal).toBeDefined()
    fireEvent.click(reveal as HTMLButtonElement)
    const revealedCards = container.querySelectorAll('[data-issue-id]').length
    expect(revealedCards).toBe(initialCards + ISSUE_RENDER_CHUNK)

    // Shift-click the newly revealed 41st card, then cross to the 41st card in
    // the next stage. Full-order navigation must mount that hidden target.
    const selected = container.querySelectorAll<HTMLElement>('[data-issue-id]')[
      ISSUE_RENDER_CHUNK
    ] as HTMLElement
    expect(selected).toBeDefined()
    fireEvent.click(selected, { shiftKey: true })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    const keyboardCards = container.querySelectorAll('[data-issue-id]').length
    expect(keyboardCards).toBe(revealedCards + 1)
    const focused = container.querySelector<HTMLElement>('[data-issue-id].ring-2')
    expect(focused).not.toBeNull()
    const focusedId = focused?.dataset.issueId
    expect(focusedId).toBeDefined()
    expect(focusedId).not.toBe(selected.dataset.issueId)
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(setOpenIssueId).toHaveBeenCalledOnce()
    expect(setOpenIssueId).toHaveBeenCalledWith(focusedId)

    metric('tasks', {
      issues: SCALE.issues,
      initialElements,
      initialButtons,
      initialCards,
      revealedCards,
      keyboardCards,
      initialIssuePropertyReads: initialIssueReads,
      renderMs: Math.round(renderMs * 10) / 10,
    })
  })

  it('derives sidebar ownership with one cwd resolution per session', () => {
    const cwdReads = { value: 0 }
    const issueReads: Counter = { gets: 0, ownKeys: 0 }
    const issues = Array.from({ length: SCALE.issues }, (_, index) =>
      counted(issueAt(index), issueReads),
    )
    const sessions = Array.from({ length: SCALE.sessions }, (_, index) => {
      const session = sessionAt(index)
      return new Proxy(session, {
        get(target, key, receiver) {
          if (key === 'cwd') cwdReads.value++
          return Reflect.get(target, key, receiver)
        },
      })
    })
    const repos = repositories()
    const worktreePaths = repos.flatMap((repo) => [
      repo.path,
      ...repo.worktrees.map((worktree) => worktree.path),
    ])

    const started = performance.now()
    const ownership = indexSessionOwnership(sessions, issues, worktreePaths)
    const sections = sidebarSections(
      repos,
      sessions,
      { panels: [], worktrees: [], repos: [] },
      Date.parse('2026-07-18T18:00:00.000Z'),
      issues,
    )
    const deriveMs = performance.now() - started
    const derivedWorktrees = sections.repos.reduce((sum, repo) => sum + repo.worktrees.length, 0)

    expect(ownership.sessionById.size).toBe(SCALE.sessions)
    expect(derivedWorktrees).toBe(SCALE.repositories * SCALE.worktreesPerRepository)
    expect(cwdReads.value).toBeLessThanOrEqual(BUDGET.sidebarCwdReads)
    expect(issueReads.gets).toBeLessThanOrEqual(BUDGET.sidebarIssueReads)

    metric('sidebar', {
      issues: SCALE.issues,
      sessions: SCALE.sessions,
      worktrees: derivedWorktrees,
      cwdReads: cwdReads.value,
      issuePropertyReads: issueReads.gets,
      deriveMs: Math.round(deriveMs * 10) / 10,
    })
  })

  it('keeps an unchanged replica snapshot write-free and coalesces one changed row', async () => {
    const writes = { value: 0 }
    const storage = memoryStorage()
    const replica = createReplica({
      storage: {
        getItem: storage.getItem,
        removeItem: storage.removeItem,
        setItem(key, value) {
          writes.value++
          storage.setItem(key, value)
        },
      },
      keyPrefix: 'large-state-benchmark',
    })
    const initial = Array.from({ length: SCALE.issues }, (_, index) => issueAt(index))
    replica.applySnapshot('issues', initial)
    await replica.flush()

    const incomingReads: Counter = { gets: 0, ownKeys: 0 }
    const freshButEqual = initial.map((row) =>
      counted(
        { ...row, labels: [...row.labels], sessionSummary: { ...row.sessionSummary } },
        incomingReads,
      ),
    )
    const notify = vi.fn()
    replica.subscribeRows('issues', notify)
    writes.value = 0

    const started = performance.now()
    replica.applySnapshot('issues', freshButEqual)
    await replica.flush()
    const unchangedMs = performance.now() - started
    const unchangedReads = incomingReads.gets + incomingReads.ownKeys
    const unchangedWrites = writes.value

    expect(notify).not.toHaveBeenCalled()
    expect(unchangedWrites).toBe(0)
    expect(unchangedReads).toBeLessThanOrEqual(BUDGET.replicaIncomingReads)

    const changed = freshButEqual.map((row, index) =>
      index === 337 ? ({ ...row, title: 'One deterministic changed title' } as IssueWire) : row,
    )
    replica.applySnapshot('issues', changed)
    await replica.flush()
    expect(notify).toHaveBeenCalledOnce()
    expect(replica.rows('issues').find((row) => row.id === 'issue-0337')?.title).toBe(
      'One deterministic changed title',
    )
    const changedWrites = writes.value - unchangedWrites

    metric('replica', {
      issues: SCALE.issues,
      unchangedWrites,
      unchangedNotifications: 0,
      unchangedIncomingReads: unchangedReads,
      changedWrites,
      unchangedMs: Math.round(unchangedMs * 10) / 10,
    })
  })

  it('records a deterministic warm issue-switch interaction trace', () => {
    vi.useFakeTimers()
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const traces: ClientSwitchTrace[] = []
    setSwitchTraceReporter((trace) => traces.push(trace))

    beginSwitch({ sessionId: 'session-0001', issueId: 'issue-0001' })
    now = 12
    markSwitch('session-0001', 'viewstate:sent')
    now = 28
    markSwitch('session-0001', 'transcript:read-start')
    now = 45
    markSwitch('session-0001', 'transcript:read-end', { items: 200 })
    now = 64
    markSwitch('session-0001', 'chat:first-paint', { paintedRows: 40 })

    expect(traces).toHaveLength(1)
    expect(traces[0]?.cold).toBe(false)
    expect(traces[0]?.timedOut).toBe(false)
    expect(traces[0]?.totalMs).toBeLessThanOrEqual(BUDGET.syntheticWarmSwitchMs)
    expect(traces[0]?.marks.map((mark) => mark.name)).toEqual([
      'viewstate:sent',
      'transcript:read-start',
      'transcript:read-end',
      'chat:first-paint',
    ])

    metric('switch-trace', {
      totalMs: traces[0]?.totalMs ?? -1,
      marks: traces[0]?.marks.length ?? 0,
      timedOut: traces[0]?.timedOut ? 1 : 0,
    })
  })
})
